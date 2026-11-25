'use strict';
/**
 * Google Gemini（Antigravity 套餐：5 小时 / 周配额）的配额查询。
 *
 * 纯 Node（只依赖 child_process），不碰 Electron——对标 lib/codex.js。
 *
 * 数据来源：官方 Antigravity CLI 的只读命令：
 *   agy -p /usage --output-format json
 *   duration_seconds=0、num_turns=0、total_tokens=0——不调模型、不耗额度、走官方登录态。
 *
 * 两种连接来源（select 字段 source）：
 *   local —— 直接调用本机的 agy CLI（Antigravity 登录在这台电脑上）
 *   ssh   —— 通过本机 ssh（Windows 10/11 内置 OpenSSH）免密执行远程机器上的 agy CLI
 *            （Antigravity 登录在远程 Linux / Mac 机器上，挂件跑在本地 PC 上）
 *   为什么用 ssh 而不是粘贴 OAuth token：Antigravity 的凭据存在系统钥匙串里、没有明文
 *   auth.json，且 Google access_token 仅 1 小时有效；走本机 ssh 调远程 agy 免密、永不过期、
 *   不接触原始凭据。
 *
 * 输出归一成 GLM / 火山 / Codex 同款的窗口形状（five/week/month），渲染层的配速、幽灵段、
 * 超支变色原样复用；另一模型组（默认是 Claude & GPT，或切到 3p 时的 Gemini）放进 extras 进脚注。
 */
const { BAD_CHARS_RE, parseSshTarget, buildSshArgs, execCmd, classifySshError } = require('./ssh');

/** 三个槽位的标称长度（秒） */
const SLOT_SECONDS = { five: 5 * 3600, week: 7 * 86400, month: 30 * 86400 };
const SLOTS = ['five', 'week', 'month'];
const CLI_ARGS = ['-p', '/usage', '--output-format', 'json'];
const DEFAULT_TIMEOUT_MS = 30000;

/* ---------------- 参数校验与命令拼装 ---------------- */

/** 校验可选的自定义 agy 路径 */
function validateAgyPath(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: true, path: '' };
  if (BAD_CHARS_RE.test(s)) {
    return { ok: false, msg: '自定义 agy 路径包含不允许的特殊字符' };
  }
  return { ok: true, path: s };
}

/**
 * 拼远程 POSIX shell 命令：通过交互式登录 shell（zsh -lic / bash -lic）加载远程的
 * ~/.profile / ~/.bashrc / ~/.zshrc，拿到用户在终端里配好的代理（http_proxy / https_proxy）
 * 与 PATH，同时 </dev/null 防卡住等待输入。
 * （非交互 ssh 既不读 ~/.bashrc，连 bash -lc 也会被 Ubuntu 默认 .bashrc 顶部的交互判断提前 return。）
 */
function buildRemoteCmd(agyPath) {
  const argsStr = CLI_ARGS.join(' ');
  let inner;
  if (!agyPath) {
    inner = `PATH="$HOME/.local/bin:$HOME/.antigravity/bin:/usr/local/bin:$PATH" agy ${argsStr}`;
  } else {
    const safe = agyPath.replace(/\\/g, '\\\\');
    inner = agyPath.startsWith('~/')
      ? `"$HOME/${safe.slice(2)}" ${argsStr}`
      : `"${safe}" ${argsStr}`;
  }
  return `if [ -n "$ZSH_VERSION" ]; then zsh -lic '${inner}' </dev/null; `
    + `elif command -v bash >/dev/null 2>&1; then bash -lic '${inner}' </dev/null; `
    + `else [ -f "$HOME/.profile" ] && . "$HOME/.profile"; ${inner}; fi`;
}

/** 根据凭据拼出要执行的命令与参数（不走 shell） */
function buildCommand(opts, platform) {
  const source = opts && opts.source === 'ssh' ? 'ssh' : 'local';
  const pCheck = validateAgyPath(opts && opts.agyPath);
  if (!pCheck.ok) return { err: { kind: 'error', msg: pCheck.msg } };
  const agyPath = pCheck.path;

  if (source === 'ssh') {
    const parsed = parseSshTarget(opts && opts.sshTarget);
    if (!parsed.ok) return { err: { kind: opts && opts.sshTarget ? 'error' : 'empty', msg: parsed.msg } };
    return {
      source: 'ssh',
      host: parsed.host,
      bin: 'ssh',
      args: buildSshArgs(parsed, buildRemoteCmd(agyPath)),
      fallbackWinCmd: false,
    };
  }
  return {
    source: 'local',
    host: null,
    bin: agyPath || 'agy',
    args: [...CLI_ARGS],
    fallbackWinCmd: !agyPath && (platform || process.platform) === 'win32',
  };
}

