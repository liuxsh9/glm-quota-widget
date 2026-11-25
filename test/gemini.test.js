'use strict';
/**
 * Google Gemini（Antigravity 套餐）测试：lib/gemini.js（SSH 校验 / 命令拼装 / JSON 解析 / 归一化 /
 * 错误分类）+ provider 实现（fetch / validate / tier / 提醒去重）。
 * 全部用注入的 execImpl，不执行真实 agy / ssh，不连网。
 *
 * 响应样本照 2026-11-25 实测 `agy -p /usage --output-format json` 的真实形状（字段名与层级原样，数值改过）。
 */
const G = require('../lib/gemini');
const providers = require('../lib/providers');

let pass = 0, fails = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fails++; console.log('  ✗', name, extra === undefined ? '' : `  [${extra}]`); process.exitCode = 1; }
}
const j = (o) => JSON.stringify(o);

const NOW = Date.UTC(2026, 10, 25, 9, 0, 0);
const H = 3600e3;
const DAY = 86400e3;

const iso = (ms) => new Date(ms).toISOString();

/** 实测形状的 `agy -p /usage --output-format json` 响应 */
const usageBody = (over) => ({
  conversation_id: '',
  status: 'SUCCESS',
  response: 'Gemini Models\tWeekly Limit Remaining\t79%\t...',
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      description: 'Within each group, models share a weekly limit and a 5-hour limit.',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 3.8 Flash',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.7850794792175293,
              reset_time: iso(NOW + 6 * DAY + 17 * H),
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0.5046005249023438,
              reset_time: iso(NOW + 3.5 * H),
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
          buckets: [
            {
              id: '3p-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 1,
              reset_time: '1970-01-01T00:00:00Z',
            },
            {
              id: '3p-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 1,
              reset_time: '1970-01-01T00:00:00Z',
            },
          ],
        },
      ],
    },
  },
  ...over,
});

const okExec = (body = usageBody()) => async () => ({
  code: 0,
  stdout: typeof body === 'string' ? body : JSON.stringify(body),
  stderr: '',
  err: null,
});

