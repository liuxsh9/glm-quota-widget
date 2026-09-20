'use strict';
/* 打包收尾：把 Windows 的 zip 变成「解压出来一层 <productName>/ 文件夹」并改名 -win64.zip。
 *
 * 为什么要自己重打：electron-builder 26 的 zip 目标把 withoutDir 写死成 !isMac
 * （app-builder-lib/out/targets/ArchiveTarget.js），Windows 的 zip 必然是平铺的 ——
 * 解压出来十几个 dll 直接落在目标目录里，配置里没有开关可以改。
 * 所以等 zip 目标出完产物，用 electron-builder 自带的 7za 再打一遍：
 * 把 win-unpacked 硬链到 <stage>/<productName>/ 下，再指定「带目录」归档，
 * 压缩级别沿用 electron-builder 的取值（含 ELECTRON_BUILDER_COMPRESSION_LEVEL 覆盖）。
 *
 * 重打失败不炸构建：留着平铺的 zip 并打日志 —— 宁可结构不合口味，也别让发版挂掉。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WIN_ZIP = /(^|[/\\])[^/\\]+-win\.zip$/;

/** 把 src 目录树硬链一份到 dst（同盘瞬间完成、不额外占空间；跨盘/不支持则退回复制） */
function linkTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) linkTree(s, d);
    else if (e.isSymbolicLink()) { try { fs.symlinkSync(fs.readlinkSync(s), d); } catch { fs.copyFileSync(s, d); } }
    else { try { fs.linkSync(s, d); } catch { fs.copyFileSync(s, d); } }
  }
}

async function repack(appDir, productName, outFile, compression) {
  const { getPath7za } = require('app-builder-lib/out/toolsets/7zip');
  const sevenZip = await getPath7za();
  // 暂存目录：<out>/zip-root/<productName>/… —— 7za 从上一级归档，条目自然带一层文件夹
  const stage = path.join(path.dirname(outFile), 'zip-root');
  const root = path.join(stage, productName);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(outFile, { force: true });
  linkTree(appDir, root);
  try {
    const lvl = process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL
      || (compression === 'store' ? '0' : compression === 'maximum' ? '9' : '7');
    execFileSync(sevenZip, [
      'a', '-tzip', `-mx=${lvl}`, '-mm=Deflate', '-mcu', '-mtc=off', '-bso0', '-bsp0',
      path.resolve(outFile), productName,
    ], { cwd: stage, stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });   // 只是硬链，删掉不动 win-unpacked
  }
  // 验收：新 zip 里每一条都得在 <productName>/ 底下，否则当成失败（保留原平铺 zip）。
  // 注意：Windows 上 7-Zip 列出的 Path 用反斜杠、行尾还是 CRLF —— 两个都得归一化再比，
  // 否则本地（Linux）通过、CI（Windows）判不合格，钩子静默回退成平铺 zip。
  const list = execFileSync(sevenZip, ['l', '-ba', '-slt', outFile], { encoding: 'utf8' });
  const paths = list.split(/\r?\n/)
    .filter((l) => l.startsWith('Path = '))
    .map((l) => l.slice(7).trim().replace(/\\/g, '/').replace(/\/+$/, ''));
  const bad = paths.filter((p) => p !== productName && !p.startsWith(productName + '/'));
  if (!paths.length || bad.length) throw new Error(`归档里出现不在 ${productName}/ 下的条目：${bad.slice(0, 3).join(', ')}`);
  return paths.length;
}

module.exports = async function afterAllArtifactBuild(buildResult) {
  const cfg = buildResult.configuration || {};
  const productName = cfg.productName || 'app';
  const appDir = path.join(buildResult.outDir, 'win-unpacked');
  const made = [];
  for (const src of buildResult.artifactPaths || []) {
    if (!WIN_ZIP.test(src)) continue;
    const dst = src.replace(/-win\.zip$/, '-win64.zip');
    if (!fs.existsSync(appDir)) {
      console.warn('afterArtifacts: 找不到', appDir, '，保留平铺 zip');
      continue;
    }
    try {
      const n = await repack(appDir, productName, dst, cfg.compression);
      fs.rmSync(src, { force: true });   // 平铺的那份让位给带目录的
      made.push(dst);
      console.log(`afterArtifacts: ${path.basename(dst)} 已就绪（${n} 个条目，内含 ${productName}/ 一层目录）`);
    } catch (e) {
      fs.rmSync(dst, { force: true });   // 半成品别留在 dist 里
      console.warn('afterArtifacts: zip 重打失败，保留平铺 zip ——', e.message);
    }
  }
  return made;
};
