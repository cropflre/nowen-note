#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-nowen-note}"
DB_PATH="${DB_PATH:-/app/data/nowen-note.db}"
DEFAULT_NOTEBOOK_NAME="${DEFAULT_NOTEBOOK_NAME:-默认笔记本}"

usage() {
  cat <<EOF
Usage:
  $(basename "$0") --username <name> --password <password> [options]

Options:
  --username <name>           Username to create
  --password <password>       Password for the new user
  --email <email>             Optional email address
  --notebook <name>           Default notebook name (default: ${DEFAULT_NOTEBOOK_NAME})
  --container <name>          Docker container name (default: ${CONTAINER_NAME})
  --db-path <path>            SQLite DB path in container (default: ${DB_PATH})
  -h, --help                  Show this help

Examples:
  $(basename "$0") --username alice --password 'ChangeMe123'
  $(basename "$0") --username bob --password 'StrongPass' --email bob@example.com --notebook '工作台'
EOF
}

USERNAME=""
PASSWORD=""
EMAIL=""
NOTEBOOK_NAME="$DEFAULT_NOTEBOOK_NAME"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --username)
      USERNAME="${2:-}"
      shift 2
      ;;
    --password)
      PASSWORD="${2:-}"
      shift 2
      ;;
    --email)
      EMAIL="${2:-}"
      shift 2
      ;;
    --notebook)
      NOTEBOOK_NAME="${2:-}"
      shift 2
      ;;
    --container)
      CONTAINER_NAME="${2:-}"
      shift 2
      ;;
    --db-path)
      DB_PATH="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$USERNAME" || -z "$PASSWORD" ]]; then
  echo "Error: --username and --password are required." >&2
  usage >&2
  exit 1
fi

if [[ ${#PASSWORD} -lt 6 ]]; then
  echo "Error: password must be at least 6 characters." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker command not found on this server." >&2
  exit 1
fi

if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "Error: container '$CONTAINER_NAME' not found." >&2
  exit 1
fi

if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME")" != "true" ]]; then
  echo "Error: container '$CONTAINER_NAME' is not running." >&2
  exit 1
fi

docker exec \
  -e NOWEN_NEW_USERNAME="$USERNAME" \
  -e NOWEN_NEW_PASSWORD="$PASSWORD" \
  -e NOWEN_NEW_EMAIL="$EMAIL" \
  -e NOWEN_NEW_NOTEBOOK="$NOTEBOOK_NAME" \
  -e NOWEN_DB_PATH="$DB_PATH" \
  "$CONTAINER_NAME" \
  node - <<'NODE'
const fs = require("fs");
const crypto = require("crypto");

function requireFrom(paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) {
      return require(p);
    }
  }
  throw new Error(`Required module not found. Tried: ${paths.join(", ")}`);
}

const Database = requireFrom([
  "/app/backend/node_modules/better-sqlite3",
  "/app/node_modules/better-sqlite3",
]);

const bcrypt = requireFrom([
  "/app/backend/node_modules/bcryptjs",
  "/app/node_modules/bcryptjs",
]);

const username = (process.env.NOWEN_NEW_USERNAME || "").trim();
const password = process.env.NOWEN_NEW_PASSWORD || "";
const emailRaw = (process.env.NOWEN_NEW_EMAIL || "").trim();
const notebookName = (process.env.NOWEN_NEW_NOTEBOOK || "默认笔记本").trim() || "默认笔记本";
const dbPath = process.env.NOWEN_DB_PATH || "/app/data/nowen-note.db";

if (!username) {
  throw new Error("username is required");
}
if (password.length < 6) {
  throw new Error("password must be at least 6 characters");
}

const email = emailRaw || null;
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

const existingUser = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
if (existingUser) {
  console.error(`User '${username}' already exists.`);
  process.exit(2);
}

if (email) {
  const existingEmail = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existingEmail) {
    console.error(`Email '${email}' is already in use.`);
    process.exit(3);
  }
}

const userId = crypto.randomUUID();
const notebookId = crypto.randomUUID();
const passwordHash = bcrypt.hashSync(password, 10);

const tx = db.transaction(() => {
  db.prepare(`
    INSERT INTO users (id, username, email, passwordHash)
    VALUES (?, ?, ?, ?)
  `).run(userId, username, email, passwordHash);

  db.prepare(`
    INSERT INTO notebooks (id, userId, name, icon, sortOrder)
    VALUES (?, ?, ?, ?, ?)
  `).run(notebookId, userId, notebookName, "📒", 0);
});

tx();

console.log(JSON.stringify({
  success: true,
  userId,
  username,
  email,
  notebookId,
  notebookName,
  dbPath,
}, null, 2));
NODE
