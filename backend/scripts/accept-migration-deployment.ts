/** Run against an isolated compiled backend, never an existing user data directory.
 * node migration-deployment.cjs /absolute/backend/dist /new-writable-parent
 * Intended for a Linux container with matching production native dependencies.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";

async function main() {
  const [distArg, parent] = process.argv.slice(2);
  assert.ok(distArg && path.isAbsolute(distArg) && parent && path.isAbsolute(parent), "Pass an absolute compiled dist and isolated writable parent");
  const dist = fs.realpathSync(distArg), directory = fs.mkdtempSync(path.join(parent, "migration-deployment-"));
  const started = performance.now(), secret = crypto.randomBytes(48).toString("hex");
  Object.assign(process.env, { NODE_ENV: "test", JWT_SECRET: secret, DB_PATH: path.join(directory, "fixture.db"), ELECTRON_USER_DATA: directory, ATTACHMENT_STORAGE: "local", NOWEN_LOCAL_FIRST_SYNC_V2: "1" });
  const load = (name: string) => require(path.join(dist, name));
  load("runtime/knowledge-tree-migration-bootstrap.js");
  const schema = load("db/schema.js"), db = schema.getDb();
  const tokens = load("lib/api-tokens.js"); tokens.initApiTokensTable(db);
  const userId = "deployment-owner", otherId = "deployment-other", sessionId = crypto.randomUUID(), otherSession = crypto.randomUUID();
  for (const [id, session] of [[userId, sessionId], [otherId, otherSession]]) {
    db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'isolated-fixture')").run(id, id);
    db.prepare("INSERT INTO user_sessions(id,userId,expiresAt) VALUES (?,?,?)").run(session, id, new Date(Date.now() + 3_600_000).toISOString());
  }
  const target = load("services/knowledgeTree.js").createKnowledgeChild({ actorUserId: userId, workspaceId: null, parentId: null, nodeType: "folder", title: "Deployment fixture", db });
  const pat = tokens.generateApiTokenRaw(), tokenId = crypto.randomUUID();
  db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes,resourceMode) VALUES (?,?,?, ?,?,'restricted')")
    .run(tokenId, userId, "isolated acceptance", tokens.hashApiToken(pat), JSON.stringify(["export:import", "notes:read", "notes:write", "notebooks:read", "notebooks:write", "attachments:write", "tags:write"]));
  db.prepare("INSERT INTO api_token_resources(id,tokenId,resourceId,permission,includeDescendants) VALUES (?,?,?,'write',1)").run(crypto.randomUUID(), tokenId, target.resourceId);
  schema.closeDb();
  const owner = jwt.sign({ userId, tver: 0, jti: sessionId }, secret, { expiresIn: "1h" });
  const other = jwt.sign({ userId: otherId, tver: 0, jti: otherSession }, secret, { expiresIn: "1h" });
  const backendPort = await new Promise<number>((resolve) => { const probe = net.createServer(); probe.listen(0, "127.0.0.1", () => { const port = (probe.address() as net.AddressInfo).port; probe.close(() => resolve(port)); }); });
  let child: ChildProcess | undefined, logs = "", restarts = 0, dropNextChunkAck = false, lostAcks = 0, proxyRequests = 0;
  const stop = async (signal: NodeJS.Signals) => { if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill(signal); await closed; } };
  const launch = async () => {
    child = spawn(process.execPath, ["--max-old-space-size=192", path.join(dist, "index.hardened.js")], {
      env: { ...process.env, NODE_ENV: "production", PORT: String(backendPort) }, stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (data: Buffer) => { logs = (logs + data.toString()).slice(-100_000); };
    child.stdout!.on("data", capture); child.stderr!.on("data", capture);
    const deadline = Date.now() + 30_000;
    while (true) {
      try { if ((await fetch(`http://127.0.0.1:${backendPort}/api/health`)).ok) return; } catch { /* startup */ }
      assert.ok(Date.now() < deadline && child.exitCode === null && child.signalCode === null, "Compiled backend failed to start");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const proxy = http.createServer((request, response) => {
    proxyRequests++;
    if (!request.url?.startsWith("/nowen/api/")) { response.writeHead(404).end(); return; }
    const drop = dropNextChunkAck && request.method === "PUT" && request.url.includes("/chunks?");
    if (drop) dropNextChunkAck = false;
    const upstream = http.request({ hostname: "127.0.0.1", port: backendPort, method: request.method, path: request.url.slice("/nowen".length), headers: { ...request.headers, host: `127.0.0.1:${backendPort}`, "x-forwarded-prefix": "/nowen" } }, (received) => {
      if (drop && received.statusCode === 200) {
        received.resume(); received.on("end", () => { lostAcks++; response.destroy(); }); return;
      }
      response.writeHead(received.statusCode || 502, received.headers); received.pipe(response);
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on("error", () => upstream.destroy()); request.pipe(upstream);
  });
  try {
    await launch(); proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
    const base = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}/nowen/api`;
    const request = async (suffix: string, bearer = pat, body?: unknown, method?: string) => {
      const response = await fetch(base + suffix, { method: method || (body === undefined ? "GET" : "POST"), headers: { Authorization: `Bearer ${bearer}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() as any };
    };
    const inputPath = path.join(directory, "input.zip"), archive = archiver("zip", { zlib: { level: 1 } });
    const output = pipeline(archive, fs.createWriteStream(inputPath));
    for (let index = 0; index < 100; index++) archive.append(`# Deployment ${index}\nIsolated source ${index}.${index < 13 ? `\n[PDF](../assets/${index}.pdf)` : ""}\n`, { name: `notes/${index}.md` });
    const sourceHashes = new Map<string, string>();
    for (let index = 0; index < 13; index++) {
      const hash = crypto.createHash("sha256");
      async function* blocks() {
        const header = Buffer.from("%PDF-1.7\n"); hash.update(header); yield header;
        for (let remaining = 8 * 1024 * 1024 - header.length; remaining > 0;) { const bytes = crypto.randomBytes(Math.min(64 * 1024, remaining)); remaining -= bytes.length; hash.update(bytes); yield bytes; }
        sourceHashes.set(`${index}.pdf`, hash.digest("hex"));
      }
      archive.append(Readable.from(blocks()), { name: `assets/${index}.pdf` });
    }
    await archive.finalize(); await output;
    const sha = crypto.createHash("sha256"); for await (const bytes of fs.createReadStream(inputPath)) sha.update(bytes);
    const size = fs.statSync(inputPath).size;
    const created = await request("/migrations", pat, { operationId: crypto.randomUUID(), source: { platform: "files", exportId: crypto.randomUUID() }, targetNotebookId: target.resourceId, name: "Deployment acceptance" });
    assert.equal(created.status, 201);
    const jobPath = `/migrations/${created.value.id}`;
    assert.equal((await request(jobPath, other)).status, 404);
    const opened = await request(`${jobPath}/upload-sessions`, pat, { operationId: crypto.randomUUID(), filename: "input.zip", size, sha256: sha.digest("hex") });
    assert.equal(opened.status, 201); const uploadPath = `${jobPath}/upload-sessions/${opened.value.id}`;
    const readChunk = async (offset: number) => { const handle = await fs.promises.open(inputPath, "r"); try { const bytes = Buffer.alloc(Math.min(4 * 1024 * 1024, size - offset)); const result = await handle.read(bytes, 0, bytes.length, offset); assert.equal(result.bytesRead, bytes.length); return bytes; } finally { await handle.close(); } };
    const put = async (offset: number) => {
      const bytes = await readChunk(offset);
      const response = await fetch(`${base}${uploadPath}/chunks?offset=${offset}`, { method: "PUT", headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/octet-stream", "X-Chunk-SHA256": crypto.createHash("sha256").update(bytes).digest("hex") }, body: bytes });
      assert.equal(response.status, 200); return await response.json() as { offset: number };
    };
    dropNextChunkAck = true; await assert.rejects(put(0), TypeError);
    assert.equal((await request(uploadPath)).value.offset, 4 * 1024 * 1024);
    assert.equal((await put(0)).offset, 4 * 1024 * 1024, "lost ACK replay must not append bytes");
    assert.equal((await put(4 * 1024 * 1024)).offset, 8 * 1024 * 1024);
    await stop("SIGKILL"); await launch(); restarts++;
    assert.equal((await request(uploadPath)).value.offset, 8 * 1024 * 1024, "confirmed offset survives process crash");
    for (let offset = 8 * 1024 * 1024; offset < size;) offset = (await put(offset)).offset;
    assert.equal((await request(`${uploadPath}/complete`, pat, {})).status, 202);
    const waitJob = async (predicate: (job: any) => boolean) => {
      const deadline = Date.now() + 60_000;
      while (true) { const result = await request(jobPath, owner); assert.equal(result.status, 200); if (predicate(result.value)) return result.value;
        assert.ok(!["FAILED", "PARTIAL", "CANCELLED"].includes(result.value.status), `Migration ended ${result.value.status}`);
        assert.ok(Date.now() < deadline, "Migration progress timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
    };
    await waitJob((job) => job.status === "CREATED");
    const preview = await request(`${jobPath}/preview`, pat, {}); assert.equal(preview.status, 200);
    assert.equal(preview.value.counts.total, 100); assert.equal(preview.value.counts.imported, 0);
    assert.equal((await request(`${jobPath}/approve`, pat, { previewDigest: preview.value.previewDigest })).status, 403);
    assert.equal((await request(`${jobPath}/approve`, owner, { previewDigest: preview.value.previewDigest })).status, 202);
    await waitJob((job) => job.counts.imported >= 5);
    const beforeCrash = (await request(`${jobPath}/report?limit=100`, owner)).value.items.filter((item: any) => item.status === "IMPORTED").map((item: any) => item.targetNoteId);
    assert.ok(beforeCrash.length > 0 && beforeCrash.length < 100);
    await stop("SIGKILL"); await launch(); restarts++;
    const completed = await waitJob((job) => job.status === "COMPLETED"); assert.equal(completed.counts.imported, 100);
    const reader = new Database(process.env.DB_PATH!, { readonly: true, fileMustExist: true });
    let downloaded = 0;
    try {
      const notes = reader.prepare("SELECT id,content,version FROM notes WHERE userId=? AND isTrashed=0").all(userId) as { id: string; content: string; version: number }[];
      assert.equal(notes.length, 100); assert.equal(new Set(notes.map((note) => note.id)).size, 100);
      assert.ok(beforeCrash.every((id: string) => notes.some((note) => note.id === id)));
      for (const note of notes) {
        assert.ok(note.version >= 1); assert.match(note.content, /Isolated source \d+/);
        const response = await fetch(`${base}/notes/${note.id}`, { headers: { Authorization: `Bearer ${owner}` } });
        assert.equal(response.status, 200); assert.match(JSON.stringify(await response.json()), /Isolated source/);
      }
      const attachments = reader.prepare("SELECT id,filename,size,hash FROM attachments WHERE userId=?").all(userId) as { id: string; filename: string; size: number; hash: string }[];
      assert.equal(attachments.length, 13);
      for (const asset of attachments) {
        assert.equal(asset.hash, sourceHashes.get(asset.filename));
        const response = await fetch(`${base}/sync/v2/blob/${asset.id}?scopeKey=personal`, { headers: { Authorization: `Bearer ${owner}` } });
        assert.equal(response.status, 200); const digest = crypto.createHash("sha256"); let bytes = 0;
        assert.ok(response.body); for await (const chunk of response.body) { digest.update(chunk); bytes += chunk.length; }
        assert.equal(bytes, asset.size); assert.equal(digest.digest("hex"), asset.hash); downloaded += bytes;
      }
    } finally { reader.close(); }
    const cgroup = (name: string) => { try { return fs.readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim(); } catch { return null; } };
    console.log("MIGRATION_DEPLOYMENT_RESULT " + JSON.stringify({ status: "passed", node: process.version, platform: `${process.platform}/${process.arch}`, entry: "tsc/index.hardened.js", proxyPrefix: "/nowen", proxyRequests, lostAcks, crashRestarts: restarts, confirmedUploadOffsetAfterCrash: 8 * 1024 * 1024, notes: 100, attachments: 13, assetBytes: 13 * 8 * 1024 * 1024, zipBytes: size, downloadedBytes: downloaded, importedBeforeCrash: beforeCrash.length, duplicateNotes: 0, patApprovalRejected: true, crossUserDenied: true, totalSeconds: +((performance.now() - started) / 1000).toFixed(2), cgroup: { memoryMax: cgroup("memory.max"), memoryPeak: cgroup("memory.peak"), memoryEvents: cgroup("memory.events") } }));
  } catch (error) {
    const redact = (text: string) => [secret, owner, other, pat].reduce((value, credential) => value.split(credential).join("<synthetic-credential>"), text);
    console.error(redact(String(error))); console.error(redact(logs.slice(-6000))); throw new Error("Isolated deployment acceptance failed");
  } finally {
    await stop("SIGTERM"); proxy.closeAllConnections(); if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Deployment acceptance failed"); process.exitCode = 1; });
