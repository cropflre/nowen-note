import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { localizeRemoteImages } from "../src/lib/image-localizer";
import { withImageReferer } from "../src/lib/image-referer";

function stubChrome(t: TestContext) {
  const previous = globalThis.chrome;
  const active = new Map<number, chrome.declarativeNetRequest.Rule>();
  const state = { failInstall: false, failCleanup: false };
  (globalThis as any).chrome = {
    runtime: { getURL: () => "chrome-extension://clipper-test/" },
    declarativeNetRequest: {
      RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
      HeaderOperation: { SET: "set" },
      ResourceType: { XMLHTTPREQUEST: "xmlhttprequest", IMAGE: "image" },
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
        if (addRules.length ? state.failInstall : state.failCleanup) throw new Error("unavailable");
        for (const id of removeRuleIds) active.delete(id);
        for (const rule of addRules) active.set(rule.id, rule);
      },
    },
  };
  t.after(() => { (globalThis as any).chrome = previous; });
  return { active, state };
}

function image() {
  return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
}

test("Referer rules only match this extension's background fetches and deduplicate hostnames", async (t) => {
  const { active } = stubChrome(t);
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(active.size, 1);
    const [rule] = active.values();
    assert.deepEqual(rule.condition.requestDomains, ["cdn.example"]);
    assert.deepEqual(rule.condition.initiatorDomains, ["clipper-test"]);
    assert.deepEqual(rule.condition.tabIds, [-1]);
    assert.deepEqual(rule.condition.resourceTypes, ["xmlhttprequest"]);
    assert.equal(rule.action.requestHeaders?.[0].value, "https://article.example/");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.referrerPolicy, "no-referrer");
    return image();
  });
  const result = await localizeRemoteImages(
    '<img src="https://cdn.example:8443/a.png"><img src="https://cdn.example/b.png">',
    { pageUrl: "https://article.example/private?token=secret" },
  );
  assert.equal(result.ok, 2);
  assert.match(result.html, /data:image\/png;base64,AQID/);
  assert.equal(active.size, 0);
});

test("concurrent clips sharing a CDN keep their own Referer until download and cleanup finish", async (t) => {
  const { active } = stubChrome(t);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const referers: string[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    referers.push([...active.values()][0].action.requestHeaders![0].value!);
    if (referers.length === 1) {
      started();
      await blocked;
    }
    return image();
  });
  const html = '<img src="https://cdn.example/shared.png">';
  const first = localizeRemoteImages(html, { pageUrl: "https://a.example/post" });
  await firstStarted;
  const second = localizeRemoteImages(html, { pageUrl: "https://b.example/post" });
  try {
    await new Promise(setImmediate);
    assert.deepEqual(referers, ["https://a.example/"]);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  assert.deepEqual(referers, ["https://a.example/", "https://b.example/"]);
  assert.equal(active.size, 0);
});

test("missing DNR API does not claim that a Referer was configured", async (t) => {
  stubChrome(t);
  (globalThis as any).chrome.declarativeNetRequest = undefined;
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 403 }));
  const result = await localizeRemoteImages('<img src="https://cdn.example/a.png">', {
    pageUrl: "https://article.example/post",
  });
  assert.equal(result.failures[0].error, "HTTP 403");
});

test("failed rule installation preserves the image URL without a false Referer hint", async (t) => {
  const { active, state } = stubChrome(t);
  state.failInstall = true;
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 403 }));
  const html = '<img src="https://cdn.example/a.png">';
  const result = await localizeRemoteImages(html, { pageUrl: "https://article.example/post" });
  assert.equal(result.html, html);
  assert.equal(result.failures[0].error, "HTTP 403");
  assert.equal(active.size, 0);
});

test("failed image downloads clean up Referer rules and preserve the original source", async (t) => {
  const { active } = stubChrome(t);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("timeout.png")) throw new DOMException("timeout", "AbortError");
    return new Response("", { status: 403 });
  });
  const html = '<img src="https://cdn.example/denied.png"><img src="https://cdn.example/timeout.png">';
  const result = await localizeRemoteImages(html, { pageUrl: "https://article.example/post" });
  assert.equal(result.html, html);
  assert.equal(result.failed, 2);
  assert.match(result.failures[0].error, /HTTP 403.*已配置/);
  assert.match(result.failures[1].error, /下载超时/);
  assert.equal(active.size, 0);
});

test("a clip without a page URL clears an abandoned rule before downloading", async (t) => {
  const { active, state } = stubChrome(t);
  state.failCleanup = true;
  t.mock.method(globalThis, "fetch", async () => image());
  const html = '<img src="https://cdn.example/a.png">';
  await localizeRemoteImages(html, { pageUrl: "https://article.example/post" });
  assert.equal(active.size, 1);
  state.failCleanup = false;
  t.mock.method(globalThis, "fetch", async () => {
    assert.equal(active.size, 0);
    return image();
  });
  const result = await localizeRemoteImages(html);
  assert.equal(result.ok, 1);
  assert.equal(active.size, 0);
});

test("private image URLs remain blocked before rules or requests are created", async (t) => {
  const { active } = stubChrome(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => image());
  const html = '<img src="http://127.0.0.1/private.png">';
  const result = await localizeRemoteImages(html, { pageUrl: "https://article.example/post" });
  assert.equal(result.failed, 1);
  assert.equal(result.html, html);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(active.size, 0);
});

test("unusable page origins never install a Referer rule", async (t) => {
  const { active } = stubChrome(t);
  t.mock.method(globalThis, "fetch", async () => {
    assert.equal(active.size, 0);
    return image();
  });
  for (const pageUrl of ["", "file:///private/note.html", "not a URL"]) {
    const result = await localizeRemoteImages('<img src="https://cdn.example/a.png">', { pageUrl });
    assert.equal(result.ok, 1);
  }
});

test("an unexpected download failure cleans up rules and does not stall later clips", async (t) => {
  const { active } = stubChrome(t);
  await assert.rejects(withImageReferer("https://a.example/post", ["https://cdn.example/a.png"], async () => {
    throw new Error("download failed");
  }), /download failed/);
  assert.equal(active.size, 0);
  t.mock.method(globalThis, "fetch", async () => image());
  const result = await localizeRemoteImages('<img src="https://cdn.example/a.png">', {
    pageUrl: "https://b.example/post",
  });
  assert.equal(result.ok, 1);
  assert.equal(active.size, 0);
});
