#!/bin/bash
# 为测试账号 nowen 播种合成数据（结构参考真实用户，内容零拷贝）。
#
# ⚠️ 会写生产库。虽然只动 nowen 自己的数据，跑之前仍建议备份：
#     sudo sqlite3 /vol1/1000/docker/nowen-note/data/nowen-note.db ".backup '/tmp/bk.db'"
#
# 用法：
#     ./scripts/seed-test-account.sh              # 默认规模（约 760 篇）
#     ./scripts/seed-test-account.sh --scale 2.0  # 两倍，用来压性能
#     ./scripts/seed-test-account.sh --scale 0.1  # 只放一点点，快速冒烟
set -euo pipefail

CONTAINER="${NOWEN_CONTAINER:-nowen-note}"
DATA_HOST="${NOWEN_DATA_HOST:-/vol1/1000/docker/nowen-note/data}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_HOST="$DATA_HOST/seed-nowen-test.sql"

echo "  1/4 生成 SQL…"
python3 "$HERE/seed-test-account.py" "$@" --out "$SQL_HOST"

echo "  2/4 送入容器…"
sudo docker cp "$HERE/seed-runner.mjs" "$CONTAINER:/tmp/seed-runner.mjs" >/dev/null

echo "  3/4 执行（容器内，带 nowen_search_normalize）…"
sudo docker exec -e SEED_SQL=/app/data/seed-nowen-test.sql "$CONTAINER" \
  node /tmp/seed-runner.mjs

echo "  4/4 清理临时文件…"
sudo rm -f "$SQL_HOST"
sudo docker exec "$CONTAINER" rm -f /tmp/seed-runner.mjs
echo "  ✅ 完成"
