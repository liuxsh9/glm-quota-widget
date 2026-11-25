'use strict';
/**
 * 本机 / SSH 子进程执行的共用小工具（纯 Node，不碰 Electron）。
 *
 * Gemini（Antigravity CLI）与 OpenAI Codex 的「SSH 远程」模式共用这一套：
 *   - 严格解析 SSH 目标（主机名 / ~/.ssh/config 别名 + 白名单传输参数），拒绝 shell 元字符与 -o
 *   - 全程 execFile（不走 shell）+ windowsHide:true（Windows 定时刷新不闪黑框）
 *   - 统一归类 SSH 传输层错误（缺 ssh / 超时 / 免密失败 / 网络不可达）
 */
const { execFile } = require('child_process');

/** 禁止出现的 shell 元字符 / 换行 / 引号 */
const BAD_CHARS_RE = /[;&|`$()<>\r\n'"]/;
/** 允许的 SSH 传输参数（刻意禁止 -o，防止 ProxyCommand 任意命令执行） */
const SSH_VALUE_FLAGS = new Set(['-p', '-i', '-J', '-F', '-l']);
const SSH_BOOL_FLAGS = new Set(['-4', '-6']);
const HOST_RE = /^[A-Za-z0-9._@:[\]-]+$/;

/**
 * 解析并校验 SSH 目标：支持 `my-server`、`user@10.0.0.5`、`user@host -p 2222`、
 * `ssh -p 2222 -i ~/.ssh/id_ed25519 user@host`（粘贴整条 ssh 命令会自动剥掉开头的 ssh）。
 * @returns {{ok:true, host:string, flags:string[], args:string[]}|{ok:false, msg:string}}
 */
function parseSshTarget(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, msg: '「SSH 远程」模式要填写 SSH 目标主机（如 user@10.0.0.5 或 ~/.ssh/config 别名）' };
  if (BAD_CHARS_RE.test(s)) {
    return { ok: false, msg: 'SSH 目标包含不允许的特殊字符（不能含引号、换行或 ; | & $ ` 等 shell 符号）' };
  }
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens[0] && tokens[0].toLowerCase() === 'ssh') tokens.shift();
  if (!tokens.length) return { ok: false, msg: 'SSH 目标缺少主机名' };

  const flags = [];
  let host = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (SSH_BOOL_FLAGS.has(tok)) {
      flags.push(tok);
      continue;
    }
    if (SSH_VALUE_FLAGS.has(tok)) {
      const val = tokens[++i];
      if (!val || val.startsWith('-')) return { ok: false, msg: `SSH 参数 ${tok} 缺少取值` };
      if (tok === '-p') {
        const port = Number(val);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return { ok: false, msg: `SSH 端口号不合法：${val}（需为 1–65535 整数）` };
        }
      }
      flags.push(tok, val);
      continue;
    }
    if (tok.startsWith('-')) {
      return { ok: false, msg: `不支持的 SSH 参数「${tok}」——只支持主机名与 -p / -i / -J / -F / -l / -4 / -6` };
    }
    if (host) {
      return { ok: false, msg: `SSH 目标只能填一个主机名，多余片段：「${tok}」` };
    }
    if (!HOST_RE.test(tok)) {
      return { ok: false, msg: `SSH 主机名格式不正确：「${tok}」` };
    }
    host = tok;
  }
  if (!host) return { ok: false, msg: 'SSH 目标缺少主机名（如 user@10.0.0.5 或 ~/.ssh/config 别名）' };
  return { ok: true, host, flags, args: [...flags, host] };
}

/** 拼 ssh 参数：强制 BatchMode=yes（永不挂起等密码）与 ConnectTimeout=10 */
function buildSshArgs(parsed, remoteCmd) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...parsed.args, remoteCmd];
}

/** 默认子进程执行器（windowsHide:true 防止 Windows 上定时刷新闪黑框） */
function execCmd(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

/**
 * 归类 SSH 传输层错误；不是 SSH 层错误（如远程命令自身报错）时返回 null，交由调用方继续判断。
 * @returns {{kind:string, msg:string}|null}
 */
function classifySshError(r, host, timeoutLabel) {
  const combined = `${(r && r.stderr) || ''}\n${(r && r.stdout) || ''}\n${(r && r.err && r.err.message) || ''}`;
  if (r && r.err && (r.err.killed || r.err.signal === 'SIGTERM' || /ETIMEDOUT/i.test(String(r.err.code || '')))) {
    return { kind: 'network', msg: `${timeoutLabel || 'SSH 连接'}超时（${host}）` };
  }
  if (r && r.err && r.err.code === 'ENOENT') {
    return { kind: 'error', msg: '本机未找到 ssh 命令——请确认 Windows 已启用 OpenSSH 客户端' };
  }
  if (/permission denied|host key verification failed|publickey|authentication failed|password/i.test(combined)) {
    const detail = ((r && r.stderr) || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' / ').slice(0, 140);
    return { kind: 'expired', msg: `SSH 免密登录失败（${host}）${detail ? '：' + detail : ''}——请先在本机终端确认能直接 ssh ${host}` };
  }
  if (/could not resolve|connection refused|connection timed out|no route to host|network is unreachable|connection closed|broken pipe|reset by peer/i.test(combined)) {
    return { kind: 'network', msg: `SSH 无法连接到 ${host}：${((r && r.stderr) || (r && r.err && r.err.message) || '').trim().slice(0, 160)}` };
  }
  return null;
}

module.exports = { BAD_CHARS_RE, parseSshTarget, buildSshArgs, execCmd, classifySshError };
