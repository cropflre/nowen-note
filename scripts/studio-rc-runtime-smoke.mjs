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
if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(url) || !path.isAbsolute(statePath) || !["seed","verify"].includes(stage)) {
  console.error("RC_RUNTIME_INPUT_INVALID: local disposable URL, absolute state path, seed|verify required");
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
  assert.equal(response.status, expected, context + " HTTP response status");
  return response.payload;
}
function appSpec(record) {
  return {
    schemaVersion: 1, name: "RC Private Tracker", description: "Synthetic production runtime smoke",
    layout: "list",
    fields: [{ id: "title", label: "Title", type: "text" }, { id: "done", label: "Done", type: "checkbox" }],
    items: [{ id: "rc-record-1", values: { title: record, done: false } }],
  };
}
async function login(username, password) {
  const response = await request("/api/auth/login", {method:"POST",body:{username,password}});
  const body = status(response, 200, "login");
  assert.equal(typeof body?.token,"string");
  return body.token;
}
async function seed() {
  assert.equal((await request("/api/health")).status, 200, "container must be healthy");
  assert.equal((await request("/api/plugins/personal-apps")).status, 401, "unauthorized request must fail");
  const suffix = randomBytes(6).toString("hex");
  const alice = "rca_" + suffix;
  const bob = "rcb_" + suffix;
  const password = randomBytes(20).toString("base64url");
  let user = status(await request("/api/auth/register", {method:"POST",body:{username:alice,password}}), 201, "alice register");
  const aliceToken = user.token;
  user = status(await request("/api/auth/register", {method:"POST",body:{username:bob,password}}), 201, "bob register");
  const bobToken = user.token;
  assert.equal(typeof aliceToken,"string");
  assert.equal(typeof bobToken,"string");

  const record = dataKey;
  const created = status(await request("/api/plugins/personal-apps", { method:"POST", token:aliceToken, body:appSpec(record) }),201,"app create");
  assert.equal(created.revision,1);
  assert.ok(/^[a-f0-9-]{30,40}$/.test(created.id));

  const notOwned = await request("/api/plugins/personal-apps/" + created.id, {token:bobToken});
  status(notOwned,404,"foreign account cannot read app");
  assert.deepEqual(status(await request("/api/plugins/personal-apps", {token:bobToken}),200,"foreign app list"),[]);
  status(await request("/api/plugins/personal-apps/ai-preview",{method:"POST",token:aliceToken,body:{instruction:"Generate a board"}}),409,"unconfigured AI provider cannot be used");

  const modified = { ...appSpec(record), name:"RC Tracker Updated",layout:"board" };
  const changed = status(await request("/api/plugins/personal-apps/" + created.id, { method:"PUT",token:aliceToken,body:{expectedRevision:1,spec:modified} }),200,"revision update");
  assert.equal(changed.revision,2);
  status(await request("/api/plugins/personal-apps/" + created.id, { method:"PUT",token:aliceToken,body:{expectedRevision:1,spec:modified} }),409,"CAS conflict");
  const restored = status(await request("/api/plugins/personal-apps/" + created.id + "/restore",{method:"POST",token:aliceToken,body:{revision:1,expectedRevision:2}}),200,"version restore");
  assert.equal(restored.revision,3);
  assert.equal(restored.spec.items[0].values.title,record);
  assert.equal(restored.spec.name,"RC Private Tracker");
  const versions = status(await request("/api/plugins/personal-apps/" + created.id + "/versions",{token:aliceToken}),200,"history list");
  assert.deepEqual(versions.map(item=>item.revision),[3,2,1]);

  fs.writeFileSync(statePath,JSON.stringify({alice,bob,password,appId:created.id,record}),{flag:"wx",mode:0o600});
  console.log("STUDIO_PRODUCTION_SEED_PASS: authenticated REST CRUD, CAS, ownership, unconfigured AI and restore");
}
async function verify() {
  const {alice,bob,password,appId,record} = JSON.parse(fs.readFileSync(statePath,"utf8"));
  assert.equal((await request("/api/health")).status,200);
  const token = await login(alice,password);
  const foreign = await login(bob,password);
  const stored = status(await request("/api/plugins/personal-apps/" + appId,{token}),200,"persistent app");
  assert.equal(stored.revision,3,"restored revision survives restart or snapshot");
  assert.equal(stored.spec.items[0].values.title,record);
  assert.equal(stored.spec.items[0].values.done,false);
  assert.equal(stored.spec.name,"RC Private Tracker");
  assert.deepEqual(status(await request("/api/plugins/personal-apps/" + appId + "/versions",{token}),200,"durable history").map(x=>x.revision),[3,2,1]);
  status(await request("/api/plugins/personal-apps/" + appId,{token:foreign}),404,"cross-account read denied");
  status(await request("/api/plugins/personal-apps/" + appId + "/versions",{token:foreign}),404,"cross-account version list denied");
  status(await request("/api/plugins/personal-apps/" + appId + "/restore",{method:"POST",token:foreign,body:{revision:1,expectedRevision:3}}),404,"cross-account rollback denied");
  console.log("STUDIO_PRODUCTION_REOPEN_PASS: persisted values, per-user ACL, revision history and snapshot recovery");
}
try {
  if(stage==="seed") await seed(); else await verify();
} catch (error) {
  // Do not print JWT/password/response body. Assertion messages here are synthetic.
  console.error("STUDIO_PRODUCTION_SMOKE_FAILED:", error instanceof Error ? error.message : "unknown");
  process.exitCode=1;
}
