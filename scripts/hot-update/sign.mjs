#!/usr/bin/env node
// 用项目热更新私钥给 zip 和清单签名，把草稿变成签名信封。
//
//   NOWEN_HOT_UPDATE_PRIVATE_KEY="$(cat key.pem)" node scripts/hot-update/sign.mjs --dir release-hot
//
// 私钥只从环境变量读取，不接受命令行参数，也绝不打印。私钥对应的公钥必须已经入库。
import { createPublicKey } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT } from "./build-bundles.mjs";
import { loadPrivateKey, loadTrustedKeys, publicKeyId, signBytes, SIGNATURE_ALGORITHM } from "./lib/keys.mjs";
import { assetNames, encodeEnvelope, orderManifest, serializeManifest, sha256Hex, TARGETS, validateManifest } from "./lib/manifest.mjs";

export const PRIVATE_KEY_ENV = "NOWEN_HOT_UPDATE_PRIVATE_KEY";

export async function signBundles({ dir, privateKeyPem, keysFile = path.join(DEFAULT_REPO_ROOT, "hot-update/public-keys.json") }) {
  if (!privateKeyPem) throw new Error(`缺少热更新签名私钥（环境变量 ${PRIVATE_KEY_ENV}）`);
  const privateKey = loadPrivateKey(privateKeyPem);
  const keyId = publicKeyId(createPublicKey(privateKey));
  const trusted = await loadTrustedKeys(keysFile);
  if (!trusted.has(keyId)) throw new Error(`签名私钥对应的公钥 ${keyId} 不在 ${path.basename(keysFile)} 里，拒绝签名`);
  // 安卓插件只能配置一把公钥，安装包里写的是列表第一把；用别的钥签名，安卓会全部验签失败。
  if ([...trusted.keys()][0] !== keyId) throw new Error(`签名必须使用公钥列表里的第一把（当前生效的公钥），而不是 ${keyId}`);

  const drafts = (await readdir(dir)).filter((name) => /^draft-(android|desktop)\.json$/.test(name)).sort();
  if (drafts.length !== TARGETS.length) throw new Error("找不到全部清单草稿；请先运行 build-bundles.mjs");
  const results = [];
  for (const name of drafts) {
    const draft = validateManifest(JSON.parse(await readFile(path.join(dir, name), "utf8")), { draft: true });
    const names = assetNames(draft.target, draft.version, draft.runtimeVersion);
    const zip = await readFile(path.join(dir, names.zip));
    if (zip.length !== draft.size || sha256Hex(zip) !== draft.sha256) throw new Error(`${names.zip} 与草稿记录的大小或摘要不一致`);
    const manifest = validateManifest(orderManifest({ ...draft, zipSignature: signBytes(privateKey, zip) }));
    const payload = serializeManifest(manifest);
    const envelope = encodeEnvelope(payload, [{ keyId, algorithm: SIGNATURE_ALGORITHM, signature: signBytes(privateKey, payload) }]);
    await writeFile(path.join(dir, names.manifest), envelope, { flag: "wx" });
    await rm(path.join(dir, name));
    results.push({ target: draft.target, manifest: names.manifest, keyId });
  }
  return results;
}

async function main() {
  const { values } = parseArgs({ options: { dir: { type: "string" }, keys: { type: "string" } } });
  if (!values.dir) throw new Error("需要 --dir");
  const results = await signBundles({
    dir: path.resolve(values.dir),
    privateKeyPem: process.env[PRIVATE_KEY_ENV],
    ...(values.keys ? { keysFile: path.resolve(values.keys) } : {}),
  });
  for (const item of results) console.log(`[hot-update] signed ${item.target}: ${item.manifest} (key ${item.keyId})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[hot-update] ${error.message}`);
    process.exitCode = 1;
  });
}
