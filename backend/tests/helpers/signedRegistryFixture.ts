// Test-only signed V2 Registry. It generates real Ed25519 keys, signs the index and
// every artifact, and serves the bytes through EcosystemRegistry.transport. Nothing
// else is faked: the client still verifies signatures, digests, publishers and policy.
import crypto from "node:crypto";
import JSZip from "jszip";
import { artifactDigest, canonicalJson } from "../../src/plugins/signatures.js";

export interface FixtureVersion {
  version: string;
  permissions?: string[];
  externalFetchHosts?: string[];
  /** Sign the artifact with an unrelated key: install must fail with PLUGIN_SIGNATURE_INVALID. */
  forgedSignature?: boolean;
}

export interface FixtureExtension {
  id: string;
  name: string;
  description?: string;
  category?: string;
  keywords?: string[];
  trustLevel?: "official" | "verified" | "community";
  versions: FixtureVersion[];
}

function pem(key: crypto.KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

async function buildPackage(extension: FixtureExtension, version: FixtureVersion): Promise<Buffer> {
  const publisher = extension.id.split(".")[0];
  const manifest = {
    id: extension.id,
    publisher,
    name: extension.name,
    description: extension.description || "",
    version: version.version,
    apiVersion: 2,
    engines: { nowen: ">=1.5.0 <2.0.0" },
    runtime: "sandbox-js",
    main: "index.js",
    categories: [extension.category || "productivity"],
    keywords: extension.keywords,
    repository: "https://github.com/nowen-fixtures/registry",
    license: "MIT",
    permissions: version.permissions || [],
    ...(version.externalFetchHosts?.length ? { permissionConfig: { externalFetchHosts: version.externalFetchHosts } } : {}),
    actions: [{ id: "hello", name: "Hello" }],
  };
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("index.js", "globalThis.__nowenPluginModule={actions:{hello:async()=>({text:'ok'})}};");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function createSignedRegistryFixture(options: { host?: string; sourceId?: string } = {}) {
  const host = options.host || "registry.fixture.test";
  const sourceId = options.sourceId || "fixture-registry";
  const registryKeys = crypto.generateKeyPairSync("ed25519");
  const publisherKeys = crypto.generateKeyPairSync("ed25519");
  const strangerKeys = crypto.generateKeyPairSync("ed25519");
  const registryKeyId = `${sourceId}-root`;
  const publisherKeyId = `${sourceId}-publisher`;
  const indexUrl = `https://${host}/v2/index.json`;
  const artifacts = new Map<string, Buffer>();
  const extensions: Array<Record<string, unknown>> = [];
  let sequence = 0;
  let indexBytes = Buffer.from("{}");

  async function versionEntry(extension: FixtureExtension, version: FixtureVersion) {
    const bytes = await buildPackage(extension, version);
    const artifactUrl = `https://${host}/v2/artifacts/${extension.id}/${version.version}.nowen-plugin`;
    artifacts.set(artifactUrl, bytes);
    const signer = version.forgedSignature ? strangerKeys.privateKey : publisherKeys.privateKey;
    return {
      version: version.version,
      apiVersion: 2,
      runtime: "sandbox-js",
      artifactUrl,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      publisherKeyId,
      signature: crypto.sign(null, artifactDigest(bytes), signer).toString("base64"),
      nowen: ">=1.5.0 <2.0.0",
      permissions: version.permissions || [],
      ...(version.externalFetchHosts?.length ? { permissionConfig: { externalFetchHosts: version.externalFetchHosts } } : {}),
      uiPlatform: ["web", "desktop"],
      publishedAt: new Date().toISOString(),
    };
  }

  function sign(document: Record<string, unknown>): Buffer {
    // Sign exactly what the client will parse: JSON drops undefined optional fields.
    const wire = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
    const signature = crypto.sign(null, Buffer.from(canonicalJson(wire)), registryKeys.privateKey).toString("base64");
    return Buffer.from(JSON.stringify({ ...wire, signature }));
  }

  /** Re-sign the index with the next sequence number (Registry clients reject replays). */
  function publish(): void {
    sequence += 1;
    const now = Date.now();
    indexBytes = sign({
      protocolVersion: 2,
      sequence,
      generatedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      signerKeyId: registryKeyId,
      publishers: [{
        publisher: "fixture",
        keyId: publisherKeyId,
        publicKey: pem(publisherKeys.publicKey),
        state: "active",
        validFrom: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        validUntil: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }],
      extensions,
    });
  }

  return {
    sourceId,
    indexUrl,
    registryKeyId,
    registryPublicKey: pem(registryKeys.publicKey),
    async addExtension(extension: FixtureExtension): Promise<void> {
      if (!extension.id.startsWith("fixture.")) throw new Error("fixture extensions use the fixture publisher");
      const versions = [];
      for (const version of extension.versions) versions.push(await versionEntry(extension, version));
      extensions.push({
        id: extension.id,
        publisher: "fixture",
        name: extension.name,
        description: extension.description,
        trustLevel: extension.trustLevel || "community",
        category: extension.category,
        keywords: extension.keywords,
        repository: "https://github.com/nowen-fixtures/registry",
        license: "MIT",
        versions,
      });
    },
    async addVersion(extensionId: string, version: FixtureVersion): Promise<void> {
      const entry = extensions.find((item) => item.id === extensionId) as { versions: unknown[]; name: string; description?: string; category?: string; keywords?: string[] } | undefined;
      if (!entry) throw new Error(`unknown fixture extension ${extensionId}`);
      entry.versions.push(await versionEntry({ id: extensionId, name: entry.name, description: entry.description, category: entry.category, keywords: entry.keywords, versions: [] }, version));
    },
    publish,
    /** Serve different bytes than the signed digest describes. */
    tamperArtifact(extensionId: string, version: string): void {
      const url = `https://${host}/v2/artifacts/${extensionId}/${version}.nowen-plugin`;
      const original = artifacts.get(url);
      if (!original) throw new Error(`unknown artifact ${url}`);
      artifacts.set(url, Buffer.concat([original, Buffer.from("tampered")]));
    },
    /** Serve an index whose content no longer matches its signature. */
    tamperIndex(): void {
      const parsed = JSON.parse(indexBytes.toString("utf8")) as { extensions: Array<{ name: string }> };
      if (parsed.extensions[0]) parsed.extensions[0].name = "Tampered";
      indexBytes = Buffer.from(JSON.stringify(parsed));
    },
    transport: async (url: string, maxBytes: number): Promise<Buffer> => {
      const bytes = url === indexUrl ? indexBytes : artifacts.get(url);
      if (!bytes) throw Object.assign(new Error(`fixture registry has no ${url}`), { code: "REGISTRY_FETCH_FAILED" });
      if (bytes.length > maxBytes) throw Object.assign(new Error("fixture payload too large"), { code: "REGISTRY_PAYLOAD_TOO_LARGE" });
      return bytes;
    },
  };
}
