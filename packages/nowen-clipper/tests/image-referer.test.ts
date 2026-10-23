import assert from "node:assert/strict";
import test from "node:test";
import { clearImageRefererRule, installImageRefererRule } from "../src/lib/image-referer";

interface RecordedCall {
  removeRuleIds?: number[];
  addRules?: Array<{
    id: number;
    action: { type: string; requestHeaders: Array<{ header: string; operation: string; value: string }> };
    condition: { requestDomains?: string[]; resourceTypes: string[] };
  }>;
}

function stubChrome(fail = false): RecordedCall[] {
  const calls: RecordedCall[] = [];
  (globalThis as any).chrome = {
    declarativeNetRequest: {
      RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
      HeaderOperation: { SET: "set" },
      ResourceType: { XMLHTTPREQUEST: "xmlhttprequest", IMAGE: "image" },
      updateSessionRules: async (options: RecordedCall) => {
        if (fail) throw new Error("boom");
        calls.push(options);
      },
    },
  };
  return calls;
}

test("为每个图片域名安装一条 Referer 规则并去重", async () => {
  const calls = stubChrome();
  const rule = await installImageRefererRule("https://www.example.com/post/1", [
    "https://cdn.example.com/a.png",
    "https://cdn.example.com/b.png",
    "https://img.example.net/c.png",
  ]);

  assert.equal(rule.referer, "https://www.example.com");
  assert.equal(rule.ids.length, 2);
  assert.equal(calls.length, 1);

  const [first, second] = calls[0].addRules ?? [];
  assert.deepEqual(first.condition.requestDomains, ["cdn.example.com"]);
  assert.deepEqual(first.action.requestHeaders, [
    { header: "referer", operation: "set", value: "https://www.example.com/" },
  ]);
  assert.deepEqual(first.condition.resourceTypes, ["xmlhttprequest", "image"]);
  assert.deepEqual(second.condition.requestDomains, ["img.example.net"]);
  assert.deepEqual(calls[0].removeRuleIds, rule.ids);
});

test("页面地址不可用时不下发任何规则", async () => {
  const calls = stubChrome();
  const rule = await installImageRefererRule("chrome://extensions", ["https://cdn.example.com/a.png"]);

  assert.equal(rule.referer, "");
  assert.deepEqual(rule.ids, []);
  assert.equal(calls.length, 0);
});

test("规则安装失败时降级为空句柄，不阻断图片下载", async () => {
  stubChrome(true);
  const rule = await installImageRefererRule("https://www.example.com/post/1", [
    "https://cdn.example.com/a.png",
  ]);

  assert.equal(rule.referer, "https://www.example.com");
  assert.deepEqual(rule.ids, []);
});

test("清理时按规则 ID 删除 session 规则", async () => {
  const calls = stubChrome();
  await clearImageRefererRule({ ids: [910_000, 910_001], referer: "https://www.example.com" });
  await clearImageRefererRule({ ids: [], referer: "" });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].removeRuleIds, [910_000, 910_001]);
});
