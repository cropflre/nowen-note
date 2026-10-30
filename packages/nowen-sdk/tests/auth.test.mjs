import test from "node:test";
import assert from "node:assert/strict";
import { NowenClient } from "../dist/index.js";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("login, 2FA, token verify and diary timeline use the backend contracts", async () => {
  const calls = [];
  const client = new NowenClient({ baseUrl: "https://test.invalid", username: "", password: "", fetch: async (url, init) => {
    calls.push({url, init});
    if (url.endsWith("/auth/login")) return json({requires2FA:true, ticket:"ticket-B", username:"B"});
    if (url.endsWith("/auth/2fa/verify")) return json({token:"token-B"});
    if (url.endsWith("/auth/verify")) return json({user:{id:"B", username:"B"}});
    return json({items:[], hasMore:false, nextCursor:null});
  }});
  assert.deepEqual(await client.login("B","secret"), {requires2FA:true, ticket:"ticket-B", username:"B"});
  assert.deepEqual(await client.verifyTwoFactor("ticket-B","123456"), {token:"token-B"});
  assert.equal((await client.verifyToken()).user.id, "B");
  assert.deepEqual(await client.listDiaries({limit:5,cursor:"cursor"}), {items:[],hasMore:false,nextCursor:null});
  assert.equal(calls[3].url, "https://test.invalid/api/diary/timeline?cursor=cursor&limit=5");
  assert.equal(calls[3].init.headers.Authorization, "Bearer token-B");
});

test("public setToken authenticates attachment calls without a password login", async () => {
  const calls = [];
  const client = new NowenClient({baseUrl:"https://test.invalid", username:"", password:"", fetch:async(url,init)=> {
    calls.push({url, init});
    if(url.endsWith("/auth/login")) return json({error:"missing credentials"},400);
    return json({files:[]});
  }});
  client.setToken("token-B");
  await client.listAttachments();
  assert.equal(calls.length,1);
  assert.equal(calls[0].init.headers.Authorization,"Bearer token-B");
});

test("account switch keeps note and attachment requests on the same account", async () => {
  const calls = [];
  const client = new NowenClient({baseUrl:"https://test.invalid",username:"A",password:"secret-A",fetch:async(url,init)=> {
    calls.push({url,init});
    if(url.endsWith("/auth/login")) return json({token:`token-${JSON.parse(init.body).username}`});
    return json([]);
  }});
  await client.login("B","secret-B");
  await client.listNotebooks();
  await client.listAttachments();
  assert.equal(calls.at(-1).init.headers.Authorization,"Bearer token-B");
});

test("starting a 2FA account switch invalidates the previous token", async () => {
  const client = new NowenClient({baseUrl:"https://test.invalid",username:"A",password:"secret-A",fetch:async(url,init)=> {
    if(url.endsWith("/auth/login")) {
      const {username} = JSON.parse(init.body);
      return username === "B" ? json({requires2FA:true,ticket:"ticket-B",username:"B"}) : json({token:"token-A"});
    }
    return json([]);
  }});
  await client.login();
  await client.login("B","secret-B");
  assert.equal(client.getToken(),null);
});

test("expired 2FA token cannot silently reauthenticate as the previous account", async () => {
  const calls = [];
  const client = new NowenClient({baseUrl:"https://test.invalid",username:"A",password:"secret-A",fetch:async(url,init)=> {
    calls.push({url,init,authorization:init.headers?.Authorization});
    if(url.endsWith("/auth/login")) {
      const {username} = JSON.parse(init.body);
      return username === "B" ? json({requires2FA:true,ticket:"ticket-B",username:"B"}) : json({token:"token-A"});
    }
    if(url.endsWith("/auth/2fa/verify")) return json({token:"token-B"});
    return init.headers.Authorization === "Bearer token-B" ? json({error:"expired"},401) : json([]);
  }});
  await client.login("B","secret-B");
  await client.verifyTwoFactor("ticket-B","123456");
  await assert.rejects(client.listNotebooks());
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("token-only auth covers direct attachment access and upload, and clearing it stops all requests", async () => {
  const calls = [];
  const client = new NowenClient({ baseUrl: "https://test.invalid", fetch: async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.headers.Authorization, "Bearer token-B");
    assert.ok(!url.endsWith("/auth/login"));
    return json({ id: "attachment-B", items: [] });
  }});
  client.setToken("token-B");
  await client.attachments.listAttachments();
  await client.uploadAttachment({ file: new Uint8Array([1]), filename: "photo.png", noteId: "note-B" });
  assert.ok(calls[1].init.body instanceof FormData);
  client.setToken(null);
  await assert.rejects(client.listNotebooks(), /未登录/);
  await assert.rejects(client.attachments.listAttachments(), /未登录/);
  assert.equal(calls.length, 2);
});