/* ---------------- 响应解析与归一化 ---------------- */

const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

/** 从 stdout 里提取 JSON（容忍 SSH 登录横幅 / 警告文字夹在 JSON 前后） */
function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    const o = JSON.parse(text);
    if (o && typeof o === 'object') return o;
  } catch { /* 下面逐行 / 按大括号扫描 */ }

  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const idx = line.indexOf('{');
    if (idx < 0) continue;
    try {
      const o = JSON.parse(line.slice(idx));
      if (o && typeof o === 'object') return o;
    } catch { /* 继续 */ }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      const o = JSON.parse(text.slice(first, last + 1));
      if (o && typeof o === 'object') return o;
    } catch { /* 放弃 */ }
  }
  return null;
}

/** 按 bucket.window / id / name 归槽到 five / week / month */
function slotOf(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const probe = [bucket.window, bucket.id, bucket.bucketId, bucket.name, bucket.displayName]
    .filter(Boolean).join(' ').toLowerCase();
  if (!probe) return null;
  if (/(?:^|[^a-z0-9])5h(?:[^a-z0-9]|$)|five[_ -]?hour|session/.test(probe)) return 'five';
  if (/week|7d/.test(probe)) return 'week';
  if (/month|30d/.test(probe)) return 'month';
  return null;
}

/** 空窗口（percent 恒为数值 0，避免 null 进 CSS 变量把进度条画成满格） */
function emptyWindow(slot) {
  const ms = SLOT_SECONDS[slot] * 1000;
  return { known: false, percent: 0, used: null, total: null, remaining: null, nextResetTime: null, windowStart: null, windowMs: ms };
}

/** 解析时间戳：ISO 字符串或秒/毫秒数字；1970-01-01（epoch 0，表示尚未启用窗口）→ null */
function parseResetTime(raw) {
  if (raw == null || raw === '') return null;
  let ms;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    ms = raw < 1e12 ? raw * 1000 : raw;
  } else {
    ms = Date.parse(String(raw));
    if (!Number.isFinite(ms) || ms <= 0) return null;
  }
  return ms;
}

/** 单个 bucket → 标准窗口对象（remaining_fraction 是「剩余比例」，转成「已用百分比」） */
function mkWindow(b, slot, now) {
  const ms = SLOT_SECONDS[slot] * 1000;
  let reset = parseResetTime(b.reset_time != null ? b.reset_time : (b.resetTime != null ? b.resetTime : b.resetsAt));
  // 门控：落在 (now − 半个窗口, now + 1.5 个窗口) 之外的重置时间当未知（1970-01-01 已在上面滤掉）
  if (reset != null && (reset < now - ms / 2 || reset > now + ms * 1.5)) reset = null;

  const rawRem = b.remaining_fraction !== undefined ? b.remaining_fraction : b.remainingFraction;
  let known = false;
  let percent = 0;
  if (rawRem != null && Number.isFinite(Number(rawRem))) {
    const frac = Math.max(0, Math.min(1, Number(rawRem)));
    percent = clampPct((1 - frac) * 100);
    known = true;
  } else if (reset != null && reset > now) {
    // proto3 序列化会省掉值为 0 的浮点字段：有未来重置时间但缺 remaining_fraction → 剩余 0（已用 100%）
    percent = 100;
    known = true;
  }

  return {
    known,
    percent,
    used: null,
    total: null,
    remaining: null,
    nextResetTime: reset,
    windowStart: reset != null ? reset - ms : null,
    windowMs: ms,
  };
}

/** 把一个模型组的 buckets[] 归一成 { five, week, month, reached } */
function groupWindows(group, now) {
  const out = { five: emptyWindow('five'), week: emptyWindow('week'), month: emptyWindow('month') };
  const buckets = Array.isArray(group && group.buckets) ? group.buckets : [];
  let any = false;
  for (const b of buckets) {
    const slot = slotOf(b);
    if (!slot) continue;
    const win = mkWindow(b, slot, now);
    // 同一槽位撞了两个 bucket 时保留已用更高的那个（宁可早报警）
    if (!out[slot].known || win.percent > out[slot].percent) out[slot] = win;
    any = true;
  }
  if (!any) return null;
  out.reached = SLOTS.some((k) => out[k].known && out[k].percent >= 100);
  return out;
}

