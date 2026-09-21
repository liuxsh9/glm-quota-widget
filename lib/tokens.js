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

  /** 火山方舟 AccessKey ID：形态固定，`AKLT` 开头（粘贴整段里也认） */
  function extractVolcAk(raw) {
    if (!raw) return '';
    const m = String(raw).match(/AKLT[A-Za-z0-9]{6,}/);
    return m ? m[0] : '';
  }

  /**
   * 火山方舟 Secret Access Key：**没有固定形态**（不像 API Key 有前缀可认），
   * 所以只做「剥离标签与引号」+ 字符集兜底。
   *
   * 这里的取舍很关键：cleanCredentials 会把「提取不出来的非空输入」判成无效并**拒绝保存**，
   * 所以太严会把合法密钥挡在门外。反过来太松（比如无脑取最后一段）又可能悄悄存进半截值，
   * 表现是「保存成功但一直鉴权失败」。所以规则是：能干净地提取就提取，提不干净就返回空
   * 让它明确报错——绝不猜。
   */
  function extractVolcSecret(raw) {
    if (!raw) return '';
    let s = String(raw).trim().replace(/^["']|["']$/g, '').trim();
    const labeled = s.match(
      /^(?:volcengine[_-]?)?(?:access[_-]?key[_-]?secret|secret[_-]?access[_-]?key|secret[_-]?key|sk)\s*["']?\s*[:=]\s*["']?\s*(.+)$/i);
    if (labeled) s = labeled[1].trim().replace(/^["']|["']$/g, '').trim();
    return /^[A-Za-z0-9+/=_-]{16,}$/.test(s) ? s : '';
  }

  return { extractToken, extractDsToken, extractPlatformToken, extractVolcAk, extractVolcSecret };
});
