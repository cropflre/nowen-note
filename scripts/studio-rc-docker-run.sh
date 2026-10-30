#!/usr/bin/env bash
# This runs only against a fresh, disposable production Docker image and
# destroys test users, JWTs and databases on exit. No release/deployment steps.
set -euo pipefail
: "${RC_IMAGE:?Must supply immutable candidate Docker image tag}"
: "${RC_OLD_IMAGE:?Must supply the previous stable Docker image tag for upgrade testing}"
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
  local image="$2"
  docker run --detach --name "$name" \
    -p "127.0.0.1:$port:3001" -v "$folder:/app/data" \
    -e NODE_ENV=production -e PORT=3001 -e DB_PATH=/app/data/nowen-note.db \
    -e JWT_SECRET="$jwt" -e DISABLE_MDNS=1 \
    -e BACKUP_AUTO_ENABLED=false -e CALENDAR_EXPORT_TIMER_DISABLED=1 \
    "$image" > /dev/null
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
# Seed a real persistent database using the previous stable production image.
start "$root/data" "$RC_OLD_IMAGE"
node scripts/studio-rc-runtime-smoke.mjs legacy-seed
stop
# Upgrade only the image; keep the exact same bind-mounted data directory.
start "$root/data" "$RC_IMAGE"
node scripts/studio-rc-runtime-smoke.mjs legacy-verify
# Validate new v1.5.4 note writes, concurrency and ACL on the upgraded volume.
# Personal Studio routes are not part of this version's published API.
node scripts/studio-rc-runtime-smoke.mjs seed
node scripts/studio-rc-runtime-smoke.mjs verify
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
  // One historical note and one new candidate note must both survive the backup.
  if(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n!==2)process.exit(1);
  if(db.prepare('SELECT COUNT(*) AS n FROM notebooks').get().n!==2)process.exit(1);
  db.close();
  console.log('STUDIO_BACKUP_CONTENT_PASS');
"
stop
start "$root/data" "$RC_IMAGE"
node scripts/studio-rc-runtime-smoke.mjs verify
stop
start "$root/restore" "$RC_IMAGE"
node scripts/studio-rc-runtime-smoke.mjs verify
echo "STUDIO_PRODUCTION_DOCKER_RC_PASS: v1.5.3-to-v1.5.4 image upgrade, notes/CAS/ACL, restart, WAL backup, independent recovery"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Nowen Studio production Docker RC"
    echo "- Previous stable image: ${RC_OLD_IMAGE}"
    echo "- Candidate image source: ${GITHUB_SHA:-local} (${RC_IMAGE})"
    echo "- Same-volume v1.5.3 -> v1.5.4 container image upgrade: passed"
    echo "- Production auth, note CRUD/CAS and per-user ACL: passed"
    echo "- Actual container restart and WAL-safe independent SQLite restore: passed"
    echo "- NOT assessed: physical NAS/Android, real AI credentials, Electron app launch, notarization/signature, updates"
    echo "- No deployment, tags or releases."
  } >> "$GITHUB_STEP_SUMMARY"
fi
