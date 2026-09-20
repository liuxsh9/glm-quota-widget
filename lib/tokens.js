'use strict';
/**
 * 凭据提取（纯字符串操作，无 IO）。
 * 主进程用它清洗粘贴进来的任意内容；provider 元数据（lib/providers/meta.js）只声明
 * 「有哪个字段」，不关心怎么提取，所以这份实现独立成 UMD 模块，两边都能加载。
 */
(function (factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  if (typeof window !== 'undefined') window.GLMTOK = factory();
})(function () {
  /** GLM：整段 Cookie、纯 JWT、API Key、或混排文本 */
  function extractToken(raw) {
    if (!raw) return '';
    const s = String(raw).trim();
    const m = s.match(/bigmodel_token_production=([^;\s]+)/);
    if (m) return m[1];
    // 先试 JWT（三段式），避免其前两段被误判为 API Key（两段式）
    const m2 = s.match(/ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/);
    if (m2) return m2[0];
    // API Key：两段纯字母数字（实测 32.16）；前后界符防误吞文件名等噪声
    const m3 = s.match(/(?<![A-Za-z0-9_.-])[A-Za-z0-9]{16,}\.[A-Za-z0-9]{12,}(?![A-Za-z0-9_.-])/);
    return m3 ? m3[0] : '';
  }

  /** DeepSeek 官方 API Key：sk- 开头的固定形态（实测 sk- + 32 位十六进制） */
  function extractDsToken(raw) {
    if (!raw) return '';
    const m = String(raw).match(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{16,}(?![A-Za-z0-9_-])/);
    return m ? m[0] : '';
  }

  /**
   * DeepSeek 平台 userToken：兼容四种粘贴形态
   *   1. 裸 token
   *   2. localStorage 里的 JSON 串 {"value":"…"}（真值在 value 字段）
   *   3. 被再包一层的 JSON 字符串 "{\"value\":\"…\"}"
   *   4. 抄自 Network 面板的 `Authorization: Bearer xxx` / `userToken: xxx`
   */
  function extractPlatformToken(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    if (!s) return '';
    s = s.replace(/^userToken\s*[:=]\s*/i, '').trim();
    s = s.replace(/^Bearer\s+/i, '').trim();
    if (s[0] === '{' || s[0] === '"') {
      try {
        let o = JSON.parse(s);
        if (typeof o === 'string') o = JSON.parse(o); // 双重编码的 JSON 串
        const v = o && (o.value || o.token || o.access_token);
        if (typeof v === 'string' && v.trim()) s = v.trim();
      } catch { /* 不是 JSON，按裸 token 处理 */ }
    }
    s = s.replace(/^["']|["']$/g, '').trim();
    // 平台 token 常见为 JWT（含 . ）或长随机串；用宽松字符集 + 长度下限兜底
    return /^[A-Za-z0-9._~+/=-]{16,}$/.test(s) ? s : '';
  }

  return { extractToken, extractDsToken, extractPlatformToken };
});