const isGeminiGroup = (g) => {
  const name = String((g && (g.name || g.displayName)) || '');
  const buckets = Array.isArray(g && g.buckets) ? g.buckets : [];
  return /gemini/i.test(name) || buckets.some((b) => /^gemini/i.test(String((b && (b.id || b.bucketId)) || '')));
};

const is3pGroup = (g) => {
  const name = String((g && (g.name || g.displayName)) || '');
  const buckets = Array.isArray(g && g.buckets) ? g.buckets : [];
  return /claude|gpt|third[- ]?party|\b3p\b/i.test(name)
    || buckets.some((b) => /^3p/i.test(String((b && (b.id || b.bucketId)) || '')));
};

function shortGroupName(name) {
  const s = String(name || '').trim();
  if (/claude/i.test(s) && /gpt/i.test(s)) return 'Claude/GPT';
  if (/gemini/i.test(s)) return 'Gemini';
  return s || '其他模型';
}

/**
 * 整份 `agy -p /usage --output-format json` 响应 → 挂件统一形状。
 * @param {object} body  JSON 对象
 * @param {number} now   当前毫秒时间戳
 * @param {'gemini'|'3p'} [wantGroup='gemini']  主展示哪一组
 */
function normalize(body, now, wantGroup) {
  const groupKey = wantGroup === '3p' ? '3p' : 'gemini';
  const rawGroups = (body && body.command && body.command.data && body.command.data.groups)
    || (body && body.data && body.data.groups)
    || (body && body.groups)
    || [];
  const groups = Array.isArray(rawGroups) ? rawGroups : [];

  let mainIdx = -1;
  if (groupKey === '3p') {
    mainIdx = groups.findIndex(is3pGroup);
    if (mainIdx < 0 && groups.length > 1) mainIdx = 1;
  } else {
    mainIdx = groups.findIndex(isGeminiGroup);
    if (mainIdx < 0 && groups.length > 0) mainIdx = 0;
  }

  const mainGroup = mainIdx >= 0 ? groups[mainIdx] : null;
  const main = groupWindows(mainGroup, now)
    || { five: emptyWindow('five'), week: emptyWindow('week'), month: emptyWindow('month'), reached: false };

  const extras = [];
  groups.forEach((g, i) => {
    if (i === mainIdx) return;
    const w = groupWindows(g, now);
    if (!w) return;
    const name = String((g && (g.name || g.displayName)) || `模型组 ${i + 1}`);
    extras.push({
      name,
      shortName: shortGroupName(name),
      description: String((g && g.description) || ''),
      five: w.five,
      week: w.week,
      month: w.month,
      reached: w.reached,
    });
  });

  const mainName = String((mainGroup && (mainGroup.name || mainGroup.displayName)) || (groupKey === '3p' ? 'Claude & GPT' : 'Gemini'));
  return {
    group: groupKey,
    groupName: mainName,
    level: groupKey === '3p' ? '3p' : null,
    five: main.five,
    week: main.week,
    month: main.month,
    reached: main.reached,
    extras,
  };
}

/* ---------------- 执行与错误分类 ---------------- */

function classifyFailure(r, cmd) {
  const combined = `${r.stderr || ''}\n${r.stdout || ''}\n${(r.err && r.err.message) || ''}`;
  const isSsh = cmd.source === 'ssh';

  if (isSsh) {
    const sshErr = classifySshError(r, cmd.host, 'SSH 连接或远程 agy ');
    if (sshErr) return sshErr;
    if (/(?:agy:\s*(?:command )?not found|No such file or directory)/i.test(combined)) {
      return { kind: 'error', msg: `远程主机 ${cmd.host} 上未找到 agy——请在「自定义 agy 路径」里填远程 agy 的完整路径（如 ~/.local/bin/agy）` };
    }
  } else {
    if (r.err && (r.err.killed || r.err.signal === 'SIGTERM' || /ETIMEDOUT/i.test(String(r.err.code || '')))) {
      return { kind: 'network', msg: '执行 agy 超时' };
    }
    if (r.err && r.err.code === 'ENOENT') {
      return { kind: 'error', msg: '未找到 agy 命令——请先安装 Antigravity CLI，或在「自定义 agy 路径」里填完整路径' };
    }
  }
  if (/429|RESOURCE_EXHAUSTED|rate[- ]?limit|too many requests/i.test(combined)) {
    return { kind: 'ratelimit', msg: '触发限流（429），稍后自动重试' };
  }
  if (/not logged in|unauthenticated|sign in|login required|401|403|invalid_grant|token.*expired|credential/i.test(combined)) {
    return { kind: 'expired', msg: 'Antigravity 未登录或登录已失效' };
  }
  const snippet = (r.stderr || r.stdout || (r.err && r.err.message) || '').trim().slice(0, 200);
  return { kind: 'error', msg: `${isSsh ? '远程' : '本机'}执行 agy 失败${r.code != null ? `（退出码 ${r.code}）` : ''}${snippet ? '：' + snippet : ''}` };
}

