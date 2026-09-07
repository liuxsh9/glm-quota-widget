'use strict';
/** 数据层测试：extractToken 单测 + 真实 token 联测（token 从 env GLM_TOKEN 或 /tmp/glm_token 读取，不进仓库） */
const fs = require('fs');
const assert = require('assert');
const { extractToken, fetchUsage } = require('../lib/usage');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

console.log('extractToken:');
const JWT = 'eyJhbGciOiJIUzUxMiJ9.eyJ1c2VyX3R5cGUiOiJQRVJTT05BTCJ9.FAKE_sig_for_unit_tests';
t('整段 Cookie 提取', () => assert.strictEqual(extractToken(`ga=1; bigmodel_token_production=${JWT}; foo=bar`), JWT));
t('纯 JWT 直通', () => assert.strictEqual(extractToken(JWT), JWT));
t('混排文本兜底', () => assert.strictEqual(extractToken(`随便什么 ${JWT} 前后`), JWT));
t('垃圾输入返回空串', () => assert.strictEqual(extractToken('hello world'), ''));
t('空输入安全', () => assert.strictEqual(extractToken(''), ''));
t('未配 token → expired', async () => {
  const r = await fetchUsage(''); assert.strictEqual(r.ok, false); assert.strictEqual(r.kind, 'expired');
});

const token = process.env.GLM_TOKEN ||
  (fs.existsSync('/tmp/glm_token') ? fs.readFileSync('/tmp/glm_token', 'utf8').trim() : '');

if (!token) {
  console.log('\n(跳过联测：无 GLM_TOKEN env 或 /tmp/glm_token)');
} else {
  console.log('\nfetchUsage 联测:');
  (async () => {
    const r = await fetchUsage(token);
    if (!r.ok) { console.error('  ✗ 请求失败:', r.kind, r.msg); process.exitCode = 1; return; }
    const d = r.data;
    t('请求成功', () => assert.ok(true));
    t('5h 与周额度都被解析', () => { assert.ok(d.five); assert.ok(d.week); });
    t('5h 重置时间早于周额度', () => assert.ok(d.five.nextResetTime < d.week.nextResetTime));
    t('百分比在 0..100', () => { assert.ok(d.five.percent >= 0 && d.five.percent <= 100); assert.ok(d.week.percent >= 0 && d.week.percent <= 100); });
    t('used+remaining≈total(5h)', () => assert.ok(Math.abs(d.five.used + d.five.remaining - d.five.total) < 5));
    t('level 非空', () => assert.ok(d.level));
    console.log(`  → level=${d.level} 5h ${d.five.percent}% (${d.five.used}/${d.five.total}) 周 ${d.week.percent}% (${d.week.used}/${d.week.total})`);
    console.log(`  → 5h 重置于 ${new Date(d.five.nextResetTime).toLocaleString('zh-CN')}`);
  })();
}
