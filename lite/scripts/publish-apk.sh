#!/bin/bash
# 把构建好的 APK 发布到 X · 中转剪切板（项目规则：成品 APP 一律走这里）。
#
# 用法：scripts/publish-apk.sh <apk路径> <版本号>
#
# 规则要点（见项目 AGENTS.md）：
#   · 两步：先 /api/upload-media 上传，再 /api/clips 发一条合成 post
#   · url 是【无前导斜杠】的相对路径 f/<name>
#   · 只调 API，不动 /vol1/www/x/ 下的任何既有文件
#   · 上传后必须校验下载地址 200 且大小一致
set -euo pipefail

APK="${1:?用法: publish-apk.sh <apk路径> <版本号> [更新说明.md]}"
VER="${2:?缺少版本号}"
X="${X_BASE:-http://192.168.8.9:3200}"
NAME="nowen-note-lite-${VER}.apk"

[ -f "$APK" ] || { echo "✗ 找不到 $APK" >&2; exit 1; }
SIZE_BYTES=$(stat -c%s "$APK")
SIZE_H=$(numfmt --to=iec --suffix=B "$SIZE_BYTES" 2>/dev/null || echo "$((SIZE_BYTES/1024))KB")

echo "== 1/3 上传 =="
UP=$(curl -sS -m 180 -F "file=@${APK};filename=${NAME}" "$X/api/upload-media")
echo "  $UP"
URL=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('url',''))")
[ -n "$URL" ] || { echo "✗ 上传失败" >&2; exit 1; }

echo "== 2/3 发 post =="
CHANGELOG_FILE="${3:-}"
BODY=$(python3 - "$VER" "$NAME" "$SIZE_H" "$URL" "$CHANGELOG_FILE" <<'PY'
import json, sys, pathlib
ver, name, size, url = sys.argv[1:5]
cl = sys.argv[5] if len(sys.argv) > 5 else ""
lines = []
if cl and pathlib.Path(cl).exists():
    lines = [l.rstrip() for l in pathlib.Path(cl).read_text(encoding="utf-8").splitlines() if l.strip()]
if not lines:
    lines = ["（本次未提供更新说明）"]
bullets = "\n".join(f"- {l}" if not l.startswith("-") else l for l in lines)
content = f"""项目：Nowen Note Lite｜版本：{ver}
本次更新：
{bullets}
附件：成品 APP 文件（{name}，{size}）"""
print(json.dumps({
    "type": "post",
    "content": content,
    "attachments": [{"kind": "file", "url": url, "name": name}],
}, ensure_ascii=False))
PY
)
POST=$(curl -sS -m 60 -H 'Content-Type: application/json' -d "$BODY" "$X/api/clips")
echo "  $POST"

echo "== 3/3 校验下载地址 =="
DL="$X/$URL"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -m 60 "$DL")
REMOTE=$(curl -sS -o /dev/null -w '%{size_download}' -m 300 "$DL")
echo "  HTTP $CODE"
echo "  本地 ${SIZE_BYTES} 字节 / 远端 ${REMOTE} 字节"
if [ "$CODE" = "200" ] && [ "$REMOTE" = "$SIZE_BYTES" ]; then
  echo "  ✓ 校验通过"
  echo
  echo "  内网直链: http://192.168.8.9:3200/${URL}"
  echo "  公网直链: https://ctpph.cn/x/${URL}"
else
  echo "  ✗ 校验不通过" >&2
  exit 1
fi
