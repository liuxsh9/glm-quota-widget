'use strict';
/**
 * OpenAI Codex 测试：lib/codex.js（归一化 / 请求 / 本机 auth.json）+ 凭据提取 + provider 实现。
 * 全部用注入的 fetchImpl / readImpl 与自造的 JWT（不签名，只有 payload 有意义），不发真实请求。
 *
 * 响应样本照 2026-10-10 在一个 Plus 号上实测的形状抄（字段名与层级原样，数值改过）：
 * rate_limit.primary_window 是**周**窗口、secondary_window 为 null —— 年中改版后的样子。
 */
const path = require('path');
const C = require('../lib/codex');
const T = require('../lib/tokens');
const providers = require('../lib/providers');

let pass = 0, fails = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fails++; console.log('  ✗', name, extra === undefined ? '' : `  [${extra}]`); process.exitCode = 1; }
}
const j = (o) => JSON.stringify(o);

const NOW = Date.UTC(2026, 9, 10, 2, 0, 0);
const DAY = 86400e3;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** 自造 JWT：header.payload.sig（sig 随便填，代码不验签） */
const jwt = (payload) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.c2lnbmF0dXJlLXN0dWI`;
const ACCESS = jwt({
  iss: 'https://auth.openai.com', aud: ['https://api.openai.com/v1'], exp: Math.floor((NOW + 10 * DAY) / 1000),
  'https://api.openai.com/auth': { chatgpt_account_id: 'acc-123', chatgpt_plan_type: 'plus' },
});
const ID_TOKEN = jwt({ iss: 'https://auth.openai.com', aud: ['app_EMoamEEZ73f0CkXaXp7hrann'], exp: Math.floor((NOW + DAY) / 1000) });
const AUTH_JSON = JSON.stringify({
  auth_mode: 'chatgpt', OPENAI_API_KEY: null,
  tokens: { id_token: ID_TOKEN, access_token: ACCESS, refresh_token: 'rt.1.xxxx', account_id: 'acc-123' },
  last_refresh: '2026-10-10T01:52:00Z',
}, null, 2);

/** 实测形状的响应 */
const usageBody = (over) => ({
  user_id: 'user-x', account_id: 'acc-123', email: 'a@b.c', plan_type: 'plus',
  rate_limit: {
    allowed: true, limit_reached: false,
    primary_window: { used_percent: 37, limit_window_seconds: 604800, reset_after_seconds: 3 * 86400, reset_at: Math.floor((NOW + 3 * DAY) / 1000) },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  additional_rate_limits: null,
  credits: { has_credits: false, unlimited: false, balance: '0' },
  ...over,
});
const res = (body, status = 200) => ({
  status, ok: status === 200,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

(async () => {
  /* ---------------- 凭据提取 ---------------- */
  console.log('凭据提取:');
  t('整份 auth.json → tokens.access_token', T.extractCodexToken(AUTH_JSON) === ACCESS);
  t('裸 access_token / Bearer 前缀', T.extractCodexToken(ACCESS) === ACCESS && T.extractCodexToken('Bearer ' + ACCESS) === ACCESS);
  t('只复制了 tokens 那一层也认', T.extractCodexToken(JSON.stringify({ access_token: ACCESS })) === ACCESS);
  t('复制不完整的 JSON 片段：逐个扫 JWT 挑出 access_token',
    T.extractCodexToken(AUTH_JSON.slice(0, AUTH_JSON.indexOf('refresh_token'))) === ACCESS);
  t('id_token 不认（拿它调接口会 401）', T.extractCodexToken(ID_TOKEN) === '');
  t('别家的 JWT 不认', T.extractCodexToken(jwt({ iss: 'https://open.bigmodel.cn', aud: 'x' })) === '');
  t('GLM 提取器不再把 Codex 的 auth.json 认成 GLM 令牌', T.extractToken(AUTH_JSON) === '' && T.extractToken(ACCESS) === '');
  const glmJwt = jwt({ api_key: 'k', exp: 1 });
  t('GLM 自己的 JWT 照认', T.extractToken(glmJwt) === glmJwt);

  /* ---------------- 归一化 ---------------- */
  console.log('\n归一化:');
  t('窗口按长度归槽：18000→5h、604800→周、2592000→月',
    C.slotOf(18000) === 'five' && C.slotOf(604800) === 'week' && C.slotOf(2592000) === 'month');
  t('认不准的长度就近归槽（按对数距离：2 天 → 周，不是 5h）', C.slotOf(2 * 86400) === 'week' && C.slotOf(3600) === 'five');
  t('长度缺失 / 非法 → null', C.slotOf(undefined) === null && C.slotOf(0) === null);

  const n1 = C.normalize(usageBody(), NOW);
  t('改版后形状：primary 是周窗口（不是 5h）', n1.week.known && n1.week.percent === 37 && !n1.five.known && !n1.month.known, j(n1));
  t('重置时间：秒 → 毫秒；windowStart = 重置 − 窗口长', n1.week.nextResetTime === NOW + 3 * DAY
    && n1.week.windowStart === NOW + 3 * DAY - 7 * DAY);
  t('未知窗口的 percent 仍是数值 0（null 进 CSS 变量会画满格）', n1.five.percent === 0 && n1.five.known === false);

  const old = C.normalize(usageBody({ rate_limit: {
    allowed: true, limit_reached: false,
    primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: Math.floor((NOW + 3600e3) / 1000) },
    secondary_window: { used_percent: 16, limit_window_seconds: 604800, reset_at: Math.floor((NOW + 5 * DAY) / 1000) },
  } }), NOW);
  t('改版前形状（primary=5h、secondary=周）也照样归位', old.five.percent === 100 && old.week.percent === 16);

  const swapped = C.normalize(usageBody({ rate_limit: {
    primary_window: { used_percent: 16, limit_window_seconds: 604800, reset_at: Math.floor((NOW + 5 * DAY) / 1000) },
    secondary_window: { used_percent: 60, limit_window_seconds: 18000, reset_at: Math.floor((NOW + 3600e3) / 1000) },
  } }), NOW);
  t('不看位置只看长度：primary/secondary 对调也不串', swapped.five.percent === 60 && swapped.week.percent === 16);

  const fallback = C.normalize(usageBody({ rate_limit: {
    primary_window: { used_percent: 5, limit_window_seconds: 604800, reset_after_seconds: 3600 },
  } }), NOW);
  t('没有 reset_at 时用 reset_after_seconds 推', fallback.week.nextResetTime === NOW + 3600e3);
  const stale = C.normalize(usageBody({ rate_limit: {
    primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: Math.floor((NOW - DAY) / 1000) },
  } }), NOW);
  t('早已过去的重置时间当未知（倒计时不钉在「即将重置」）', stale.five.known && stale.five.nextResetTime === null);

  const reached = C.normalize(usageBody({ rate_limit: { ...usageBody().rate_limit, limit_reached: true } }), NOW);
  t('limit_reached 带出来', reached.reached === true && n1.reached === false);

  const extra = C.normalize(usageBody({
    additional_rate_limits: [{ limit_name: 'GPT-5.3-Codex-Spark', rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: Math.floor((NOW + 3600e3) / 1000) },
      secondary_window: { used_percent: 4, limit_window_seconds: 604800, reset_at: Math.floor((NOW + 5 * DAY) / 1000) },
    } }],
    code_review_rate_limit: { primary_window: { used_percent: 9, limit_window_seconds: 604800, reset_at: Math.floor((NOW + 5 * DAY) / 1000) } },
  }), NOW);
  t('按模型单列的额外限额 + 代码审查额度都收进 extras', extra.extras.length === 2
    && extra.extras[0].name === 'GPT-5.3-Codex-Spark' && extra.extras[0].five.percent === 12
    && extra.extras[1].name === '代码审查' && extra.extras[1].week.percent === 9, j(extra.extras));
  t('额外限额不占主额度', extra.week.percent === 37 && !extra.five.known);
  t('rate_limit 整个缺失：不抛错，三个窗口全是未知', (() => {
    const e = C.normalize({ plan_type: 'free' }, NOW);
    return !e.five.known && !e.week.known && !e.month.known;
  })());

  /* ---------------- 请求 ---------------- */
  console.log('\n请求:');
  let seen = null;
  const okFetch = async (url, opts) => { seen = { url, opts }; return res(usageBody()); };
  const r1 = await C.fetchUsage(ACCESS, okFetch, NOW);
  t('成功：数据 + 套餐名（level）+ 令牌过期时间', r1.ok && r1.data.week.percent === 37 && r1.data.level === 'plus'
    && r1.data.tokenExp === NOW + 10 * DAY && !('plan' in r1.data), j(r1));
  t('请求打到 wham/usage，GET', seen.url === 'https://chatgpt.com/backend-api/wham/usage' && seen.opts.method === 'GET');
  t('带 Bearer + 从 JWT 里取出的 ChatGPT-Account-Id', seen.opts.headers.Authorization === 'Bearer ' + ACCESS
    && seen.opts.headers['ChatGPT-Account-Id'] === 'acc-123');
  t('请求带超时信号', !!seen.opts.signal);

  let called = false;
  const expiredTok = jwt({ iss: 'https://auth.openai.com', aud: ['https://api.openai.com/v1'], exp: Math.floor((NOW - 1000) / 1000) });
  const r2 = await C.fetchUsage(expiredTok, async () => { called = true; return res(usageBody()); }, NOW);
  t('JWT 已过期：不发请求，直接 expired', !r2.ok && r2.kind === 'expired' && !called);
  t('401 / 403 → expired', (await C.fetchUsage(ACCESS, async () => res({ detail: 'x' }, 401), NOW)).kind === 'expired'
    && (await C.fetchUsage(ACCESS, async () => res('<html>', 403), NOW)).kind === 'expired');
  t('429 → ratelimit', (await C.fetchUsage(ACCESS, async () => res({}, 429), NOW)).kind === 'ratelimit');
  const r5 = await C.fetchUsage(ACCESS, async () => res('<html>cloudflare</html>', 503), NOW);
  t('非 JSON / 5xx → parse，带一段原文进日志', r5.kind === 'parse' && /HTTP 503/.test(r5.msg) && /cloudflare/.test(r5.msg));
  t('网络错 → network', (await C.fetchUsage(ACCESS, async () => { throw new Error('ECONNRESET'); }, NOW)).kind === 'network');
  t('不是 OpenAI 的 JWT → expired（不发请求）', (await C.fetchUsage('abc', okFetch, NOW)).kind === 'expired');

  /* ---------------- 本机 auth.json ---------------- */
  console.log('\n本机 auth.json:');
  t('路径：CODEX_HOME 优先，否则 ~/.codex', C.localAuthPath({ CODEX_HOME: '/x/y' }, '/home/u') === path.join('/x/y', 'auth.json')
    && C.localAuthPath({}, '/home/u') === path.join('/home/u', '.codex', 'auth.json'));   // CI 跑在 Windows 上，分隔符不写死
  t('读到 → access_token', C.readLocalAuth('/f', () => AUTH_JSON).token === ACCESS);
  t('文件不在 → empty（提示去登录或改用粘贴）', C.readLocalAuth('/f', () => { throw new Error('ENOENT'); }).err.kind === 'empty');
  t('API Key 登录的 auth.json → expired，说清是登录方式不对',
    /API Key/.test(C.readLocalAuth('/f', () => JSON.stringify({ OPENAI_API_KEY: 'sk-x' })).err.msg));

  /* ---------------- provider 实现 ---------------- */
  console.log('\nprovider 实现:');
  const codex = providers.byId('codex');
  t('注册了，走档位色、不分峰谷', !!codex && codex.accentMode === 'tier' && codex.peak === null);
  t('凭据来源是下拉，令牌是选配（读本机时留空）', codex.credentials[0].kind === 'select'
    && codex.credentials[0].options[0].value === 'paste' && codex.credentials[1].required === false);
  t('校验：粘贴来源必须粘了东西；读本机可以空', !!codex.validate({ source: 'paste' })
    && codex.validate({ source: 'paste', accessToken: ACCESS }) === '' && codex.validate({ source: 'local' }) === '');

  const ctx = (over) => ({
    fetchImpl: okFetch, accountName: '', config: { warnThreshold: 80, notifyReset: true },
    prev: null, prevKind: 'boot', alertState: {}, mem: { notified: {} }, now: NOW, ...over,
  });
  const p1 = await codex.fetch({ source: 'paste', accessToken: ACCESS }, ctx());
  t('粘贴来源：成功，带上 source', p1.ok && p1.data.source === 'paste' && p1.data.week.percent === 37);
  t('令牌还剩 10 天：不提醒', !p1.notes.some((n) => /过期/.test(n.title)));
  t('粘贴来源没令牌 → empty', (await codex.fetch({ source: 'paste' }, ctx())).kind === 'empty');

  const p2 = await codex.fetch({ source: 'local' }, ctx({ authPath: '/f', readImpl: () => AUTH_JSON }));
  t('读本机：每次读文件拿令牌', p2.ok && p2.data.source === 'local');
  const p3 = await codex.fetch({ source: 'local' }, ctx({ authPath: '/f', readImpl: () => { throw new Error('ENOENT'); } }));
  t('读本机但文件不在 → empty，msg 里有路径', !p3.ok && p3.kind === 'empty' && /\/f/.test(p3.msg));

  const mem = { notified: {} };
  const e1 = await codex.fetch({ source: 'paste', accessToken: ACCESS }, ctx({ mem, fetchImpl: async () => res({}, 401) }));
  t('失效：expired + 告诉用户去哪台机器续期', e1.kind === 'expired' && /登录了 Codex 的机器/.test(e1.msg));
  t('失效通知只弹一次', e1.notes.length === 1
    && (await codex.fetch({ source: 'paste', accessToken: ACCESS }, ctx({ mem, fetchImpl: async () => res({}, 401) }))).notes.length === 0);
  const e2 = await codex.fetch({ source: 'local' }, ctx({ authPath: '/f', readImpl: () => AUTH_JSON, fetchImpl: async () => res({}, 401) }));
  t('读本机来源失效：出路是「在这台电脑上运行 codex」', /这台电脑/.test(e2.msg));
  const back = await codex.fetch({ source: 'paste', accessToken: ACCESS }, ctx({ mem, prevKind: 'expired' }));
  t('恢复：发恢复通知，并重置失效去重', back.notes.some((n) => /已恢复/.test(n.title)) && mem.notified.expired === false);

  // 快过期提醒：剩 1 天时提醒一次，同一个令牌不重复
  const soon = jwt({ iss: 'https://auth.openai.com', aud: ['https://api.openai.com/v1'], exp: Math.floor((NOW + DAY) / 1000),
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-123' } });
  const alertState = {};
  const s1 = await codex.fetch({ source: 'paste', accessToken: soon }, ctx({ alertState }));
  t('粘贴来的令牌剩不到 2 天：提醒一次', s1.notes.filter((n) => /小时后过期/.test(n.title)).length === 1, j(s1.notes));
  const s2 = await codex.fetch({ source: 'paste', accessToken: soon }, ctx({ alertState }));
  t('同一个令牌不重复提醒', !s2.notes.some((n) => /过期/.test(n.title)));
  const s3 = await codex.fetch({ source: 'local' }, ctx({ authPath: '/f', readImpl: () => JSON.stringify({ tokens: { access_token: soon } }) }));
  t('读本机来源不提醒过期（Codex CLI 自己会续期）', s3.ok && !s3.notes.some((n) => /过期/.test(n.title)));

  // 阈值提醒：周窗口过线
  const hot = await codex.fetch({ source: 'paste', accessToken: ACCESS }, ctx({ fetchImpl: async () => res(usageBody({ rate_limit: {
    primary_window: { used_percent: 85, limit_window_seconds: 604800, reset_at: Math.floor((NOW + 3 * DAY) / 1000) } } })) }));
  t('周额度过阈值 → 提醒', hot.notes.some((n) => /周额度已用 85%/.test(n.title)), j(hot.notes));

  // 重置提醒：只有周窗口时盯周（5h 不存在）
  const prevData = { ...p1.data, week: { ...p1.data.week, percent: 70 } };
  const rolled = await codex.fetch({ source: 'paste', accessToken: ACCESS }, ctx({ prev: prevData, prevKind: 'ok',
    fetchImpl: async () => res(usageBody({ rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: Math.floor((NOW + 10 * DAY) / 1000) } } })) }));
  t('只有周窗口时，重置提醒盯周', rolled.notes.some((n) => /周额度已重置/.test(n.title)), j(rolled.notes));

  const win = (p) => ({ known: true, percent: p });
  t('tier：已知窗口取最差、忽略未知、撞上限直接 high',
    codex.tier({ five: { known: false, percent: 0 }, week: win(85), month: { known: false, percent: 0 } }, 80) === 'mid'
    && codex.tier({ five: { known: false, percent: 0 }, week: win(10), month: { known: false, percent: 0 } }, 80) === 'low'
    && codex.tier({ week: win(10), reached: true }, 80) === 'high');

  console.log(`\n共 ${pass} 项通过${fails ? `，${fails} 项失败` : ''}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