test("pending 2FA stops both clients and exposes a reusable challenge without repeated login", async () => {
  const calls = [];
  const client = new NowenClient({ baseUrl: "https://test.invalid", username: "B", password: "secret-B", fetch: async (url) => {
    calls.push(url);
    return json({ requires2FA: true, ticket: "ticket-B", username: "B" });
  }});
  const { TwoFactorRequiredError } = await import("../dist/index.js");
  for (const request of [() => client.listNotebooks(), () => client.listAttachments()]) {
    await assert.rejects(request(), (error) => {
      assert.ok(error instanceof TwoFactorRequiredError);
      assert.equal(error.result.ticket, "ticket-B");
      return true;
    });
  }
  assert.deepEqual(calls, ["https://test.invalid/api/auth/login"]);
  assert.equal(client.getToken(), null);
});

test("wrong 2FA code can be retried but a previous account ticket is rejected", async () => {
  let attempts = 0;
  const client = new NowenClient({ baseUrl: "https://test.invalid", fetch: async (url) => {
    if (url.endsWith("/auth/login")) return json({ requires2FA: true, ticket: "ticket-B", username: "B" });
    return ++attempts === 1 ? json({ error: "invalid code" }, 401) : json({ token: "token-B" });
  }});
  await client.login("B", "secret-B");
  await assert.rejects(client.verifyTwoFactor("ticket-A", "123456"), /不属于当前登录/);
  await assert.rejects(client.verifyTwoFactor("ticket-B", "000000"), /401/);
  await client.verifyTwoFactor("ticket-B", "recovery-code");
  assert.equal(client.getToken(), "token-B");
  assert.equal(attempts, 2);
});

test("concurrent core and attachment requests share one password login", async () => {
  let logins = 0;
  const client = new NowenClient({ baseUrl: "https://test.invalid", username: "B", password: "secret-B", fetch: async (url, init) => {
    if (url.endsWith("/auth/login")) {
      logins++;
      await Promise.resolve();
      return json({ token: "token-B" });
    }
    assert.equal(init.headers.Authorization, "Bearer token-B");
    return json({ items: [] });
  }});
  await Promise.all([client.listNotebooks(), client.listAttachments(), client.attachments.listAttachments()]);
  assert.equal(logins, 1);
});

for (const method of ["listNotebooks", "listAttachments"]) {
  test(`${method}: external token 401 never falls back to constructor credentials`, async () => {
    const calls = [];
    const client = new NowenClient({ baseUrl: "https://test.invalid", username: "A", password: "secret-A", fetch: async (url) => {
      calls.push(url);
      return json({ error: "expired" }, 401);
    }});
    client.setToken("token-B");
    await assert.rejects(client[method](), /未登录/);
    assert.equal(client.getToken(), null);
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].endsWith("/auth/login"));
  });

  test(`${method}: normal password auth still retries one 401 as the same account`, async () => {
    const calls = [];
    let logins = 0;
    const client = new NowenClient({ baseUrl: "https://test.invalid", username: "B", password: "secret-B", fetch: async (url, init) => {
      calls.push({ url, token: init.headers.Authorization });
      if (url.endsWith("/auth/login")) {
        assert.equal(JSON.parse(init.body).username, "B");
        return json({ token: `token-B-${++logins}` });
      }
      return init.headers.Authorization === "Bearer token-B-1" ? json({}, 401) : json({ items: [] });
    }});
    await client[method]();
    assert.deepEqual(calls.map((call) => call.token), [undefined, "Bearer token-B-1", undefined, "Bearer token-B-2"]);
    assert.equal(client.getToken(), "token-B-2");
  });

  test(`${method}: a delayed 401 cannot replay a request under a newly selected account`, async () => {
    const response = deferred();
    const started = deferred();
    let requests = 0;
    const client = new NowenClient({ baseUrl: "https://test.invalid", fetch: async () => {
      requests++;
      started.resolve();
      return response.promise;
    }});
    client.setToken("token-A");
    const request = client[method]();
    const rejected = assert.rejects(request, /认证状态已变更/);
    await started.promise;
    client.setToken("token-B");
    response.resolve(json({}, 401));
    await rejected;
    assert.equal(client.getToken(), "token-B");
    assert.equal(requests, 1);
  });
}

test("delayed password login cannot replace a newer external token", async () => {
  const response = deferred();
  const client = new NowenClient({ baseUrl: "https://test.invalid", fetch: async () => response.promise });
  const rejected = assert.rejects(client.login("A", "secret-A"), /认证状态已变更/);
  client.setToken("token-B");
  response.resolve(json({ token: "token-A" }));
  await rejected;
  assert.equal(client.getToken(), "token-B");
});

test("delayed 2FA verification cannot replace a newer external token", async () => {
  const response = deferred();
  const client = new NowenClient({ baseUrl: "https://test.invalid", fetch: async (url) => {
    return url.endsWith("/auth/login") ? json({ requires2FA: true, ticket: "ticket-A", username: "A" }) : response.promise;
  }});
  await client.login("A", "secret-A");
  const rejected = assert.rejects(client.verifyTwoFactor("ticket-A", "123456"), /认证状态已变更/);
  client.setToken("token-B");
  response.resolve(json({ token: "token-A" }));
  await rejected;
  assert.equal(client.getToken(), "token-B");
});

