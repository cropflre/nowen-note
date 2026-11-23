#!/usr/bin/env node
// R2 渠道地址（hot/stable/<target>/<runtimeVersion>.json）只能向前移动。
//
//   node scripts/hot-update/pointer.mjs key --file <签名清单>
//       输出该清单对应的渠道地址 key
//   node scripts/hot-update/pointer.mjs decide --next <新签名清单> [--current <现有渠道文件>]
//       输出 update 或 skip；重跑旧版本的发布流程不会把渠道指回旧版本
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT } from "./build-bundles.mjs";
import { loadTrustedKeys } from "./lib/keys.mjs";
import { channelPointerKey, openEnvelope } from "./lib/manifest.mjs";

export function decidePointer({ currentBytes, nextBytes, trustedKeys }) {
  const next = openEnvelope(nextBytes, trustedKeys).manifest;
  if (!currentBytes || currentBytes.length === 0) return { action: "update", reason: "渠道地址还不存在" };
  let current;
  try {
    current = openEnvelope(currentBytes, trustedKeys).manifest;
  } catch (error) {
    return { action: "update", reason: `现有渠道文件无效（${error.message}），用已验证的新清单替换` };
  }
  if (current.target !== next.target || current.runtimeVersion !== next.runtimeVersion) {
    throw new Error("现有渠道文件的 target/runtimeVersion 与新清单不一致，拒绝覆盖");
  }
  if (current.bundleId === next.bundleId) return { action: "skip", reason: `渠道已指向 ${next.bundleId}` };
  if (next.sequence > current.sequence) return { action: "update", reason: `${current.bundleId} → ${next.bundleId}` };
  if (next.sequence === current.sequence) throw new Error(`同一 sequence 出现两个不同的包：${current.bundleId} / ${next.bundleId}`);
  return { action: "skip", reason: `渠道已指向更新的 ${current.bundleId}，不回退到 ${next.bundleId}` };
}

async function readOptional(file) {
  if (!file) return null;
  return readFile(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function main() {
  const [command] = process.argv.slice(2);
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { file: { type: "string" }, next: { type: "string" }, current: { type: "string" }, keys: { type: "string" } },
  });
  const trustedKeys = await loadTrustedKeys(values.keys ? path.resolve(values.keys) : path.join(DEFAULT_REPO_ROOT, "hot-update/public-keys.json"));
  if (command === "key") {
    if (!values.file) throw new Error("需要 --file");
    const { manifest } = openEnvelope(await readFile(values.file), trustedKeys);
    console.log(channelPointerKey(manifest.target, manifest.runtimeVersion));
    return;
  }
  if (command === "decide") {
    if (!values.next) throw new Error("需要 --next");
    const decision = decidePointer({ currentBytes: await readOptional(values.current), nextBytes: await readFile(values.next), trustedKeys });
    console.error(`[hot-update] pointer ${decision.action}: ${decision.reason}`);
    console.log(decision.action);
    return;
  }
  throw new Error("用法：pointer.mjs key|decide ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[hot-update] ${error.message}`);
    process.exitCode = 1;
  });
}
