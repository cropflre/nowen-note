import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-registry-e2e-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "registry-e2e.db");
process.env.ELECTRON_USER_DATA = path.join(root, "user-data");

function publicPem(key: crypto.KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

test("Registry trust -> metadata -> publisher artifact -> package install closes the V2 supply-chain loop", async () => {
  const [
    { RegistryTrust },
    { RegistryMetadataGuard },
    { canonicalJson, artifactDigest, verifyArtifactSignature },
    { validatePluginPackage },
    { PluginPackageInstaller },
    { PluginRegistry },
    { getDb, closeDb },
  ] = await Promise.all([
    import("../src/plugins/registryTrust"),
    import("../src/plugins/registryMetadataGuard"),
    import("../src/plugins/signatures"),
    import("../src/plugins/packageValidator"),
    import("../src/plugins/packageInstaller"),
    import("../src/plugins/registry"),
    import("../src/db/schema"),
  ]);

  const registryKeys = crypto.generateKeyPairSync("ed25519");
  const publisherKeys = crypto.generateKeyPairSync("ed25519");
  const registryPublicKey = publicPem(registryKeys.publicKey);
  const publisherPublicKey = publicPem(publisherKeys.publicKey);
  const sourceId = "rc1-e2e";
  const now = Date.parse("2026-08-24T08:00:00.000Z");

  const manifest = {
    id: "acme.e2e",
    publisher: "acme",
    name: "Supply Chain E2E",
    description: "Synthetic RC1 supply-chain fixture",
    version: "1.0.0",
    apiVersion: 2 as const,
    engines: { nowen: ">=1.5.0 <2.0.0" },
    runtime: "sandbox-js" as const,
    main: "index.js",
    categories: ["productivity"],
    repository: "https://github.com/acme/e2e",
    license: "MIT",
    permissions: [],
    actions: [{ id: "hello", name: "Hello" }],
  };
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index.js", "globalThis.__nowenPluginModule={actions:{hello:async()=>({success:true,data:'ok'})}};");
  const artifact = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const sha256 = crypto.createHash("sha256").update(artifact).digest("hex");
  const artifactSignature = crypto.sign(null, artifactDigest(artifact), publisherKeys.privateKey).toString("base64");

  const unsigned = {
    protocolVersion: 2,
    sequence: 1,
    generatedAt: "2026-08-24T07:55:00.000Z",
    expiresAt: "2026-08-25T08:00:00.000Z",
    signerKeyId: "registry-root-1",
    publishers: [{
      publisher: "acme",
      keyId: "publisher-1",
      publicKey: publisherPublicKey,
      state: "active",
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
    }],
    extensions: [{
      id: manifest.id,
      publisher: manifest.publisher,
      name: manifest.name,
      versions: [{
        version: manifest.version,
        apiVersion: 2,
        runtime: "sandbox-js",
        artifactUrl: "https://registry.example/v2/artifacts/acme.e2e/1.0.0",
        sha256,
        publisherKeyId: "publisher-1",
        signature: artifactSignature,
        nowen: ">=1.5.0 <2.0.0",
        permissions: [],
      }],
    }],
  };
  const metadata = {
    ...unsigned,
    signature: crypto.sign(null, Buffer.from(canonicalJson(unsigned)), registryKeys.privateKey).toString("base64"),
  };

  const trust = new RegistryTrust();
  const resolution = trust.resolve({
    id: sourceId,
    official: false,
    registryKeyId: "registry-root-1",
    registryPublicKey,
  }, metadata.signerKeyId, [], now);
  assert.equal(resolution.signer.keyId, "registry-root-1");

  const guard = new RegistryMetadataGuard();
  const verifiedMetadata = guard.validate(sourceId, metadata, resolution.signer.publicKey, now);
  trust.persist(sourceId, resolution, new Date(now).toISOString());
  guard.persist(verifiedMetadata, new Date(now).toISOString());
  assert.ok(getDb().prepare("SELECT 1 FROM plugin_registry_metadata_state WHERE sourceId=?").get(sourceId));
  assert.ok(getDb().prepare("SELECT 1 FROM plugin_registry_root_chain WHERE sourceId=? AND keyId=?").get(sourceId, "registry-root-1"));

  assert.equal(verifyArtifactSignature(artifact, artifactSignature, publisherPublicKey), true);
  assert.equal(verifyArtifactSignature(Buffer.concat([artifact, Buffer.from("tamper")]), artifactSignature, publisherPublicKey), false);
  const tamperedMetadata = { ...metadata, extensions: [] };
  assert.throws(
    () => guard.validate(`${sourceId}-tampered`, tamperedMetadata, resolution.signer.publicKey, now),
    (error: any) => error?.code === "REGISTRY_SIGNATURE_INVALID",
  );

  const validated = await validatePluginPackage(artifact);
  assert.equal(validated.checksum, sha256);
  assert.equal(validated.manifest.id, manifest.id);
  const installer = new PluginPackageInstaller();
  const installed = await installer.installValidated(validated, "rc1-e2e", {
    source: "registry",
    trustLevel: "verified",
    publisherKeyId: "publisher-1",
    signature: artifactSignature,
    signatureState: "verified",
    artifactUrl: "https://registry.example/v2/artifacts/acme.e2e/1.0.0",
  });
  assert.equal(installed.id, manifest.id);
  assert.equal(installed.status, "quarantined");
  const version = new PluginRegistry().getVersion(manifest.id, manifest.version);
  assert.equal(version?.signatureState, "verified");
  assert.equal(version?.publisherKeyId, "publisher-1");
  assert.ok(fs.existsSync(path.join(installed.installedPath, "index.js")));

  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("Registry binary transport rejects private/metadata targets before opening a socket", async () => {
  const { safeRegistryFetch } = await import("../src/plugins/communityRegistry");
  for (const url of [
    "https://127.0.0.1/index.json",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/index.json",
    "https://[::ffff:127.0.0.1]/index.json",
  ]) {
    await assert.rejects(
      () => safeRegistryFetch(url, 1024),
      (error: any) => error?.code === "REGISTRY_URL_DENIED",
    );
  }
});
