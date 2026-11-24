// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openHotUpdateEnvelope } from "../envelope";
import { compareHotUpdateVersions, decideHotUpdate, isCurrentBundleRevoked } from "../policy";
import { createSigningKey, manifestFor, PRODUCTION_ORIGINS, RUNTIME, sealEnvelope } from "./signingFixtures";

const key = createSigningKey();
const other = createSigningKey();
const trust = { publicKeyPem: key.publicKeyPem, keyId: key.keyId, allowedOrigins: PRODUCTION_ORIGINS };

describe("签名信封（与发版流水线互通）", () => {
  it("流水线签出的信封能被客户端验签并解析", async () => {
    const manifest = await openHotUpdateEnvelope(sealEnvelope(manifestFor("1.6.3"), key), trust);
    expect(manifest.version).toBe("1.6.3");
    expect(manifest.runtimeVersion).toBe(RUNTIME);
  });

  it("payload 被改、签名者不是安装包信任的公钥、keyId 冒用都会拒绝", async () => {
    const tampered = JSON.parse(sealEnvelope(manifestFor("1.6.3"), key));
    tampered.payload = Buffer.from(Buffer.from(tampered.payload, "base64").toString().replace("1.6.3", "1.6.9")).toString("base64");
    await expect(openHotUpdateEnvelope(JSON.stringify(tampered), trust)).rejects.toThrow("签名校验失败");
    await expect(openHotUpdateEnvelope(sealEnvelope(manifestFor("1.6.3"), other), trust)).rejects.toThrow("没有安装包信任的签名");
    await expect(openHotUpdateEnvelope(sealEnvelope(manifestFor("1.6.3"), other, { keyId: key.keyId }), trust)).rejects.toThrow("签名校验失败");
    await expect(openHotUpdateEnvelope("not json", trust)).rejects.toThrow("JSON");
    const noncanonical = JSON.parse(sealEnvelope(manifestFor("1.6.3"), key));
    noncanonical.payload = `${noncanonical.payload}==`;
    await expect(openHotUpdateEnvelope(JSON.stringify(noncanonical), trust)).rejects.toThrow();
  });

  it("签名正确但清单字段不合规时仍然拒绝", async () => {
    // 流水线的 orderManifest 会丢掉未知字段，这里直接构造 payload 模拟篡改过的生成器。
    const withExtra = Buffer.from(JSON.stringify({ ...manifestFor("1.6.3"), extra: true }));
    await expect(openHotUpdateEnvelope(sealEnvelope({}, key, { payload: withExtra }), trust)).rejects.toThrow("未知字段");
    await expect(openHotUpdateEnvelope(sealEnvelope(manifestFor("1.6.3", { urls: ["https://evil.example/x.zip"] }), key), trust)).rejects.toThrow("允许范围");
    await expect(openHotUpdateEnvelope(sealEnvelope(manifestFor("1.6.3", { urls: ["http://download.nowen.cn/x.zip"] }), key), trust)).rejects.toThrow("允许范围");
    await expect(openHotUpdateEnvelope(sealEnvelope(manifestFor("1.6.3", { bundleId: "1.6.3-00000000" }), key), trust)).rejects.toThrow("bundleId");
    await expect(openHotUpdateEnvelope(sealEnvelope(manifestFor("1.6.3", { runtimeVersion: "bad" }), key), trust)).rejects.toThrow("runtimeVersion");
  });

  it("测试包允许的来源只能是显式指定的测试服务", async () => {
    const testOrigin = "http://10.0.2.2:8787";
    const manifest = manifestFor("1.6.3", { urls: [`${testOrigin}/hot/v1.6.3/nowen-hot-android-1.6.3.zip`] });
    await expect(openHotUpdateEnvelope(sealEnvelope(manifest, key), trust)).rejects.toThrow("允许范围");
    await expect(openHotUpdateEnvelope(sealEnvelope(manifest, key), { ...trust, allowedOrigins: [testOrigin] })).resolves.toMatchObject({ version: "1.6.3" });
  });
});

describe("是否接受清单", () => {
  const base = { target: "android" as const, runtimeVersion: RUNTIME, currentVersion: "1.6.2", maxSequence: 0, blockedBundleIds: [] };
  const manifest = () => manifestFor("1.6.3") as Parameters<typeof decideHotUpdate>[0]["manifest"];

  it("同一壳、更高版本、未屏蔽时下载", () => {
    expect(decideHotUpdate({ ...base, manifest: manifest() })).toEqual({ action: "download" });
  });

  it("壳不同、版本不更高、序号更小、被屏蔽、被撤回、已在等待重启时都跳过", () => {
    const m = manifest();
    expect(decideHotUpdate({ ...base, manifest: { ...m, runtimeVersion: "e1-ffffffffffffffff" } })).toEqual({ action: "skip", reason: "runtime-mismatch" });
    expect(decideHotUpdate({ ...base, manifest: { ...m, target: "desktop" } })).toEqual({ action: "skip", reason: "target-mismatch" });
    expect(decideHotUpdate({ ...base, currentVersion: "1.6.3", manifest: m })).toEqual({ action: "skip", reason: "not-newer" });
    expect(decideHotUpdate({ ...base, currentVersion: "1.7.0", manifest: m })).toEqual({ action: "skip", reason: "not-newer" });
    expect(decideHotUpdate({ ...base, maxSequence: m.sequence + 1, manifest: m })).toEqual({ action: "skip", reason: "stale-sequence" });
    expect(decideHotUpdate({ ...base, blockedBundleIds: [m.bundleId], manifest: m })).toEqual({ action: "skip", reason: "blocked" });
    expect(decideHotUpdate({ ...base, manifest: { ...m, revokedBundleIds: [m.bundleId] } })).toEqual({ action: "skip", reason: "revoked" });
    expect(decideHotUpdate({ ...base, pendingBundleId: m.bundleId, manifest: m })).toEqual({ action: "skip", reason: "already-pending" });
    expect(decideHotUpdate({ ...base, maxSequence: m.sequence, manifest: m })).toEqual({ action: "download" });
  });

  it("版本号按数字比较，撤回只针对正在运行的热更新包", () => {
    expect(compareHotUpdateVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareHotUpdateVersions("1.6.2", "1.6.2")).toBe(0);
    expect(compareHotUpdateVersions("bad", "1.0.0")).toBe(-1);
    const m = { ...manifest(), revokedBundleIds: ["1.6.2-12345678"] };
    expect(isCurrentBundleRevoked(m, "1.6.2-12345678")).toBe(true);
    expect(isCurrentBundleRevoked(m, null)).toBe(false);
  });
});
