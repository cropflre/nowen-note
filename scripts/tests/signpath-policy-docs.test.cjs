const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
const privacy = fs.readFileSync(path.join(repoRoot, "docs", "PRIVACY.md"), "utf8");

test("README exposes the SignPath Foundation code signing policy", () => {
  assert.match(readme, /^## Code signing policy$/m);
  assert.match(readme, /Free code signing provided by SignPath\.io, certificate by SignPath Foundation/);
  assert.match(readme, /\*\*Authors:\*\* \[cropflre\]\(https:\/\/github\.com\/cropflre\)/);
  assert.match(readme, /\*\*Reviewers:\*\* \[cropflre\]\(https:\/\/github\.com\/cropflre\)/);
  assert.match(readme, /\*\*Approvers:\*\* \[cropflre\]\(https:\/\/github\.com\/cropflre\)/);
  assert.match(readme, /GitHub Actions/);
  assert.match(readme, /\[隐私政策\]\(\.\/docs\/PRIVACY\.md\)/);
  assert.match(readme, /首个 SignPath 签名版本/);
  assert.match(readme, /应用内自动更新/);
});

test("privacy policy covers desktop updates and user-configured remote services", () => {
  assert.match(privacy, /^# Nowen Note 隐私权政策$/m);
  assert.match(privacy, /桌面端与服务端/);
  assert.match(privacy, /自动更新.*官方 GitHub Release/);
  assert.match(privacy, /AI 服务/);
  assert.match(privacy, /对象存储/);
  assert.match(privacy, /WebDAV/);
  assert.match(privacy, /邮件/);
  assert.match(privacy, /远程 Nowen Note 服务/);
  assert.match(privacy, /不会把用户笔记、账号、附件或配置发送给 SignPath/);
  assert.match(privacy, /SignPath.*GitHub Actions.*构建产物/);
  assert.match(privacy, /HTTPS/);
  assert.match(privacy, /卸载/);
  assert.match(privacy, /第三方服务/);
  assert.match(privacy, /Nowen Note Web Clipper/);
});
