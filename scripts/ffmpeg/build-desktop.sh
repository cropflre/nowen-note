#!/bin/sh
# 为桌面安装包编译精简 FFmpeg：组件清单与 Docker 镜像共用（minimal-configure-flags.txt），
# x264 静态链接，产物只依赖操作系统自带的库。
#
# 用法：scripts/ffmpeg/build-desktop.sh <linux-x64|win32-x64|darwin-x64|darwin-arm64> <输出目录>
#   linux-x64、win32-x64：在 alpine:3.23（linux/amd64）容器里编译，宿主机需要 Docker；
#   darwin-x64、darwin-arm64：在 macOS 上用 Xcode clang 编译，两种架构可以在同一台 Mac 上编。
# 产物：<输出目录>/ffmpeg-<目标>[.exe]，SHA-256 追加到 <输出目录>/SHA256SUMS。
set -eu

target=${1:?需要目标平台}
mkdir -p "${2:?需要输出目录}"
out=$(cd "$2" && pwd)
here=$(cd "$(dirname "$0")" && pwd)

# 全部源码固定 SHA-256，并已与 Alpine 3.23 aports 记录的 SHA-512 交叉核对。
FFMPEG_VERSION=8.0.1
FFMPEG_SHA256=05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41
X264_COMMIT=31e19f92f00c7003fa115047ce50978bc98c3a0d # 与 Alpine 3.23 的 x264 0.164.3108 相同
X264_SHA256=d053c9d86988d6bc78237ca5205865c5ddf99c98ef4cd9927eec8f6d388f6dd9
ZLIB_VERSION=1.4
ZLIB_SHA256=02dd159783677a749c04adbdd02b55b8a2bcc7e054f51b76b549199a916ad584
NASM_VERSION=2.16.03
NASM_SHA256=1412a1c760bbd05db026b6c0d1657affd6631cd0a63cddb6f73cc6d4aa616148
PKGCONF_VERSION=2.5.1
PKGCONF_SHA256=cd05c9589b9f86ecf044c10a2269822bc9eb001eced2582cfffd658b0a50c243

case "$target" in
  linux-x64|win32-x64)
    if [ ! -f /etc/alpine-release ]; then
      exec docker run --rm --platform linux/amd64 -v "$here:/ffmpeg:ro" -v "$out:/out" alpine:3.23 \
        sh /ffmpeg/build-desktop.sh "$target" /out
    fi ;;
  darwin-x64|darwin-arm64)
    [ "$(uname -s)" = Darwin ] || { echo "darwin 目标需要在 macOS 上编译" >&2; exit 1; } ;;
  *) echo "未知目标：$target" >&2; exit 1 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
prefix=$work/prefix
mkdir -p "$prefix/include" "$prefix/lib" "$work/tools/bin"
PATH=$work/tools/bin:$PATH
jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
flags=$(grep -v -e '^#' -e '^$' "$here/minimal-configure-flags.txt")

# run <日志名> <命令...>：输出写入日志，失败时打印日志末尾后退出
run() {
  log=$work/$1.log; shift
  "$@" > "$log" 2>&1 || { tail -n 40 "$log" >&2; echo "失败：$*" >&2; exit 1; }
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}
# fetch <URL> <SHA-256> <目录名>：下载、校验并解压到 $work/<目录名>
fetch() {
  file=$work/$(basename "$1")
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 15 --max-time 300 "$1" -o "$file"
  [ "$(sha256 "$file")" = "$2" ] || { echo "SHA-256 不匹配：$1" >&2; exit 1; }
  mkdir -p "$work/$3"
  tar -xf "$file" -C "$work/$3" --strip-components=1
}
build_tool() { # 编译期工具（宿主架构，不进安装包）
  fetch "$1" "$2" "$3"
  (cd "$work/$3" && run "$3-configure" ./configure --prefix="$work/tools" \
    && run "$3-make" make -j"$jobs" && run "$3-install" make install)
}
build_x264() {
  fetch "https://code.videolan.org/videolan/x264/-/archive/$X264_COMMIT/x264-$X264_COMMIT.tar.gz" "$X264_SHA256" x264
  cd "$work/x264"
  # 与 Alpine 的 version.patch 相同：没有 git 树时也报告 r3108，写进码流的版本信息与 Docker 版一致。
  awk '$0 == "ver=\"x\"" { print "ver=\"3108\""; print "echo \"#define X264_REV $ver\""; next }
       $0 == "version=\"\"" { print "version=\" r$ver\""; next } { print }' version.sh > version.sh.new
  mv version.sh.new version.sh && chmod +x version.sh
  grep -q 'X264_REV' version.sh || { echo "x264 版本信息未写入" >&2; exit 1; }
  run x264-configure ./configure --prefix="$prefix" --enable-static --disable-cli --disable-opencl --enable-pic "$@"
  run x264-make make -j"$jobs"
  run x264-install make install
}
build_ffmpeg() { # build_ffmpeg <可执行文件名> <configure 平台参数...>
  exe=$1; shift
  fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256" ffmpeg
  cd "$work/ffmpeg"
  # shellcheck disable=SC2086 # 组件清单按空白拆成独立参数
  export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig" # 只让 configure 看到这里编出的 x264
  run ffmpeg-configure ./configure $flags --pkg-config-flags=--static --optflags=-O3 "$@"
  run ffmpeg-make make -j"$jobs" "$exe"
}
finish() { # finish <产物路径> <输出文件名>
  cp "$1" "$out/$2"
  touch "$out/SHA256SUMS"
  grep -v "  $2\$" "$out/SHA256SUMS" > "$work/sums" || true
  echo "$(sha256 "$out/$2")  $2" >> "$work/sums"
  cp "$work/sums" "$out/SHA256SUMS"
  echo "[build-desktop-ffmpeg] $2 $(wc -c < "$out/$2" | tr -d ' ') bytes"
}

