#!/bin/sh
# =============================================================================
# nowen-note 容器启动脚本
# -----------------------------------------------------------------------------
# 职责：让镜像"开箱即用"——用户不必手动配置 JWT_SECRET 就能启动，同时保持
# 生产环境"不使用硬编码默认密钥"的安全基线。
#
# 逻辑：
#   1. 若调用方已显式设置 JWT_SECRET（长度 >= 16）→ 直接使用，不做任何改动。
#      （高级用户 / K8s / compose 可以继续用外部注入）
#   2. 否则：在持久化卷 /app/data 下维护一个 .jwt_secret 文件
#        a. 文件已存在且合法 → 读取并导出，保证重启后 token 不失效
#        b. 文件不存在 → 生成 64 字节强随机密钥（openssl > /dev/urandom 兜底），
#           写入文件并 chmod 600，作为本机部署的"一次性生成、永久持有"密钥
#   3. 对 SHARE_JWT_SECRET 同样处理（用独立文件，未设置则由 backend 从
#      JWT_SECRET 派生，故此脚本只为它准备"如果以后想强制独立"的占位，不强制生成）
#
# 设计考量：
#   - 密钥落到 /app/data（docker-compose 挂 volume 的位置），容器销毁重建后
#     保持一致 → 用户不会被莫名其妙登出。
#   - 每台部署机独立随机值 → 不存在"所有部署共用同一个默认密钥"的风险。
#   - 任意时刻用户仍可通过 `-e JWT_SECRET=xxx` 覆盖，脚本不会触碰这种情况。
# =============================================================================

set -eu

DATA_DIR="${NOWEN_DATA_DIR:-/app/data}"
SECRET_FILE="$DATA_DIR/.jwt_secret"

mkdir -p "$DATA_DIR"

# 生成强随机密钥（64 字节 base64，约 88 字符）。优先 openssl，回退 /dev/urandom
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48
  else
    # base64 所有 Linux 基础镜像都有；head -c 64 从 urandom 取 64 字节
    head -c 64 /dev/urandom | base64 | tr -d '\n'
  fi
}

# 只有当 JWT_SECRET 未设置或过短时才自动接管。
# backend 的校验标准是 length >= 16，与此处保持一致。
if [ -z "${JWT_SECRET:-}" ] || [ "$(printf %s "${JWT_SECRET:-}" | wc -c)" -lt 16 ]; then
  if [ -s "$SECRET_FILE" ] && [ "$(wc -c < "$SECRET_FILE")" -ge 16 ]; then
    # 复用已有密钥：重启 / 容器重建后用户不被登出
    JWT_SECRET="$(cat "$SECRET_FILE")"
    echo "[entrypoint] JWT_SECRET loaded from $SECRET_FILE (persisted on first boot)"
  else
    # 首次启动：生成并持久化
    NEW_SECRET="$(gen_secret)"
    # trim 可能的尾随换行
    NEW_SECRET="$(printf %s "$NEW_SECRET" | tr -d '\n')"
    printf %s "$NEW_SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE" || true
    JWT_SECRET="$NEW_SECRET"
    echo "[entrypoint] JWT_SECRET auto-generated and stored at $SECRET_FILE"
    echo "[entrypoint]   → 每台部署机拥有独立随机密钥；如需手动指定可通过环境变量覆盖"
  fi
  export JWT_SECRET
else
  echo "[entrypoint] JWT_SECRET provided via environment (length=$(printf %s "$JWT_SECRET" | wc -c)), using as-is"
fi

# 交棒给原 CMD
exec "$@"
