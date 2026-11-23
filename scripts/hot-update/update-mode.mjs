#!/usr/bin/env node
// 生成发布说明里的「更新方式」：本版能不能通过热更新送达已安装的客户端。
//
//   node scripts/hot-update/update-mode.mjs --since v1.6.1 [--ref HEAD] [--json]
//
// --since 是上一个正式版的 Tag，--ref 是本次发版的提交。比较的是 git 提交，与工作区改动无关。
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT } from "./build-bundles.mjs";
import { gitTreeReader } from "./lib/fingerprint.mjs";
import { compareReleases, renderUpdateMode } from "./lib/update-mode.mjs";

function main() {
  const { values } = parseArgs({
    options: { since: { type: "string" }, ref: { type: "string", default: "HEAD" }, repo: { type: "string" }, json: { type: "boolean", default: false } },
  });
  if (!values.since) throw new Error("需要 --since <上一个正式版的 Tag>，例如 --since v1.6.1");
  const repo = values.repo ? path.resolve(values.repo) : DEFAULT_REPO_ROOT;
  const result = compareReleases(gitTreeReader(repo, values.since), gitTreeReader(repo, values.ref));
  if (Object.values(result).some((item) => item.mode === "unavailable")) {
    console.error(
      `[hot-update] 注意：${values.ref} 的 hot-update/public-keys.json 里没有公钥，这个提交打出的安装包不接受任何热更新。` +
        "发第一个带热更新能力的整包之前，先按 docs/architecture/hot-update.md「一次性准备」生成密钥并提交公钥。",
    );
  }
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else process.stdout.write(renderUpdateMode(result, { previousVersion: values.since.replace(/^v/, "") }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`[hot-update] ${error.message}`);
    process.exitCode = 1;
  }
}
