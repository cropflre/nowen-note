#!/bin/bash
# 构建 Nowen Note Lite 的安卓 APK —— 幂等，可重复跑。
#
# 用法：scripts/build-apk.sh [debug|release]     默认 release
#
# ⚠️ 两个环境要点（不设就报奇怪的错）：
#   1. 必须用 /vol1/nowen-dev/jdk21（系统默认是 17，AGP 8.13 要 21）
#   2. GRADLE_USER_HOME 指向 /vol1/nowen-dev/gradle-home（里面有 AGP 8.13.0 缓存，
#      用别的目录会重新下载，而这台机器到 dl.google.com 偶发 TLS 握手失败）
set -euo pipefail

MODE="${1:-release}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export JAVA_HOME=/vol1/nowen-dev/jdk21
export ANDROID_HOME=/vol1/nowen-dev/android-sdk
export ANDROID_SDK_ROOT=/vol1/nowen-dev/android-sdk
export GRADLE_USER_HOME=/vol1/nowen-dev/gradle-home
export PATH="$JAVA_HOME/bin:/var/apps/nodejs_v22/target/bin:/usr/bin:$PATH"

cd "$ROOT"

echo "== 1/4 构建 Web 产物 =="
npm run build

echo "== 2/4 同步到安卓工程 =="
npx cap sync android

echo "== 3/4 编译 $MODE APK =="
cd android
# gradlew 的可执行位很容易被批量 chmod 弄掉（我就踩过）→ 每次都兜一下
chmod +x gradlew
if [ "$MODE" = "release" ]; then
  ./gradlew assembleRelease --no-daemon --console=plain
  OUT="app/build/outputs/apk/release/app-release.apk"
else
  ./gradlew assembleDebug --no-daemon --console=plain
  OUT="app/build/outputs/apk/debug/app-debug.apk"
fi

cd "$ROOT"
APK="android/$OUT"
if [ ! -f "$APK" ]; then
  echo "✗ 没找到产物：$APK" >&2
  exit 1
fi

echo "== 4/4 校验 =="
# 版本号/包名以 APK 自己的清单为准，不靠猜
AAPT="$(ls "$ANDROID_SDK_ROOT"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1)"
SIZE="$(stat -c%s "$APK")"
echo "  文件 : $APK"
echo "  大小 : $((SIZE / 1024)) KB"
if [ -n "$AAPT" ]; then
  BADGING="$("$AAPT" dump badging "$APK" 2>/dev/null || true)"
  echo "  包名 : $(echo "$BADGING" | grep -oP "package: name='\K[^']+" | head -1)"
  echo "  版本 : $(echo "$BADGING" | grep -oP "versionName='\K[^']+" | head -1)"
  echo "  应用名: $(echo "$BADGING" | grep -oP "application-label:'\K[^']+" | head -1)"
else
  echo "  （找不到 aapt2，跳过清单校验）"
fi