(async () => {
  /* ---------------- SSH 目标解析与安全校验 ---------------- */
  console.log('SSH 参数校验与命令拼装:');
  const p1 = G.parseSshTarget('my-server');
  t('别名直接通过', p1.ok && p1.host === 'my-server' && j(p1.args) === j(['my-server']));
  const p2 = G.parseSshTarget('ssh -p 2222 -i ~/.ssh/id_ed25519 user@10.0.0.5');
  t('剥掉开头的 ssh，保留合法参数与顺序',
    p2.ok && p2.host === 'user@10.0.0.5' && j(p2.args) === j(['-p', '2222', '-i', '~/.ssh/id_ed25519', 'user@10.0.0.5']), j(p2));
  const p3 = G.parseSshTarget('user@host -p 2200 -4');
  t('参数写在主机名后面也认', p3.ok && p3.host === 'user@host' && p3.args.includes('-4') && p3.args.includes('2200'), j(p3));
  t('空串被拒', !G.parseSshTarget('').ok && !G.parseSshTarget('   ').ok);
  t('shell 元字符全部拒绝（防注入）', [';', '|', '&', '`', '$', '(', ')', '\n', '"', "'"].every((ch) => !G.parseSshTarget(`host${ch}id`).ok));
  t('禁止 -o 参数（防 ProxyCommand 注入）', !G.parseSshTarget('-o ProxyCommand=calc user@host').ok);
  t('禁止多余位置参数（防止把远程命令写进目标）', !G.parseSshTarget('user@host rm -rf').ok);
  t('非法端口被拒', !G.parseSshTarget('user@host -p abc').ok && !G.parseSshTarget('user@host -p 70000').ok && !G.parseSshTarget('user@host -p 0').ok);
  t('缺少参数取值被拒', !G.parseSshTarget('user@host -p').ok && !G.parseSshTarget('-i -p 22 host').ok);

  t('agyPath：空串合法、正常路径合法、含元字符被拒',
    G.validateAgyPath('').ok && G.validateAgyPath('~/.local/bin/agy').ok
    && G.validateAgyPath('C:\\Tools\\agy.exe').ok && !G.validateAgyPath('agy;id').ok);

  const cLocal = G.buildCommand({ source: 'local' }, 'win32');
  t('本机命令：agy -p /usage --output-format json（Windows 带 cmd 兜底标志）',
    cLocal.bin === 'agy' && j(cLocal.args) === j(['-p', '/usage', '--output-format', 'json']) && cLocal.fallbackWinCmd === true);
  const cLocalCustom = G.buildCommand({ source: 'local', agyPath: '/opt/bin/agy' }, 'win32');
  t('本机自定义路径不走 cmd 兜底', cLocalCustom.bin === '/opt/bin/agy' && cLocalCustom.fallbackWinCmd === false);
  const cSsh = G.buildCommand({ source: 'ssh', sshTarget: 'devbox -p 2222' }, 'win32');
  t('SSH 命令：带 BatchMode=yes / ConnectTimeout=10 + 交互登录 shell 加载代理与 PATH 再跑 agy',
    cSsh.bin === 'ssh' && cSsh.args[0] === '-o' && cSsh.args[1] === 'BatchMode=yes'
    && cSsh.args.includes('devbox')
    && cSsh.args[cSsh.args.length - 1].includes('bash -lic')
    && cSsh.args[cSsh.args.length - 1].includes('agy -p /usage --output-format json'), j(cSsh));
  const cSshTilde = G.buildCommand({ source: 'ssh', sshTarget: 'devbox', agyPath: '~/bin/agy' });
  t('SSH 自定义 ~/ 路径按 $HOME 展开', cSshTilde.args[cSshTilde.args.length - 1].includes('"$HOME/bin/agy" -p /usage --output-format json'), j(cSshTilde.args));

  /* ---------------- JSON 提取与归一化 ---------------- */
  console.log('\n解析与归一化:');
  t('容忍 SSH 登录横幅夹在 JSON 前面',
    !!G.parseJsonOutput('Welcome to Ubuntu 24.04\nLast login: ...\n' + JSON.stringify(usageBody())));
  t('纯非 JSON 返回 null', G.parseJsonOutput('not json at all') === null);

  t('slotOf 识别 5h / weekly / monthly',
    G.slotOf({ window: '5h' }) === 'five'
    && G.slotOf({ window: 'weekly' }) === 'week'
    && G.slotOf({ id: 'gemini-monthly' }) === 'month'
    && G.slotOf({ name: 'Five Hour Limit Remaining' }) === 'five'
    && G.slotOf({}) === null);

  const n1 = G.normalize(usageBody(), NOW, 'gemini');
  t('默认盯 Gemini 组：remaining_fraction 转成已用百分比（5h=50%, week=21%）',
    n1.group === 'gemini' && n1.level === null && n1.five.known && n1.five.percent === 50
    && n1.week.known && n1.week.percent === 21 && !n1.month.known, j(n1));
  t('重置时间正常换算，windowStart = reset − 窗口长度',
    n1.five.nextResetTime === NOW + 3.5 * H && n1.five.windowStart === NOW + 3.5 * H - 5 * H
    && n1.week.nextResetTime === NOW + 6 * DAY + 17 * H && n1.week.windowStart === NOW + 6 * DAY + 17 * H - 7 * DAY);
  t('未知窗口 percent 恒为数值 0（null 进 CSS 变量会画成满格）', n1.month.percent === 0 && n1.month.known === false);
  t('另一组（Claude and GPT models）收进 extras，简名 Claude/GPT，epoch 0 重置时间门控为 null',
    n1.extras.length === 1 && n1.extras[0].shortName === 'Claude/GPT'
    && n1.extras[0].five.known && n1.extras[0].five.percent === 0 && n1.extras[0].five.nextResetTime === null
    && n1.extras[0].week.known && n1.extras[0].week.percent === 0 && n1.extras[0].week.nextResetTime === null, j(n1.extras));

  const n3p = G.normalize(usageBody(), NOW, '3p');
  t('切到 3p 组：主窗口是 Claude & GPT（level=3p），Gemini 进 extras',
    n3p.group === '3p' && n3p.level === '3p' && n3p.five.percent === 0 && n3p.week.percent === 0
    && n3p.extras.length === 1 && n3p.extras[0].shortName === 'Gemini' && n3p.extras[0].five.percent === 50, j(n3p));

  // proto3 省略 0：有未来 reset_time 但没有 remaining_fraction → 剩余 0 → 已用 100% + reached
  const exhausted = G.normalize({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [{
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-5h', window: '5h', reset_time: iso(NOW + 2 * H) },
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.4, reset_time: iso(NOW + 4 * DAY) },
          ],
        }],
      },
    },
  }, NOW, 'gemini');
  t('proto3 省略 remaining_fraction=0（带未来重置时间）→ 100% 且 reached=true',
    exhausted.five.known && exhausted.five.percent === 100 && exhausted.reached === true && exhausted.week.percent === 60, j(exhausted));

  // 早已过去的重置时间门控为 null
  const stale = G.normalize({
    status: 'SUCCESS',
    groups: [{
      displayName: 'Gemini Models',
      buckets: [{ bucketId: 'gemini-5h', remainingFraction: 0.8, resetTime: iso(NOW - DAY) }],
    }],
  }, NOW, 'gemini');
  t('兼容 camelCase 字段与顶层 groups；过期 resetTime 门控为 null',
    stale.five.known && stale.five.percent === 20 && stale.five.nextResetTime === null, j(stale));

  /* ---------------- fetchUsage 执行与错误分类 ---------------- */
  console.log('\nfetchUsage 执行与错误分类:');
  let seen = null;
  const r1 = await G.fetchUsage({ source: 'local', group: 'gemini' }, async (bin, args) => {
    seen = { bin, args };
    return { code: 0, stdout: JSON.stringify(usageBody()), stderr: '', err: null };
  }, NOW, 'linux');
  t('本机成功：执行 agy 并返回归一化数据',
    r1.ok && seen.bin === 'agy' && r1.data.source === 'local' && r1.data.five.percent === 50 && r1.data.week.percent === 21);

  // Windows agy.cmd 兜底
  const winCalls = [];
  const rWin = await G.fetchUsage({ source: 'local' }, async (bin, args) => {
    winCalls.push([bin, args]);
    if (bin === 'agy') return { code: null, stdout: '', stderr: '', err: Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }) };
    return { code: 0, stdout: JSON.stringify(usageBody()), stderr: '', err: null };
  }, NOW, 'win32');
  t('Windows 上 agy ENOENT 自动尝试 cmd.exe /d /c agy（兼容 .cmd 包装）',
    rWin.ok && winCalls.length === 2 && winCalls[1][0] === 'cmd.exe' && winCalls[1][1].includes('agy'), j(winCalls));

  const rEnoent = await G.fetchUsage({ source: 'local' }, async () => ({
    code: null, stdout: '', stderr: '', err: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
  }), NOW, 'linux');
  t('本机未装 agy → error 并提示安装或填路径', !rEnoent.ok && rEnoent.kind === 'error' && /自定义 agy 路径/.test(rEnoent.msg));

  const rSshPerm = await G.fetchUsage({ source: 'ssh', sshTarget: 'devbox' }, async () => ({
    code: 255, stdout: '', stderr: 'Permission denied (publickey).', err: new Error('exit 255'),
  }), NOW);
  t('SSH 免密失败 → expired 并提示主机名', !rSshPerm.ok && rSshPerm.kind === 'expired' && /devbox/.test(rSshPerm.msg), j(rSshPerm));

  const rSshNet = await G.fetchUsage({ source: 'ssh', sshTarget: 'devbox' }, async () => ({
    code: 255, stdout: '', stderr: 'ssh: Could not resolve hostname devbox: Name or service not known', err: new Error('exit 255'),
  }), NOW);
  t('SSH 网络不可达 → network', !rSshNet.ok && rSshNet.kind === 'network', j(rSshNet));

  const rSshNoAgy = await G.fetchUsage({ source: 'ssh', sshTarget: 'devbox' }, async () => ({
    code: 127, stdout: '', stderr: 'bash: line 1: agy: command not found', err: new Error('exit 127'),
  }), NOW);
  t('远程缺 agy → error 并提示填自定义路径', !rSshNoAgy.ok && rSshNoAgy.kind === 'error' && /自定义 agy 路径/.test(rSshNoAgy.msg), j(rSshNoAgy));

  const rTimeout = await G.fetchUsage({ source: 'ssh', sshTarget: 'devbox' }, async () => ({
    code: null, stdout: '', stderr: '', err: Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }),
  }), NOW);
  t('执行超时 → network', !rTimeout.ok && rTimeout.kind === 'network' && /超时/.test(rTimeout.msg));

  const rAuth = await G.fetchUsage({ source: 'local' }, async () => ({
    code: 1, stdout: JSON.stringify({ status: 'ERROR', error: 'User is not logged in' }), stderr: '', err: new Error('exit 1'),
  }), NOW);
  t('agy 返回未登录 JSON → expired', !rAuth.ok && rAuth.kind === 'expired', j(rAuth));

  const r429 = await G.fetchUsage({ source: 'local' }, async () => ({
    code: 1, stdout: '', stderr: '429 RESOURCE_EXHAUSTED', err: new Error('exit 1'),
  }), NOW);
  t('429 限流 → ratelimit', !r429.ok && r429.kind === 'ratelimit');

  const rBadJson = await G.fetchUsage({ source: 'local' }, okExec('<html>oops</html>'), NOW);
  t('非 JSON 输出 → parse 带原文片段', !rBadJson.ok && rBadJson.kind === 'parse' && /oops/.test(rBadJson.msg));

  const rEmptyGroups = await G.fetchUsage({ source: 'local' }, okExec({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [] } } }), NOW);
  t('groups 为空 → parse', !rEmptyGroups.ok && rEmptyGroups.kind === 'parse');

  /* ---------------- provider 实现 ---------------- */
  console.log('\nprovider 实现:');
  const gemini = providers.byId('gemini');
  t('已注册，走档位色、不分峰谷', !!gemini && gemini.accentMode === 'tier' && gemini.peak === null);
  t('连接方式与模型组均为下拉，SSH 目标与自定义路径选配',
    gemini.credentials[0].kind === 'select' && gemini.credentials[1].required === false
    && gemini.credentials[2].kind === 'select' && gemini.credentials[3].required === false);
  t('validate：本机可全空；SSH 必须填合法主机；拒绝注入字符',
    gemini.validate({ source: 'local' }) === ''
    && !!gemini.validate({ source: 'ssh', sshTarget: '' })
    && gemini.validate({ source: 'ssh', sshTarget: 'user@10.0.0.5 -p 2222' }) === ''
    && !!gemini.validate({ source: 'ssh', sshTarget: 'host; rm -rf /' })
    && !!gemini.validate({ source: 'local', agyPath: 'agy && whoami' }));

  const ctx = (over) => ({
    execImpl: okExec(), accountName: '', config: { warnThreshold: 80, notifyReset: true },
    prev: null, prevKind: 'boot', alertState: {}, mem: { notified: {} }, now: NOW, platform: 'linux', ...over,
  });

  const g1 = await gemini.fetch({ source: 'local', group: 'gemini' }, ctx());
  t('provider.fetch 本机成功', g1.ok && g1.data.five.percent === 50 && g1.data.week.percent === 21);
  t('SSH 模式缺主机 → empty', (await gemini.fetch({ source: 'ssh', sshTarget: '' }, ctx())).kind === 'empty');

  // 失效通知去重 + 恢复通知
  const mem = { notified: {} };
  const authFailExec = async () => ({ code: 1, stdout: '', stderr: 'Unauthenticated: please login', err: new Error('exit 1') });
  const e1 = await gemini.fetch({ source: 'local' }, ctx({ mem, execImpl: authFailExec }));
  t('失效：expired + 弹一次通知 + 提示运行 agy 登录', e1.kind === 'expired' && e1.notes.length === 1 && /运行一次 agy/.test(e1.msg), j(e1));
  const e2 = await gemini.fetch({ source: 'local' }, ctx({ mem, execImpl: authFailExec }));
  t('连续失效不重复弹窗（mem 去重）', e2.notes.length === 0);
  const back = await gemini.fetch({ source: 'local' }, ctx({ mem, prevKind: 'expired' }));
  t('恢复：发恢复通知并复位去重标志', back.notes.some((n) => /已恢复/.test(n.title)) && mem.notified.expired === false);

  // 阈值跨线提醒（85% >= 80%）+ 分桶去重
  const hotBody = usageBody({
    command: {
      name: 'usage',
      data: {
        groups: [{
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-5h', window: '5h', remaining_fraction: 0.15, reset_time: iso(NOW + 2.5 * H) },
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.8, reset_time: iso(NOW + 5 * DAY) },
          ],
        }],
      },
    },
  });
  const alertState = {};
  const h1 = await gemini.fetch({ source: 'local' }, ctx({ alertState, execImpl: okExec(hotBody) }));
  t('5h 跨阈值（85%）触发提醒', h1.notes.some((n) => /5小时额度已用 85%/.test(n.title)), j(h1.notes));
  const h2 = await gemini.fetch({ source: 'local' }, ctx({ alertState, execImpl: okExec(hotBody) }));
  t('同一窗口不重复提醒', h2.notes.length === 0);

  // 翻窗重置提醒
  const rolledBody = usageBody({
    command: {
      name: 'usage',
      data: {
        groups: [{
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-5h', window: '5h', remaining_fraction: 1, reset_time: iso(NOW + 7.5 * H) },
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.8, reset_time: iso(NOW + 5 * DAY) },
          ],
        }],
      },
    },
  });
  const rolled = await gemini.fetch({ source: 'local' }, ctx({ prev: h1.data, prevKind: 'ok', execImpl: okExec(rolledBody) }));
  t('5h 翻窗且此前用量过半 → 弹重置提醒', rolled.notes.some((n) => /5小时额度已重置/.test(n.title)), j(rolled.notes));

  const win = (p) => ({ known: true, percent: p });
  t('tier：已知窗口取最差、撞上限直接 high',
    gemini.tier({ five: win(85), week: win(20), month: { known: false, percent: 0 } }, 80) === 'mid'
    && gemini.tier({ five: win(10), week: win(92), month: { known: false, percent: 0 } }, 80) === 'high'
    && gemini.tier({ five: win(10), week: win(20), reached: true }, 80) === 'high'
    && gemini.tier({ five: win(10), week: win(20) }, 80) === 'low');

  console.log(`\n共 ${pass} 项通过${fails ? `，${fails} 项失败` : ''}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
