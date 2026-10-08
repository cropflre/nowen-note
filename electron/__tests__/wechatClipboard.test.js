const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readWechatArticleClipboard } = require("../wechat-clipboard");
const read = (text) => readWechatArticleClipboard({ readText: () => text });
test("only returns public WeChat article links and removes reading credentials", () => {
  assert.equal(read("private https://mp.weixin.qq.com/s/article?key=secret&uin=123#x"), "https://mp.weixin.qq.com/s/article");
  assert.equal(read("https://mp.weixin.qq.com/mp/profile_ext?key=secret https://mp.weixin.qq.com.evil/s/a https://password@mp.weixin.qq.com/s/a"), "");
  assert.equal(read("https://example.com/secret"), "");
});
test("bounds clipboard batches and removes duplicates", () => {
  assert.equal(read("https://mp.weixin.qq.com/s/a?scene=1 https://mp.weixin.qq.com/s/a?scene=2"), "https://mp.weixin.qq.com/s/a");
  assert.equal(read("x".repeat(16385)), "");
  assert.equal(read(Array.from({ length: 21 }, (_, i) => `https://mp.weixin.qq.com/s/a${i}`).join("\n")), "");
});