test("failed login for a new account removes the previous token", async () => {
  const client = new NowenClient({ baseUrl: "https://test.invalid", fetch: async () => json({ error: "bad password" }, 401) });
  client.setToken("token-A");
  await assert.rejects(client.login("B", "wrong-password"), /401/);
  assert.equal(client.getToken(), null);
});

test("authentication never accepts a missing token or challenge ticket as success", async () => {
  for (const payload of [{}, { requires2FA: true }]) {
    const client = new NowenClient({ baseUrl: "https://test.invalid", fetch: async () => json(payload) });
    await assert.rejects(client.login("B", "secret-B"), /缺少/);
    assert.equal(client.getToken(), null);
  }
});

test("default fetch is bound for both the public and standalone attachment clients", async () => {
  const { NowenAttachmentClient } = await import("../dist/index.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (url) {
    assert.equal(this, globalThis);
    return url.endsWith("/auth/login") ? json({ token: "token-B" }) : json({ items: [] });
  };
  try {
    const config = { baseUrl: "https://test.invalid", username: "B", password: "secret-B" };
    const client = new NowenClient(config);
    await client.listNotebooks();
    await client.listAttachments();
    await new NowenAttachmentClient(config).listAttachments();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("switching account between attachment reads and note write stops the entire association", async () => {
  const noteResponse = deferred();
  const started = deferred();
  const calls = [];
  const client = new NowenClient({ baseUrl: "https://test.invalid", fetch: async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith("/files/attachment-A")) {
      return json({ id: "attachment-A", filename: "a.png", category: "image", mimeType: "image/png" });
    }
    started.resolve();
    return noteResponse.promise;
  }});
  client.setToken("token-A");
  const rejected = assert.rejects(client.attachToNote({ attachmentId: "attachment-A", noteId: "note-A" }), /认证状态已变更/);
  await started.promise;
  client.setToken("token-B");
  noteResponse.resolve(json({ id: "note-A", content: "body from A", contentFormat: "markdown", version: 1 }));
  await rejected;
  assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
  assert.equal(client.getToken(), "token-B");
});

test("attachment association still works when a read refreshes the same account token", async () => {
  let logins = 0;
  let expired = false;
  const client = new NowenClient({ baseUrl: "https://test.invalid", username: "A", password: "secret-A", fetch: async (url, init) => {
    if (url.endsWith("/auth/login")) return json({ token: `token-A-${++logins}` });
    if (url.endsWith("/files/attachment-A")) return json({ id: "attachment-A", filename: "a.png", category: "image", mimeType: "image/png" });
    if (init.method === "GET") {
      if (!expired) {
        expired = true;
        return json({}, 401);
      }
      return json({ id: "note-A", content: "body", contentFormat: "markdown", version: 1 });
    }
    assert.equal(init.headers.Authorization, "Bearer token-A-2");
    return json({ id: "note-A", version: 2 });
  }});
  assert.equal((await client.attachToNote({ attachmentId: "attachment-A", noteId: "note-A" })).version, 2);
  assert.equal(logins, 2);
});

test("two competing 2FA completions cannot overwrite the first accepted token", async () => {
  const lateResponse = deferred();
  let attempts = 0;
  const client = new NowenClient({ baseUrl: "https://test.invalid", fetch: async (url) => {
    if (url.endsWith("/auth/login")) return json({ requires2FA: true, ticket: "ticket-A", username: "A" });
    return ++attempts === 1 ? lateResponse.promise : json({ token: "token-new" });
  }});
  await client.login("A", "secret-A");
  const rejected = assert.rejects(client.verifyTwoFactor("ticket-A", "123456"), /认证状态已变更/);
  await client.verifyTwoFactor("ticket-A", "123456");
  lateResponse.resolve(json({ token: "token-old" }));
  await rejected;
  assert.equal(client.getToken(), "token-new");
});

for (const [name, action] of [
  ["note write", (client) => client.updateNote("note-A", { content: "body from A", version: 1 })],
  ["attachment upload", (client) => client.uploadAttachment({ filename: "a.png", file: new Uint8Array([1]), noteId: "note-A" })],
]) {
  test(`${name}: delayed 401 after account switch never retries the mutation as the new user`, async () => {
    const response = deferred();
    const started = deferred();
    const calls = [];
    const client = new NowenClient({ baseUrl: "https://test.invalid", fetch: async (url, init) => {
      calls.push({ url, token: init.headers.Authorization, method: init.method });
      started.resolve();
      return response.promise;
    }});
    client.setToken("token-A");
    const rejected = assert.rejects(action(client), /认证状态已变更/);
    await started.promise;
    client.setToken("token-B");
    response.resolve(json({}, 401));
    await rejected;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].token, "Bearer token-A");
    assert.equal(client.getToken(), "token-B");
  });
}