/**
 * 查一次。
 * @param {object} opts { source:'local'|'ssh', sshTarget?, group?:'gemini'|'3p', agyPath? }
 * @param {Function} [execImpl] 注入用（测试 mock），签名 (bin, args, timeoutMs) => Promise<{code,stdout,stderr,err}>
 * @param {number} [now]
 * @param {string} [platform] 测试覆写 process.platform
 */
async function fetchUsage(opts, execImpl, now, platform) {
  const ts = now || Date.now();
  const cmd = buildCommand(opts || {}, platform);
  if (cmd.err) return { ok: false, kind: cmd.err.kind, msg: cmd.err.msg };

  const run = execImpl || execCmd;
  let r;
  try {
    r = await run(cmd.bin, cmd.args, DEFAULT_TIMEOUT_MS);
    // Windows 上 npm / wrapper 安装的 agy.cmd 用 execFile('agy') 会报 ENOENT：仅在默认名（无用户输入）时退回 cmd /c agy
    if (cmd.fallbackWinCmd && r && r.err && r.err.code === 'ENOENT') {
      r = await run('cmd.exe', ['/d', '/c', 'agy', ...CLI_ARGS], DEFAULT_TIMEOUT_MS);
    }
  } catch (e) {
    return { ok: false, kind: 'error', msg: String((e && e.message) || e) };
  }

  const body = parseJsonOutput(r && r.stdout);
  if (r && r.err && !body) {
    const f = classifyFailure(r, cmd);
    return { ok: false, kind: f.kind, msg: f.msg };
  }
  if (!body) {
    const raw = String((r && (r.stdout || r.stderr)) || '').trim().slice(0, 200);
    return { ok: false, kind: 'parse', msg: `agy 返回内容不是 JSON${raw ? ' · 原文=' + raw : ''}` };
  }
  if (body.status && String(body.status).toUpperCase() !== 'SUCCESS') {
    const errText = String(body.error || body.message || body.response || body.status);
    if (/not logged in|unauthenticated|login|auth|401|403/i.test(errText)) {
      return { ok: false, kind: 'expired', msg: `Antigravity 未登录或登录已失效（${errText.slice(0, 120)}）` };
    }
    if (/429|RESOURCE_EXHAUSTED|rate[- ]?limit/i.test(errText)) {
      return { ok: false, kind: 'ratelimit', msg: '触发限流（429），稍后自动重试' };
    }
    return { ok: false, kind: 'error', msg: `agy 查询失败：${errText.slice(0, 180)}` };
  }

  let norm;
  try {
    norm = normalize(body, ts, opts && opts.group);
  } catch (e) {
    return { ok: false, kind: 'parse', msg: `解析失败：${String((e && e.message) || e)}` };
  }

  if (!SLOTS.some((k) => norm[k] && norm[k].known) && !(norm.extras && norm.extras.length)) {
    return { ok: false, kind: 'parse', msg: 'agy 响应里没有配额分组数据（确认 agy CLI 版本支持 /usage）' };
  }

  return {
    ok: true,
    data: { ...norm, source: cmd.source, sshHost: cmd.host, fetchedAt: ts },
  };
}

module.exports = {
  SLOT_SECONDS, CLI_ARGS, DEFAULT_TIMEOUT_MS,
  parseSshTarget, validateAgyPath, buildRemoteCmd, buildCommand,
  parseJsonOutput, slotOf, normalize, fetchUsage,
};
