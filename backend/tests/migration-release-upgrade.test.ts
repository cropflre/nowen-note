import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";

const backendRoot = path.resolve(__dirname, ".."), repositoryRoot = path.resolve(backendRoot, "..");
const histories = [{ mode: "p0", commit: "fb93d4932639c3967b883e416b1233b8b65198b0", schema: 142, entry: "bundle" },
  { mode: "p1", commit: "3c486e395f54101f7b4eb825f62d5f937776063f", schema: 145, entry: "tsc" }] as const;
const historyAvailable = histories.every(({ commit }) => spawnSync("git", ["cat-file", "-e", `${commit}:backend/src/services/migrationService.ts`], { cwd: repositoryRoot }).status === 0);

async function child(command: string, args: string[], options: Parameters<typeof spawn>[2] = {}) {
  return new Promise<void>((resolve, reject) => {
    const process = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; process.stdout?.on("data", (chunk) => { output += chunk; }); process.stderr?.on("data", (chunk) => { output += chunk; });
    process.once("error", reject); process.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Fixture/build process exited ${code}: ${output.slice(-1500)}`)));
  });
}
async function stop(server: ChildProcess) {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM"); await new Promise((resolve) => server.once("close", resolve));
}

for (const historical of histories) {
  test(`DCC-003: actual ${historical.mode.toUpperCase()} database upgrades through the ${historical.entry} entry without losing notes, Outbox or approval boundaries`, { skip: !historyAvailable && "Requires P0/P1 git history; fetch the acceptance commits", timeout: 60_000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-migration-upgrade-"));
    const snapshot = path.join(directory, "historical"), artifact = path.join(directory, "artifact"), state = path.join(directory, "state");
    fs.mkdirSync(snapshot); fs.mkdirSync(state); fs.mkdirSync(path.join(artifact, "backend"), { recursive: true });
    const receiptPath = path.join(state, "fixture.json"), dbPath = path.join(state, "test.db"), secret = "isolated-upgrade-fixture-jwt-secret";
    const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", ELECTRON_USER_DATA: state, DB_PATH: dbPath, JWT_SECRET: secret, NOWEN_LOCAL_FIRST_SYNC_V2: "1", AUTO_BACKUP_ENABLED: "false" };
    delete environment.NODE_TEST_CONTEXT;
    let server: ChildProcess | undefined;
    try {
      const archive = spawnSync("git", ["archive", "--format=tar", historical.commit, "backend/src", "backend/package.json"], { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 });
      assert.equal(archive.status, 0);
      assert.equal(spawnSync("tar", ["-xf", "-", "-C", snapshot], { input: archive.stdout }).status, 0);
      fs.symlinkSync(path.join(backendRoot, "node_modules"), path.join(snapshot, "backend/node_modules"), "dir");
      await child(process.execPath, ["--import", "tsx", path.join(__dirname, "fixtures/migration-upgrade-process.ts"), snapshot, historical.mode, receiptPath], { cwd: backendRoot, env: environment });
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
      assert.equal(receipt.schemaVersion, historical.schema); assert.ok(receipt.originalOutbox.length > 0);
      if (historical.mode === "p0") assert.ok(receipt.importedIds.length >= 5 && receipt.importedIds.length < 30);

      fs.copyFileSync(path.join(repositoryRoot, "package.json"), path.join(artifact, "package.json"));
      fs.copyFileSync(path.join(backendRoot, "package.json"), path.join(artifact, "backend/package.json"));
      fs.symlinkSync(path.join(backendRoot, "node_modules"), path.join(artifact, "backend/node_modules"), "dir");
      fs.symlinkSync(path.join(backendRoot, "templates"), path.join(artifact, "backend/templates"), "dir");
      if (historical.entry === "bundle") {
        assert.ok(fs.existsSync(path.join(backendRoot, "dist/index.js")), "Run backend npm run build before release-upgrade acceptance");
        fs.mkdirSync(path.join(artifact, "backend/dist"));
        for (const name of ["index.js", "runner-child.mjs", "sandbox-child.mjs"]) fs.copyFileSync(path.join(backendRoot, "dist", name), path.join(artifact, "backend/dist", name));
      } else {
        await child(process.execPath, [path.join(backendRoot, "node_modules/typescript/bin/tsc"), "-p", path.join(backendRoot, "tsconfig.json"), "--outDir", path.join(artifact, "backend/dist"), "--declaration", "false"], { cwd: backendRoot, env: environment });
        fs.copyFileSync(path.join(backendRoot, "src/plugins/runner-child.mjs"), path.join(artifact, "backend/dist/plugins/runner-child.mjs"));
        fs.copyFileSync(path.join(backendRoot, "src/plugins/sandbox-child.mjs"), path.join(artifact, "backend/dist/plugins/sandbox-child.mjs"));
      }
      assert.ok(!fs.existsSync(path.join(artifact, "backend/src")), "packaged entry must work without source fallback");
      const port = await new Promise<number>((resolve) => { const listener = net.createServer(); listener.listen(0, "127.0.0.1", () => { const address = listener.address() as net.AddressInfo; listener.close(() => resolve(address.port)); }); });
      const base = `http://127.0.0.1:${port}/api`, entry = path.join(artifact, "backend/dist", historical.entry === "bundle" ? "index.js" : "index.hardened.js");
      const login = jwt.sign({ userId: receipt.userId, tver: 0, jti: receipt.sessionId }, secret, { expiresIn: "1h" });
      const request = async (suffix: string, method = "GET", body?: unknown, token = login) => {
        const response = await fetch(base + suffix, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, value: await response.json() as any };
      };
      let output = "";
      const start = async () => {
        server = spawn(process.execPath, [entry], { cwd: artifact, env: { ...environment, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
        server.stdout?.on("data", (chunk) => { output += chunk; }); server.stderr?.on("data", (chunk) => { output += chunk; });
        const deadline = Date.now() + 15_000;
        while (true) {
          try { if ((await fetch(base + "/health")).ok) break; } catch { /* waiting for isolated process */ }
          assert.ok(server.exitCode === null && Date.now() < deadline, output.slice(-2000));
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
      const wait = async (id: string, status: string) => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const response = await request(`/migrations/${id}`); assert.equal(response.status, 200);
          if (response.value.status === status) return response.value;
          assert.ok(!["FAILED", "PARTIAL", "CANCELLED"].includes(response.value.status), JSON.stringify(response.value));
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.fail(`Migration did not reach ${status}`);
      };
      await start();
      assert.equal((await request("/migrations/capabilities")).value.adapterApiVersion, 1);
      const prepared = await request(`/migrations/${receipt.pendingJobId}`);
      assert.equal(prepared.value.status, "PREVIEW_READY"); assert.equal(prepared.value.counts.imported, 0);
      assert.equal((await request(`/migrations/${receipt.pendingJobId}/approve`, "POST", { previewDigest: receipt.pendingDigest }, receipt.tokenRaw)).status, 403);
      let resumedOffset = 0;
      if (historical.mode === "p0") await wait(receipt.recoveryJobId, "COMPLETED");
      else {
        const uploadPath = `/migrations/${receipt.recoveryJobId}/upload-sessions/${receipt.uploadId}`;
        const session = await request(uploadPath); assert.equal(session.status, 200); assert.equal(session.value.status, "OPEN");
        resumedOffset = session.value.offset; assert.equal(resumedOffset, 4 * 1024 * 1024);
        const bytes = fs.readFileSync(receipt.sourceFile), tail = bytes.subarray(resumedOffset);
        const response = await fetch(base + uploadPath + `/chunks?offset=${resumedOffset}`, { method: "PUT", headers: { Authorization: `Bearer ${receipt.tokenRaw}`, "Content-Type": "application/octet-stream", "X-Chunk-SHA256": crypto.createHash("sha256").update(tail).digest("hex") }, body: tail });
        assert.equal(response.status, 200); assert.equal((await response.json() as any).offset, bytes.length);
        assert.equal((await request(uploadPath + "/complete", "POST", {}, receipt.tokenRaw)).status, 202);
        const scanned = await wait(receipt.recoveryJobId, "CREATED"); assert.equal(scanned.counts.imported, 0);
        const preview = await request(`/migrations/${receipt.recoveryJobId}/preview`, "POST", {}, receipt.tokenRaw); assert.equal(preview.status, 200);
        assert.equal((await request(`/migrations/${receipt.recoveryJobId}/approve`, "POST", { previewDigest: preview.value.previewDigest }, receipt.tokenRaw)).status, 403);
        assert.equal((await request(`/migrations/${receipt.recoveryJobId}/approve`, "POST", { previewDigest: preview.value.previewDigest })).status, 202);
        await wait(receipt.recoveryJobId, "COMPLETED");
      }
      await stop(server!); server = undefined;
      const verify = () => {
        const db = new Database(dbPath, { readonly: true });
        try {
          assert.equal((db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version, 145);
          assert.deepEqual(db.prepare("SELECT id,title,content,version FROM notes WHERE id=?").get(receipt.existing.id), receipt.existing);
          for (const original of receipt.originalOutbox) assert.deepEqual(db.prepare("SELECT mutationId,entityType,entityId,payload,baseVersion FROM sync_outbox WHERE mutationId=?").get(original.mutationId), original);
          for (const original of receipt.importedIds) assert.ok(db.prepare("SELECT 1 FROM notes WHERE id=? AND isTrashed=0").get(original.targetNoteId));
          const imported = (db.prepare("SELECT COUNT(*) AS n FROM migration_items WHERE jobId=? AND status='IMPORTED'").get(receipt.recoveryJobId) as { n: number }).n;
          assert.equal(imported, historical.mode === "p0" ? 30 : 1);
          assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notes WHERE userId=?").get(receipt.userId) as { n: number }).n, imported + 1);
          return imported;
        } finally { db.close(); }
      };
      const imported = verify();
      await start(); await wait(receipt.recoveryJobId, "COMPLETED"); await stop(server!); server = undefined; verify();
      assert.ok(!output.includes(receipt.tokenRaw));
      console.log("[migration-upgrade] " + JSON.stringify({ historicalCommit: historical.commit, fromSchema: historical.schema, toSchema: 145, packagedEntry: historical.entry, imported,
        priorImportedIdsRetained: receipt.importedIds.length, originalPendingMutationsRetained: receipt.originalOutbox.length, resumedOffset, unapprovedPreviewImported: 0, repeatRestartDuplicates: 0, sourceFallback: false }));
    } finally { if (server) await stop(server); fs.rmSync(directory, { recursive: true, force: true }); }
  });
}
