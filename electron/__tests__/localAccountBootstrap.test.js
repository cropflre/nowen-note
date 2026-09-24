const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { requestLocalAccountBootstrap } = require("../localAccountBootstrap");

const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const start = source.indexOf("async function ensureLocalAccount()");
const end = source.indexOf("async function resetLocalAccountAuth()", start);
const startup = source.slice(start, end);

test("startup uses non-destructive bootstrap, not the password-reset recovery endpoint", () => {
  assert.ok(start >= 0 && end > start);
  assert.match(startup, /requestLocalAccountBootstrap\(localApiRequest, password, localAccountCreationAllowed\)/);
  assert.match(source, /localAccountCreationAllowed = !fs\.existsSync\(dbPath\)/);
  assert.doesNotMatch(startup, /provisionLocalAdminAccount|\/auth\/desktop\/reset-local|\/auth\/login/);
  assert.match(source, /!localAuthBootstrapSucceeded\) return null/);
});

test("bootstrap never retries or resets for auth and transport failures", async () => {
  for (const status of [401, 403, 409, 423, 429, 500]) {
    let calls = 0;
    const result = await requestLocalAccountBootstrap(async (route) => {
      calls++;
      assert.equal(route, "/auth/desktop/bootstrap-local");
      return { status, data: { code: `status-${status}` } };
    }, "test-secret", false);
    assert.equal(result.account, null);
    assert.equal(result.reason, `status-${status}`);
    assert.equal(calls, 1);
  }
  const offline = await requestLocalAccountBootstrap(async () => {
    throw new Error("connection refused");
  }, "test-secret", false);
  assert.deepEqual(offline, { account: null, reason: "BACKEND_UNAVAILABLE" });
});

test("bootstrap allows creation only when the database was absent before startup", async () => {
  const requests = [];
  const request = async (route, body, headers) => {
    requests.push({ route, body, headers });
    return { status: 200, data: { token: "token", user: { role: "admin" } } };
  };
  assert.ok((await requestLocalAccountBootstrap(request, "test-secret", false)).account);
  assert.ok((await requestLocalAccountBootstrap(request, "test-secret", true)).account);
  assert.equal(requests[0].headers["X-Nowen-Desktop-Allow-Create"], "0");
  assert.equal(requests[1].headers["X-Nowen-Desktop-Allow-Create"], "1");
  assert.equal(requests[0].body, null);
});
