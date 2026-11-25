import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { BUILD_TARGETS, expectedArtifacts, normalizeBuild } from "../lib/release-cloud-contract.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const load = (name) => yaml.load(fs.readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"));
const sha = "a".repeat(40);
const id = "21ca8625-56db-467f-a27b-e2b2e5addcd9";

test("hot 是可单独勾选的构建目标，产物名为 release-hot", () => {
  assert.ok(BUILD_TARGETS.includes("hot"));
  const request = normalizeBuild({ version: "1.6.2", commit_sha: sha, request_id: id, targets: "pc,android,hot" });
  assert.deepEqual(request.targets, ["windows", "macos", "linux", "android", "hot"]);
  assert.ok(expectedArtifacts(request).includes("release-hot"));
  assert.ok(!expectedArtifacts(normalizeBuild({ version: "1.6.2", commit_sha: sha, request_id: id, targets: "pc" })).includes("release-hot"));
});

test("构建工作流：hot job 同源构建、签名、按源码复核，再进入产物清单", () => {
  const workflow = load("release-build.yml");
  const hot = workflow.jobs.hot;
  assert.equal(hot.needs, "plan");
  assert.match(hot.if, /'hot'/);
  const runs = hot.steps.map((step) => step.run || "").join("\n");
  assert.match(runs, /npm run build:all/);
  assert.match(runs, /build-bundles\.mjs --out release-hot --version "\$RC_VERSION"/);
  assert.match(runs, /verify\.mjs --dir release-hot --version "\$RC_VERSION" --commit "\$RC_SHA" --check-runtime/);
  const sign = hot.steps.find((step) => /sign\.mjs/.test(step.run || ""));
  assert.equal(sign.env.NOWEN_HOT_UPDATE_PRIVATE_KEY, "${{ secrets.NOWEN_HOT_UPDATE_PRIVATE_KEY }}");
  // 私钥只出现在签名这一步
  for (const step of hot.steps) if (step !== sign) assert.doesNotMatch(JSON.stringify(step), /NOWEN_HOT_UPDATE_PRIVATE_KEY/);
  const upload = hot.steps.find((step) => step.uses?.startsWith("actions/upload-artifact"));
  assert.equal(upload.with.name, "release-hot");
  assert.ok(workflow.jobs.manifest.needs.includes("hot"));
  const plan = workflow.jobs.plan.steps.find((step) => step.id === "plan");
  assert.equal(plan.env.RC_HOT_UPDATE_SIGNING_READY, "${{ secrets.NOWEN_HOT_UPDATE_PRIVATE_KEY != '' }}");
  assert.ok(workflow.jobs.plan.steps.some((step) => /npm run test:hot-update/.test(step.run || "")));
});

test("发布工作流：GitHub Release 成功后才同步热更新渠道", () => {
  const workflow = load("release-publish.yml");
  const job = workflow.jobs["r2-hot-update"];
  assert.deepEqual(job.needs, ["verify", "github"]);
  assert.match(job.if, /needs\.github\.result == 'success'/);
  assert.equal(job.uses, "./.github/workflows/sync-r2-hot-update.yml");
  assert.equal(job.with.tag, "v${{ inputs.version }}");
  assert.equal(job.secrets, "inherit");
  // 原有任务的依赖关系不变
  assert.deepEqual(workflow.jobs.gitee.needs, ["verify", "github", "r2-downloads"]);
});

test("R2 热更新同步：按 Tag 源码复核，只写 hot/ 前缀，渠道地址只向前移动", () => {
  const workflow = load("sync-r2-hot-update.yml");
  assert.equal(workflow.on.workflow_call.inputs.tag.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency.group, "r2-hot-update");
  const steps = workflow.jobs.publish.steps;
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout"));
  assert.equal(checkout.with.ref, "${{ inputs.tag }}");
  const runs = steps.map((step) => step.run || "").join("\n");
  assert.match(runs, /verify\.mjs --dir hot-files --version "\$\{TAG#v\}" --check-runtime/);
  assert.match(runs, /pointer\.mjs decide --next "\$envelope" --current current\.json/);
  assert.match(runs, /pointer\.mjs key --file "\$envelope"/);
  assert.match(runs, /draft == false and \.prerelease == false/);
  assert.match(runs, /R2 object differs from immutable GitHub release/);
  assert.match(runs, /readback mismatch/);
  const upload = steps.find((step) => step.name === "Upload bundles, then move channel pointers forward").run;
  const keys = [...upload.matchAll(/^\s*key="([^"]+)"/gm)].map((match) => match[1]);
  assert.ok(keys.length > 0 && keys.every((key) => key.startsWith("hot/")), keys.join(","));
  assert.doesNotMatch(upload, /--clobber|DELETE/);
  for (const step of steps) {
    if (step.if !== undefined) assert.equal(step.if, "steps.assets.outputs.present == 'true'", step.name);
  }
});

test("桌面候选构建：每个平台打包后核对安装包里的热更新锚点，再整理候选产物", () => {
  const steps = load("release-center-candidate.yml").jobs.build.steps;
  const index = (pattern) => steps.findIndex((step) => pattern.test(step.run || ""));
  const verify = index(/^node scripts\/hot-update\/verify-desktop-anchors\.mjs$/);
  assert.ok(verify > 0, "缺少热更新锚点核对");
  assert.equal(steps[verify].if, undefined, "三个平台都要核对");
  const lastPackage = steps.reduce((last, step, position) => (/electron-builder --config electron\/builder\.config\.js/.test(step.run || "") ? position : last), -1);
  assert.ok(lastPackage >= 0 && verify > lastPackage, "核对要在所有 electron-builder 打包之后");
  assert.ok(verify < index(/release-center-stage-candidate\.mjs/), "核对要在整理候选产物之前");
});

test("热更新 CI 覆盖脚本、配置和相关工作流的改动", () => {
  const workflow = load("hot-update-ci.yml");
  // 发版分支是直接推送的，不经过 PR，所以 release/** 的推送也要跑。
  assert.deepEqual(workflow.on.push.branches, ["main", "release/**"]);
  for (const trigger of [workflow.on.push, workflow.on.pull_request]) {
    for (const path of ["hot-update/**", "scripts/hot-update/**", ".github/workflows/sync-r2-hot-update.yml", ".github/workflows/release-center-candidate.yml", "backend/build.bundle.mjs"]) {
      assert.ok(trigger.paths.includes(path), path);
    }
  }
  const runs = workflow.jobs["hot-update"].steps.map((step) => step.run || "").join("\n");
  assert.match(runs, /npm run test:hot-update/);
});
