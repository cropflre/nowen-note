#!/usr/bin/env bash
# This runs only against a fresh, disposable production Docker image and
# destroys test users, JWTs and databases on exit. No release/deployment steps.
set -euo pipefail
: "${RC_IMAGE:?Must supply immutable candidate Docker image tag}"
root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/nowen-studio-rc.XXXXXX")"
name="nowen-studio-rc-${GITHUB_RUN_ID:-local}-$$"
port=45391
export RC_BASE_URL="http://127.0.0.1:$port"
export RC_STATE_PATH="$root/private-state.json"
jwt="$(openssl rand -hex 40)"
chmod 700 "$root"
mkdir -m 700 "$root/data" "$root/restore"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  # Production images can create root-owned 0700 subdirectories (e.g. jobs).
  # Clean only THIS mktemp volume as container root, never touch host paths.
  docker run --rm --entrypoint /bin/sh -v "$root:/rc" "$RC_IMAGE" \
    -c 'rm -rf /rc/data /rc/restore' >/dev/null 2>&1 || true
  rm -rf -- "$root" || true
}
trap cleanup EXIT
start() {
  local folder="$1"
  docker run --detach --name "$name" \
    -p "127.0.0.1:$port:3001" -v "$folder:/app/data" \
    -e NODE_ENV=production -e PORT=3001 -e DB_PATH=/app/data/nowen-note.db \
    -e JWT_SECRET="$jwt" -e DISABLE_MDNS=1 \
    -e BACKUP_AUTO_ENABLED=false -e CALENDAR_EXPORT_TIMER_DISABLED=1 \
    "$RC_IMAGE" > /dev/null
  local healthy=0
  for i in $(seq 1 100); do
    if curl --silent --fail "$RC_BASE_URL/api/health" >/dev/null; then healthy=1; break; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" = false ]; then break; fi
    sleep 2
  done
  if [ "$healthy" != 1 ]; then
    echo "STUDIO_CONTAINER_START_FAILED (image/health)" >&2
    # Avoid dumping logs because unexpected upstream output could contain secrets.
    return 1
  fi
}
stop() { docker rm -f "$name" >/dev/null; }
start "$root/data"
node scripts/studio-rc-runtime-smoke.mjs seed
docker exec --workdir /app/backend "$name" node -e "
  const DB=require('better-sqlite3'),db=new DB('/app/data/nowen-note.db');
  db.backup('/app/data/studio-rc-snapshot.db')
    .then(()=>{db.close();console.log('STUDIO_WAL_BACKUP_PASS')})
    .catch(()=>{db.close();console.error('STUDIO_WAL_BACKUP_FAIL');process.exitCode=1});
"
test -s "$root/data/studio-rc-snapshot.db"
cp "$root/data/studio-rc-snapshot.db" "$root/restore/nowen-note.db"
docker run --rm --entrypoint node --workdir /app/backend -v "$root/restore:/app/data" "$RC_IMAGE" -e "
  const DB=require('better-sqlite3');
  const db=new DB('/app/data/nowen-note.db',{readonly:true,fileMustExist:true});
  if(db.pragma('quick_check',{simple:true})!=='ok')process.exit(1);
  if(db.prepare('SELECT COUNT(*) AS n FROM personal_studio_apps').get().n!==1)process.exit(1);
  if(db.prepare('SELECT COUNT(*) AS n FROM personal_studio_app_versions').get().n!==3)process.exit(1);
  db.close();
  console.log('STUDIO_BACKUP_CONTENT_PASS');
"
stop
start "$root/data"
node scripts/studio-rc-runtime-smoke.mjs verify
stop
start "$root/restore"
node scripts/studio-rc-runtime-smoke.mjs verify
echo "STUDIO_PRODUCTION_DOCKER_RC_PASS: image, REST/ACL, restart, WAL backup, independent recovery"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Nowen Studio production Docker RC"
    echo "- Immutable image source: ${GITHUB_SHA:-local}"
    echo "- Production auth and REST CRUD/CAS/history/ACL: passed"
    echo "- Actual container restart and WAL-safe independent SQLite restore: passed"
    echo "- NOT assessed: physical NAS/Android, real AI credentials, Electron app launch, notarization/signature, updates"
    echo "- No deployment, tags or releases."
  } >> "$GITHUB_STEP_SUMMARY"
fi
