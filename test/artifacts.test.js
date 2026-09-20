'use strict';
/* 打包收尾钩子 build/afterArtifacts.js：
 * 把 Windows 的平铺 zip 重打成「解压一层 GLM-Usage-Widget/」的 -win64.zip。
 *
 * 之所以单独测：这个钩子失败时**只打一句 warn 就保留平铺 zip**（发版不能挂），
 * 于是 v0.6.0 在 CI 上静默出了个平铺包，本地却看不出来 —— 根因是验收时拿 "/" 比对
 * 7-Zip 在 Windows 上列的 "\\"。所以这里把解析逻辑单独钉住，再（有 7za 时）真的打一遍。
 *
 * 用法：node test/artifacts.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hook = require(path.join(__dirname, '..', 'build', 'afterArtifacts.js'));

let pass = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n    ', e.message); process.exitCode = 1; }
}

(async () => {
  console.log('afterArtifacts');

  // —— 解析：Windows 与 Linux 两种输出都必须归一化成同样的东西 ——
  // 这条就是 v0.6.0 翻车的那一步：反斜杠 + CRLF 没处理 → 误判不合格 → 静默回退。
  const win = [
    'Path = GLM-Usage-Widget\r',
    'Path = GLM-Usage-Widget\\GLM-Usage-Widget.exe\r',
    'Path = GLM-Usage-Widget\\resources\\app.asar\r',
    'Path = GLM-Usage-Widget\\locales\\zh-CN.pak\r',
    '',
  ].join('\n');
  const lin = [
    'Path = GLM-Usage-Widget',
    'Path = GLM-Usage-Widget/GLM-Usage-Widget.exe',
    'Path = GLM-Usage-Widget/resources/app.asar',
    'Path = GLM-Usage-Widget/locales/zh-CN.pak',
  ].join('\n');

  await t('Windows 风格的列表输出被归一化成 / 分隔', () => {
    assert.deepStrictEqual(hook.parseListedPaths(win), [
      'GLM-Usage-Widget',
      'GLM-Usage-Widget/GLM-Usage-Widget.exe',
      'GLM-Usage-Widget/resources/app.asar',
      'GLM-Usage-Widget/locales/zh-CN.pak',
    ]);
  });

  await t('Linux 风格与 Windows 风格解析结果一致', () => {
    assert.deepStrictEqual(hook.parseListedPaths(win), hook.parseListedPaths(lin));
  });

  await t('目录条目末尾的斜杠被去掉（否则比不过 productName）', () => {
    assert.deepStrictEqual(hook.parseListedPaths('Path = App/\nPath = App\\sub\\'), ['App', 'App/sub']);
  });

  await t('只认 Path 行，不把 Size/Date 之类的键当路径', () => {
    const out = 'Path = App\nSize = 1024\nModified = 2026-09-20 10:00:00\nAttributes = D\n';
    assert.deepStrictEqual(hook.parseListedPaths(out), ['App']);
  });

  await t('空输出 → 空数组（钩子据此判失败，不会误放行）', () => {
    assert.deepStrictEqual(hook.parseListedPaths(''), []);
  });

  // —— 端到端：拿一个假的 win-unpacked 真打一遍 zip，验结构 ——
  // 需要 electron-builder 自带的 7za（首次会下载）。拿不到就跳过，不算失败。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-afterartifacts-'));
  const dist = path.join(tmp, 'dist');
  const appDir = path.join(dist, 'win-unpacked');
  fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'locales'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'GLM-Usage-Widget.exe'), 'MZ fake');
  fs.writeFileSync(path.join(appDir, 'resources', 'app.asar'), 'fake asar');
  fs.writeFileSync(path.join(appDir, 'locales', 'zh-CN.pak'), 'fake pak');

  const flat = path.join(dist, 'GLM-Usage-Widget-0.0.0-win.zip');
  fs.writeFileSync(flat, 'placeholder for the flat zip');

  let made = null, skipped = null;
  try {
    made = await hook({
      outDir: dist,
      configuration: { productName: 'GLM-Usage-Widget', compression: 'normal' },
      artifactPaths: [flat],
    });
    if (!made.length) skipped = '钩子没认出平铺 zip 的产物路径';
  } catch (e) {
    skipped = e.message;
  }

  if (skipped) {
    console.log('  · 跳过端到端（' + skipped.slice(0, 70) + '…）');
  } else {
    const win64 = path.join(dist, 'GLM-Usage-Widget-0.0.0-win64.zip');
    await t('产出 -win64.zip，平铺的 -win.zip 被删掉', () => {
      assert.ok(fs.existsSync(win64), '缺少 ' + path.basename(win64));
      assert.ok(!fs.existsSync(flat), '平铺 zip 应该被删掉');
      assert.deepStrictEqual(made, [win64]);
    });

    await t('归档里每一条都在 GLM-Usage-Widget/ 之下，且文件都打进去了', async () => {
      const { execFileSync } = require('child_process');
      const sevenZip = path.join(__dirname, '..',
        'node_modules', 'app-builder-lib', 'out', 'toolsets', '7zip.js');
      const paths = hook.parseListedPaths(execFileSync(await require(sevenZip).getPath7za(),
        ['l', '-ba', '-slt', win64], { encoding: 'utf8' }));
      assert.ok(paths.length >= 4, '条目太少：' + JSON.stringify(paths));
      const bad = paths.filter((p) => p !== 'GLM-Usage-Widget' && !p.startsWith('GLM-Usage-Widget/'));
      assert.deepStrictEqual(bad, [], '有不在 GLM-Usage-Widget/ 下的条目');
      for (const f of ['GLM-Usage-Widget/GLM-Usage-Widget.exe',
        'GLM-Usage-Widget/resources/app.asar', 'GLM-Usage-Widget/locales/zh-CN.pak']) {
        assert.ok(paths.includes(f), '缺条目 ' + f);
      }
    });
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(pass ? `\n${pass} 项通过` : '\n用例没有执行');
})();
