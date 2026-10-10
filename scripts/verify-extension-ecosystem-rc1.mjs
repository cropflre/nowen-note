import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_OUTPUT, validateTrustRoots } from "./generate-official-registry-trust-roots.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(`Extension Ecosystem RC1 release gate failed: ${message}`);
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}${result.stderr || ""}`.trim();
    fail(`${path.relative(ROOT, script)} ${args.join(" ")} 失败${detail ? `\n${detail}` : ""}`);
  }
  return (result.stdout || "").trim();
}

export async function verifyExtensionEcosystemRc1({ rootFile = DEFAULT_OUTPUT, now = Date.now() } = {}) {
  const parsed = JSON.parse(await readFile(rootFile, "utf8"));
  const roots = validateTrustRoots(parsed, { requireNonEmpty: true });
  const active = roots.filter((root) => root.state === "active");
  if (active.length === 0) fail("没有 active Official Registry 根");
  for (const root of active) {
    const validFrom = Date.parse(root.validFrom);
    const validUntil = Date.parse(root.validUntil);
    if (validFrom > now || validUntil <= now) {
      fail(`Official Registry 根当前不在有效期内: ${root.sourceId}/${root.keyId}`);
    }
  }

  runNode(path.join(ROOT, "scripts/generate-plugin-host-api.mjs"), ["--check"]);

  return {
    roots,
    active,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await verifyExtensionEcosystemRc1();
    console.log("Extension Ecosystem RC1 release gate passed");
    for (const root of result.active) {
      console.log(`- ${root.sourceId}/${root.keyId} sequence=${root.sequence} validUntil=${root.validUntil}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
