#!/usr/bin/env bash
# Windows 打包（在任意 cwd 下都可执行）：便携版 exe + 目录版 zip（启动快）
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

./node_modules/.bin/electron-builder --win portable || exit 1

# 目录版：解压一次即可秒启动（便携版每次运行都要自解压，冷启动慢）
VER=$(node -p "require('./package.json').version")
rm -rf "dist/GLM-Usage-Widget"
cp -r dist/win-unpacked "dist/GLM-Usage-Widget"
python3 - "$VER" <<'PY'
import sys, zipfile, os
ver = sys.argv[1]
src = "dist/GLM-Usage-Widget"
out = f"dist/GLM-Usage-Widget-{ver}-win64.zip"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, _dirs, files in os.walk(src):
        for f in files:
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, "dist"))
print("zip 完成:", out)
PY
rm -rf "dist/GLM-Usage-Widget"

echo "BUILD_EXIT:0"
