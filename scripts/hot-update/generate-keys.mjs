#!/usr/bin/env node
// 生成热更新签名密钥（RSA 3072）。只在维护者自己的电脑上运行。
//
//   node scripts/hot-update/generate-keys.mjs --private-key-out ~/nowen-hot-update-private.pem
//
// - 私钥写到仓库之外（任何 git 工作区内都拒绝写入），权限 0600，已存在则拒绝覆盖；
// - 公钥追加到 hot-update/public-keys.json，需要提交；
// - 私钥由维护者自己放进 GitHub Secret 并离线备份，脚本不上传任何东西。
import { execFileSync } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT } from "./build-bundles.mjs";
import { generateRsaKeyPair, parseTrustedKeys, publicKeyId, toPublicPem } from "./lib/keys.mjs";
import { PRIVATE_KEY_ENV } from "./sign.mjs";

function insideGitWorkTree(dir) {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

export async function generateKeys({ repoRoot = DEFAULT_REPO_ROOT, privateKeyOut, now = new Date() }) {
  if (!privateKeyOut) throw new Error("需要 --private-key-out（仓库之外的路径）");
  const out = path.resolve(privateKeyOut);
  const parent = path.dirname(out);
  if (!(await lstat(parent).catch(() => null))?.isDirectory()) throw new Error(`目录不存在：${parent}`);
  if (insideGitWorkTree(parent)) throw new Error("私钥不能写进任何 git 工作区，请换一个仓库之外的目录");
  if (await lstat(out).catch(() => null)) throw new Error(`文件已存在，拒绝覆盖：${out}`);

  const keysFile = path.join(repoRoot, "hot-update/public-keys.json");
  const data = JSON.parse(await readFile(keysFile, "utf8"));
  parseTrustedKeys(data);
  const { privateKey, publicKey } = generateRsaKeyPair();
  const id = publicKeyId(publicKey);
  await writeFile(out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  data.keys.push({ id, createdAt: now.toISOString().slice(0, 10), pem: toPublicPem(publicKey) });
  parseTrustedKeys(data);
  await writeFile(keysFile, `${JSON.stringify(data, null, 2)}\n`);
  return { id, privateKeyOut: out, keysFile };
}

async function main() {
  const { values } = parseArgs({ options: { "private-key-out": { type: "string" } } });
  const result = await generateKeys({ privateKeyOut: values["private-key-out"] });
  console.log(`已生成热更新签名密钥 ${result.id}
私钥：${result.privateKeyOut}（只在本机，权限 0600）
公钥：已追加到 ${path.relative(process.cwd(), result.keysFile) || result.keysFile}

接下来由你本人完成：
  1. 把私钥存进 GitHub Secret：gh secret set ${PRIVATE_KEY_ENV} < "${result.privateKeyOut}"
  2. 把私钥离线备份两份（例如加密 U 盘 + 密码管理器）；私钥丢失后，已安装的客户端再也收不到热更新。
  3. 提交 hot-update/public-keys.json。
详见 docs/architecture/hot-update.md。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[hot-update] ${error.message}`);
    process.exitCode = 1;
  });
}
