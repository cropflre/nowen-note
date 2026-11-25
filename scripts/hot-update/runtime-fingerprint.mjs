#!/usr/bin/env node
// 打印当前提交的壳指纹（runtimeVersion）。
//
//   node scripts/hot-update/runtime-fingerprint.mjs            # {"android":"e1-…","desktop":"e1-…"}
//   node scripts/hot-update/runtime-fingerprint.mjs --explain  # 连同参与计算的全部输入一起输出
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT } from "./build-bundles.mjs";
import { computeRuntimeVersions, gitTreeReader } from "./lib/fingerprint.mjs";

async function main() {
  const { values } = parseArgs({ options: { explain: { type: "boolean", default: false }, repo: { type: "string" }, revision: { type: "string" } } });
  const result = computeRuntimeVersions(gitTreeReader(values.repo ? path.resolve(values.repo) : DEFAULT_REPO_ROOT, values.revision || "HEAD"));
  const output = values.explain ? result : { android: result.android, desktop: result.desktop };
  console.log(JSON.stringify(output, null, values.explain ? 2 : 0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[hot-update] ${error.message}`);
    process.exitCode = 1;
  });
}