case "$target" in
  linux-x64)
    run apk apk add --no-cache bash binutils build-base curl nasm pkgconf tar xz zlib-dev zlib-static
    build_x264
    build_ffmpeg ffmpeg --enable-pthreads --enable-zlib --pkg-config=pkgconf \
      --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib" --extra-ldexeflags=-static
    strip ffmpeg
    # 完全静态：不依赖 glibc/musl 版本，任何 x86-64 Linux 发行版都能运行。
    if readelf -d ffmpeg 2>/dev/null | grep -q NEEDED; then echo "Linux 产物仍有动态依赖" >&2; exit 1; fi
    ./ffmpeg -hide_banner -version | head -n 1
    finish ffmpeg ffmpeg-linux-x64
    ;;
  win32-x64)
    run apk apk add --no-cache bash build-base curl mingw-w64-gcc nasm pkgconf tar xz
    cross=x86_64-w64-mingw32
    fetch "https://zlib.net/fossils/zlib-$ZLIB_VERSION.tar.gz" "$ZLIB_SHA256" zlib
    (cd "$work/zlib" && run zlib-make make -f win32/Makefile.gcc PREFIX="$cross-" libz.a \
      && cp zlib.h zconf.h "$prefix/include/" && cp libz.a "$prefix/lib/")
    build_x264 --host="$cross" --cross-prefix="$cross-" --enable-win32thread
    build_ffmpeg ffmpeg.exe --target-os=mingw32 --arch=x86_64 --cross-prefix="$cross-" --enable-cross-compile \
      --enable-w32threads --enable-zlib --pkg-config=pkgconf \
      --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib" --extra-ldexeflags=-static
    "$cross-strip" ffmpeg.exe
    # 只允许依赖 Windows 自带的系统 DLL（UCRT 随 Windows 10 及以上提供）。
    dlls=$("$cross-objdump" -p ffmpeg.exe | sed -n 's/^[[:space:]]*DLL Name: //p' | sort -u)
    echo "$dlls" | tr '\n' ' '; echo
    if echo "$dlls" | grep -v -i -E '^(kernel32|user32|advapi32|bcrypt|shell32|ole32|ws2_32|msvcrt|api-ms-win-[a-z0-9-]+)\.dll$' | grep -q .; then
      echo "Windows 产物依赖了非系统 DLL" >&2; exit 1
    fi
    finish ffmpeg.exe ffmpeg-win32-x64.exe
    ;;
  darwin-x64|darwin-arm64)
    arch=x86_64; ffarch=x86_64; host=x86_64-apple-darwin
    if [ "$target" = darwin-arm64 ]; then arch=arm64; ffarch=aarch64; host=aarch64-apple-darwin; fi
    min="-arch $arch -mmacosx-version-min=12.0" # 与 electron-builder 的 minimumSystemVersion 一致
    export MACOSX_DEPLOYMENT_TARGET=12.0
    # macOS 不自带 pkg-config 和 nasm，在临时目录从固定源码编一份，不改动系统。
    build_tool "https://distfiles.ariadne.space/pkgconf/pkgconf-$PKGCONF_VERSION.tar.xz" "$PKGCONF_SHA256" pkgconf
    [ "$arch" = arm64 ] || build_tool "https://www.nasm.us/pub/nasm/releasebuilds/$NASM_VERSION/nasm-$NASM_VERSION.tar.xz" "$NASM_SHA256" nasm
    export CC=clang
    build_x264 --host="$host" --extra-cflags="$min" --extra-ldflags="$min"
    cross=""
    [ "$(uname -m)" = "$arch" ] || cross=--enable-cross-compile
    # shellcheck disable=SC2086
    build_ffmpeg ffmpeg --enable-pthreads --enable-zlib --pkg-config=pkgconf \
      --target-os=darwin --arch="$ffarch" $cross --cc=clang \
      --extra-cflags="$min -I$prefix/include" --extra-ldflags="$min -L$prefix/lib"
    strip ffmpeg
    libs=$(otool -L ffmpeg | tail -n +2 | awk '{print $1}')
    echo "$libs" | tr '\n' ' '; echo
    if echo "$libs" | grep -v -E '^/usr/lib/|^/System/Library/' | grep -q .; then
      echo "macOS 产物依赖了系统以外的动态库" >&2; exit 1
    fi
    finish ffmpeg "ffmpeg-$target"
    ;;
esac
