import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadPrivateKey, loadPublicKey, parseTrustedKeys, publicKeyId, signBytes, SIGNATURE_ALGORITHM, toPublicPem, verifyBytes } from "../hot-update/lib/keys.mjs";
import { buildDraftManifest, encodeEnvelope, openEnvelope, orderManifest, serializeManifest } from "../hot-update/lib/manifest.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const other = generateKeyPairSync("rsa", { modulusLength: 3072 });
const keyId = publicKeyId(publicKey);
const trusted = parseTrustedKeys({ schema: 1, keys: [{ id: keyId, pem: toPublicPem(publicKey) }] });
const data = Buffer.from("nowen hot update bundle bytes");

function signedEnvelope({ signer = privateKey, id = keyId, mutate } = {}) {
  const zip = Buffer.from("zip bytes");
  const draft = buildDraftManifest({
    target: "android", version: "1.6.2", runtimeVersion: "e1-0123456789abcdef", commit: "a".repeat(40),
    commitTime: 1795000000, zip,
  });
  const manifest = orderManifest({ ...draft, zipSignature: signBytes(signer, zip) });
  const payload = serializeManifest(manifest);
  const signatures = [{ keyId: id, algorithm: SIGNATURE_ALGORITHM, signature: signBytes(signer, payload) }];
  return encodeEnvelope(mutate ? mutate(payload) : payload, signatures);
}

test("签名可以验证，篡改数据或换公钥都会失败", () => {
  const signature = signBytes(privateKey, data);
  assert.equal(verifyBytes(publicKey, data, signature), true);
  assert.equal(verifyBytes(publicKey, Buffer.from("tampered"), signature), false);
  assert.equal(verifyBytes(other.publicKey, data, signature), false);
  assert.equal(verifyBytes(publicKey, data, "not base64!"), false);
});

test("与安卓插件同一算法：裸 base64 DER 公钥 + SHA256withRSA 可以验签", () => {
  // 插件做法：去掉 PEM 头尾和换行 → base64 解码 → X509EncodedKeySpec → SHA256withRSA。
  const pem = toPublicPem(publicKey);
  const der = Buffer.from(pem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replace(/\n/g, ""), "base64");
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  const signature = Buffer.from(signBytes(privateKey, data), "base64");
  assert.equal(verify("sha256", data, { key, padding: constants.RSA_PKCS1_PADDING }, signature), true);
});

test("openssl 交叉验签（RSA PKCS#1 v1.5 + SHA-256）", (t) => {
  if (spawnSync("openssl", ["version"], { stdio: "ignore" }).status !== 0) return t.skip("本机没有 openssl");
  const dir = mkdtempSync(path.join(os.tmpdir(), "nowen-hot-sign-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "pub.pem"), toPublicPem(publicKey));
  writeFileSync(path.join(dir, "data.bin"), data);
  writeFileSync(path.join(dir, "sig.bin"), Buffer.from(signBytes(privateKey, data), "base64"));
  const ok = spawnSync("openssl", ["dgst", "-sha256", "-verify", "pub.pem", "-signature", "sig.bin", "data.bin"], { cwd: dir, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Verified OK/);
  writeFileSync(path.join(dir, "data.bin"), Buffer.from("tampered"));
  const bad = spawnSync("openssl", ["dgst", "-sha256", "-verify", "pub.pem", "-signature", "sig.bin", "data.bin"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(bad.status, 0);
});

test("只接受 3072 位以上的 RSA 密钥", () => {
  const small = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => loadPublicKey(toPublicPem(small.publicKey)), /3072/);
  const ed = generateKeyPairSync("ed25519");
  assert.throws(() => loadPublicKey(ed.publicKey.export({ type: "spki", format: "pem" })), /RSA/);
  assert.throws(() => loadPrivateKey(small.privateKey.export({ type: "pkcs8", format: "pem" })), /3072/);
  // GitHub Secret 被粘贴成字面量 \n 时也能读
  const flat = privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n");
  assert.equal(publicKeyId(loadPrivateKey(flat)), keyId);
});

test("公钥列表的 id 必须与内容一致且不重复", () => {
  assert.throws(() => parseTrustedKeys({ schema: 1, keys: [{ id: "0000000000000000", pem: toPublicPem(publicKey) }] }), /id/);
  assert.throws(() => parseTrustedKeys({ schema: 1, keys: [{ id: keyId, pem: toPublicPem(publicKey) }, { id: keyId, pem: toPublicPem(publicKey) }] }), /重复/);
  assert.throws(() => parseTrustedKeys({ keys: [] }));
});

test("签名信封：受信任签名才放行，payload 被改或签名者不受信任都拒绝", () => {
  const { manifest, keyIds } = openEnvelope(signedEnvelope(), trusted);
  assert.equal(manifest.version, "1.6.2");
  assert.deepEqual(keyIds, [keyId]);
  assert.throws(() => openEnvelope(signedEnvelope({ mutate: (payload) => Buffer.from(payload.toString().replace("1.6.2", "1.6.9")) }), trusted), /签名校验失败/);
  assert.throws(() => openEnvelope(signedEnvelope({ signer: other.privateKey, id: publicKeyId(other.publicKey) }), trusted), /受信任/);
  assert.throws(() => openEnvelope(signedEnvelope({ signer: other.privateKey }), trusted), /签名校验失败/);
  const envelope = JSON.parse(signedEnvelope().toString());
  envelope.payload = `${envelope.payload}=`;
  assert.throws(() => openEnvelope(Buffer.from(JSON.stringify(envelope)), trusted));
});

test("清单拒绝未知字段和不在允许范围的下载地址", () => {
  const withExtra = (patch) => signedEnvelope({
    mutate: (payload) => Buffer.from(JSON.stringify({ ...JSON.parse(payload.toString()), ...patch })),
  });
  // 先改 payload 再签名才能单独测试字段校验
  const resign = (patch) => {
    const original = JSON.parse(openEnvelope(signedEnvelope(), trusted).payload.toString());
    const payload = Buffer.from(JSON.stringify({ ...original, ...patch }));
    return encodeEnvelope(payload, [{ keyId, algorithm: SIGNATURE_ALGORITHM, signature: signBytes(privateKey, payload) }]);
  };
  assert.throws(() => openEnvelope(withExtra({ extra: 1 }), trusted));
  assert.throws(() => openEnvelope(resign({ extra: 1 }), trusted), /未知字段/);
  assert.throws(() => openEnvelope(resign({ urls: ["https://evil.example.com/x.zip"] }), trusted), /允许范围/);
  assert.throws(() => openEnvelope(resign({ urls: ["http://download.nowen.cn/x.zip"] }), trusted), /允许范围/);
  assert.throws(() => openEnvelope(resign({ bundleId: "1.6.2-00000000" }), trusted), /bundleId/);
});
