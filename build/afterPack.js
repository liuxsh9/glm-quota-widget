'use strict';
/* 打包瘦身：在 win-unpacked 产出后裁掉用不到的运行时组件 */
const fs = require('fs');
const path = require('path');

// elevate.exe：NSIS 安装器提权用，目录版/便携版不需要
// dxcompiler.dll / dxil.dll：WebGPU(D3D12/Dawn) 着色器编译，纯 DOM 界面用不到；
//   常规 GPU 合成走 D3D11（由保留的 d3dcompiler_47.dll 支持）
const REMOVABLE = ['resources/elevate.exe', 'dxcompiler.dll', 'dxil.dll'];

module.exports = async function (context) {
  for (const f of REMOVABLE) {
    try {
      fs.unlinkSync(path.join(context.appOutDir, f));
      console.log('afterPack 移除', f);
    } catch { /* 不存在则跳过 */ }
  }
};
