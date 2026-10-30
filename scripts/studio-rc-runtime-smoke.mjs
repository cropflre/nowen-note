#!/usr/bin/env node
/**
 * RC-only black-box smoke against the REAL production HTTP server.
 * Never points at production accounts: the workflow supplies a disposable
 * localhost server, disposable database, and a private (unpublished) state file.
 *
 * RC_BASE_URL=http://127.0.0.1:<ephemeral port>
 * RC_STATE_PATH=<private temporary file>
 * node scripts/studio-rc-runtime-smoke.mjs seed|verify
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const url = process.env.RC_BASE_URL || "";
const statePath = process.env.RC_STATE_PATH || "";
const stage = process.argv[2];
if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(url) || !path.isAbsolute(statePath) || !["seed","verify","legacy-seed","legacy-verify"].includes(stage)) {
  console.error("RC_RUNTIME_INPUT_INVALID: local disposable URL, absolute state path, seed|verify|legacy-seed|legacy-verify required");
  process.exit(2);
}
const dataKey = "RC persistent record " + randomBytes(8).toString("hex");

async function request(route, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const headers = { ...options.headers };
    if (options.token) headers.Authorization = "Bearer " + options.token;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const result = await fetch(url + route, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const payload = await result.json().catch(() => null);
    return { status: result.status, payload };
  } finally { clearTimeout(timeout); }
}
function status(response, expected, context) {
  assert.equal(response.status, expected, context + " HTTP response status (observed=" + response.status + ", code=" + (response.payload?.code || "none") + ")");
  return response.payload;
}
async function login(username, password) {
  const response = await request("/api/auth/login", {method:"POST",body:{username,password}});
  const body = status(response, 200, "login");
  assert.equal(typeof body?.token,"string");
  return body.token;
}
// The published v1.5.3 tag predates personal Studio routes. Seed its stable
// notebook and note APIs first, then validate them against the upgraded image.
const legacyStatePath = statePath + ".legacy";
async function seedLegacy() {
  const suffix = randomBytes(6).toString("hex");
  const alice = "rclegacy_a_" + suffix;
  const bob = "rclegacy_b_" + suffix;
  const password = randomBytes(20).toString("base64url");
  const noteContent = "Legacy v1.5.3 note " + randomBytes(10).toString("hex");
  const user = status(await request("/api/auth/register", {
    method: "POST", body: { username: alice, password },
  }), 201, "old version register A");
  const foreign = status(await request("/api/auth/register", {
    method: "POST", body: { username: bob, password },
  }), 201, "old version register B");
  const nb = status(await request("/api/notebooks", {
    method: "POST", token: user.token, body: { name: "Historical upgrade regression" },
  }), 201, "old version create notebook");
  const note = status(await request("/api/notes", {
    method: "POST", token: user.token,
    body: { title: "Legacy retained note", notebookId: nb.id, contentFormat: "markdown", content: noteContent },
  }), 201, "old version create note");
  status(await request("/api/notes/" + note.id, { token: foreign.token }), 404, "old version foreign note read");
  fs.writeFileSync(legacyStatePath, JSON.stringify({ alice, bob, password, notebookId: nb.id, noteId: note.id, noteContent }), {
    flag: "wx", mode: 0o600,
  });
  console.log("STUDIO_LEGACY_153_SEED_PASS: accounts, notebook, note and ACL");
}
async function verifyLegacy() {
  const { alice, bob, password, notebookId, noteId, noteContent } =
    JSON.parse(fs.readFileSync(legacyStatePath, "utf8"));
  const token = await login(alice, password);
  const foreign = await login(bob, password);
  const note = status(await request("/api/notes/" + noteId, { token }), 200, "upgraded legacy note");
  assert.equal(note.id, noteId);
  assert.equal(note.notebookId, notebookId);
  assert.equal(note.title, "Legacy retained note");
  assert.ok(String(note.content).includes(noteContent), "legacy note body survives upgrade");
  status(await request("/api/notes/" + noteId, { token: foreign }), 404, "upgraded legacy ACL");
  console.log("STUDIO_LEGACY_153_VERIFY_PASS: login, note content and ACL survived upgrade");
}
// v1.5.4 contains the stable note APIs, but not the experimental personal
// Studio application routes reserved for a later version. Keep upgrade/restore
// coverage strict without requiring an unpublished product surface.
async function seed() {
  assert.equal((await request("/api/health")).status, 200, "container must be healthy");
  assert.equal((await request("/api/notes")).status, 401, "unauthorized notes request must fail");
  const suffix = randomBytes(6).toString("hex");
  const alice = "rca_" + suffix;
  const bob = "rcb_" + suffix;
  const password = randomBytes(20).toString("base64url");
  const first = status(await request("/api/auth/register", {
    method: "POST", body: { username: alice, password },
  }), 201, "candidate register A");
  const second = status(await request("/api/auth/register", {
    method: "POST", body: { username: bob, password },
  }), 201, "candidate register B");
  assert.equal(typeof first.token, "string");
  assert.equal(typeof second.token, "string");
  const notebook = status(await request("/api/notebooks", {
    method: "POST", token: first.token, body: { name: "RC persistence fixture" },
  }), 201, "candidate create notebook");
  const record = dataKey;
  const note = status(await request("/api/notes", {
    method: "POST", token: first.token,
    body: { title: "RC initial note", notebookId: notebook.id, contentFormat: "markdown", content: record },
  }), 201, "candidate create note");
  assert.equal(typeof note.id, "string");
  assert.ok(Number.isSafeInteger(note.version) && note.version >= 1, "new note has a version");
  status(await request("/api/notes/" + note.id, { token: second.token }), 404, "cross-user read denied");
  const changed = status(await request("/api/notes/" + note.id, {
    method: "PUT", token: first.token,
    body: { version: note.version, title: "RC updated note", content: record + " updated" },
  }), 200, "candidate update note");
  assert.equal(changed.version, note.version + 1, "note optimistic version increments");
  status(await request("/api/notes/" + note.id, {
    method: "PUT", token: first.token, body: { version: note.version, title: "stale write" },
  }), 409, "stale note write rejected");
  status(await request("/api/notes/" + note.id, {
    method: "PUT", token: second.token, body: { version: changed.version, title: "foreign write" },
  }), 403, "cross-user write denied");
  fs.writeFileSync(statePath, JSON.stringify({ alice, bob, password, noteId: note.id, notebookId: notebook.id, record, version: changed.version }), {
    flag: "wx", mode: 0o600,
  });
  console.log("STUDIO_PRODUCTION_SEED_PASS: candidate notes CRUD, optimistic concurrency and ownership");
}
async function verify() {
  const { alice, bob, password, noteId, notebookId, record, version } = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal((await request("/api/health")).status, 200);
  const token = await login(alice, password);
  const foreign = await login(bob, password);
  const stored = status(await request("/api/notes/" + noteId, { token }), 200, "persistent candidate note");
  assert.equal(stored.notebookId, notebookId);
  assert.equal(stored.title, "RC updated note");
  assert.ok(String(stored.content).includes(record + " updated"), "edited note content survives snapshot");
  assert.equal(stored.version, version, "note optimistic version survives restart");
  status(await request("/api/notes/" + noteId, { token: foreign }), 404, "cross-user note read denied");
  status(await request("/api/notes/" + noteId, {
    method: "PUT", token: foreign, body: { version, title: "foreign overwrite" },
  }), 403, "cross-user note write denied");
  console.log("STUDIO_PRODUCTION_REOPEN_PASS: note content, version, per-user ACL and snapshot recovery");
}
try {
  if (stage === "legacy-seed") await seedLegacy();
  else if (stage === "legacy-verify") await verifyLegacy();
  else if (stage === "seed") await seed();
  else { await verifyLegacy(); await verify(); }
} catch (error) {
  // Do not print JWT/password/response body. Assertion messages here are synthetic.
  console.error("STUDIO_PRODUCTION_SMOKE_FAILED:", error instanceof Error ? error.message : "unknown");
  process.exitCode=1;
}
