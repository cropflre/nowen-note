import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-extension-center-routes-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "extension-center-routes.db");
process.env.ELECTRON_USER_DATA = path.join(root, "data");

const ADMIN = "center-admin";
const USER = "center-user";

test("Registry catalog, install, permission and update routes stay server-authoritative", async () => {
  const [{ Hono }, { getDb, closeDb }, { default: router }, { getPluginService }, { createSignedRegistryFixture }] = await Promise.all([
    import("hono"),
    import("../src/db/schema"),
    import("../src/routes/plugins"),
    import("../src/plugins/pluginService"),
    import("./helpers/signedRegistryFixture"),
  ]);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users(id,username,passwordHash,role,createdAt,updatedAt) VALUES (?,?,?,?,?,?)").run(ADMIN, ADMIN, "unused", "admin", now, now);
  db.prepare("INSERT INTO users(id,username,passwordHash,role,createdAt,updatedAt) VALUES (?,?,?,?,?,?)").run(USER, USER, "unused", "user", now, now);

  const fixture = await createSignedRegistryFixture();
  await fixture.addExtension({ id: "fixture.writer", name: "Fixture Writer", description: "Signed fixture", category: "editor", keywords: ["写作", "markdown"], versions: [{ version: "1.0.0", permissions: ["notes:read"] }] });
  await fixture.addExtension({ id: "fixture.tampered", name: "Tampered", versions: [{ version: "1.0.0" }] });
  await fixture.addExtension({ id: "fixture.forged", name: "Forged", versions: [{ version: "1.0.0", forgedSignature: true }] });
  fixture.tamperArtifact("fixture.tampered", "1.0.0");
  fixture.publish();
  getPluginService().ecosystem.transport = fixture.transport;

  const app = new Hono();
  app.route("/plugins", router);
  const headers = (user: string) => ({ "X-User-Id": user, "Content-Type": "application/json" });
  const call = async (user: string, method: string, url: string, body?: unknown) => {
    const response = await app.request(url, { method, headers: headers(user), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json().catch(() => null) as any };
  };

  try {
    const features = await call(USER, "GET", "/plugins/features");
    assert.equal(features.status, 200);
    assert.ok(["server", "desktop-full"].includes(features.json.runtimePlatform));

    const source = { id: fixture.sourceId, name: "Fixture Registry", indexUrl: fixture.indexUrl, registryKeyId: fixture.registryKeyId, registryPublicKey: fixture.registryPublicKey };
    assert.equal((await call(USER, "PUT", "/plugins/ecosystem/sources", source)).status, 403);
    const pinned = await call(ADMIN, "PUT", "/plugins/ecosystem/sources", source);
    assert.equal(pinned.status, 200, JSON.stringify(pinned.json));
    const listed = (await call(USER, "GET", "/plugins/ecosystem/sources")).json.find((item: any) => item.id === fixture.sourceId);
    assert.deepEqual([listed.official, listed.enabled], [false, true]);

    // Ordinary users may browse the verified catalog, including signed display metadata.
    const catalog = await call(USER, "GET", `/plugins/ecosystem/catalog?source=${fixture.sourceId}`);
    assert.equal(catalog.status, 200, JSON.stringify(catalog.json));
    const writer = catalog.json.extensions.find((item: any) => item.id === "fixture.writer");
    assert.equal(writer.category, "editor");
    assert.deepEqual(writer.keywords, ["写作", "markdown"]);
    assert.deepEqual(writer.versions[0].permissions, ["notes:read"]);

    // ...but cannot install, review updates or bypass permission approval.
    assert.equal((await call(USER, "POST", "/plugins/ecosystem/install", { sourceId: fixture.sourceId, pluginId: "fixture.writer" })).status, 403);
    assert.equal((await call(USER, "GET", `/plugins/ecosystem/updates?source=${fixture.sourceId}`)).status, 403);

    // Bytes that do not match the signed digest or publisher key never reach the registry.
    const tampered = await call(ADMIN, "POST", "/plugins/ecosystem/install", { sourceId: fixture.sourceId, pluginId: "fixture.tampered" });
    assert.equal(tampered.json.code, "REGISTRY_CHECKSUM_MISMATCH");
    const forged = await call(ADMIN, "POST", "/plugins/ecosystem/install", { sourceId: fixture.sourceId, pluginId: "fixture.forged" });
    assert.equal(forged.json.code, "PLUGIN_SIGNATURE_INVALID");
    const afterRejected = (await call(ADMIN, "GET", "/plugins")).json.map((item: any) => item.id);
    assert.equal(afterRejected.includes("fixture.tampered") || afterRejected.includes("fixture.forged"), false);

    // A verified install starts quarantined with every declared permission still ungranted.
    const installed = await call(ADMIN, "POST", "/plugins/ecosystem/install", { sourceId: fixture.sourceId, pluginId: "fixture.writer", version: "1.0.0" });
    assert.equal(installed.status, 201, JSON.stringify(installed.json));
    assert.equal(installed.json.plugin.status, "quarantined");
    assert.equal(installed.json.plugin.signatureState, "verified");
    assert.equal(installed.json.plugin.source, "registry");
    assert.deepEqual(installed.json.plugin.permissions.map((row: any) => [row.permission, row.granted]), [["notes:read", 0]]);

    assert.equal((await call(USER, "GET", "/plugins")).json.some((item: any) => item.id === "fixture.writer"), false);
    assert.equal((await call(USER, "PUT", "/plugins/fixture.writer/permissions", { granted: ["notes:read"] })).status, 403);
    assert.equal((await call(USER, "POST", "/plugins/fixture.writer/enable")).status, 403);

    const enableWithoutGrant = await call(ADMIN, "POST", "/plugins/fixture.writer/enable");
    assert.equal(enableWithoutGrant.status, 400);
    assert.equal((await call(ADMIN, "GET", "/plugins/fixture.writer")).json.status, "quarantined");
    assert.equal((await call(ADMIN, "PUT", "/plugins/fixture.writer/permissions", { granted: ["notes:read"] })).status, 200);
    const enabled = await call(ADMIN, "POST", "/plugins/fixture.writer/enable");
    assert.equal(enabled.status, 200, JSON.stringify(enabled.json));
    assert.equal(enabled.json.plugin.status, "enabled");
    assert.equal((await call(USER, "GET", "/plugins")).json.find((item: any) => item.id === "fixture.writer")?.status, "enabled");

    // An update that widens permissions is visible to admins and needs explicit confirmation.
    await fixture.addVersion("fixture.writer", { version: "1.1.0", permissions: ["notes:read", "notes:write"] });
    fixture.publish();
    const updates = await call(ADMIN, "GET", `/plugins/ecosystem/updates?source=${fixture.sourceId}`);
    assert.equal(updates.status, 200, JSON.stringify(updates.json));
    const update = updates.json.find((item: any) => item.pluginId === "fixture.writer");
    assert.deepEqual([update.availableVersion, update.confirmationRequired, update.permissionDiff.added], ["1.1.0", true, ["notes:write"]]);
    const unconfirmed = await call(ADMIN, "POST", "/plugins/ecosystem/update", { sourceId: fixture.sourceId, pluginId: "fixture.writer", version: "1.1.0" });
    assert.equal(unconfirmed.json.code, "PLUGIN_UPDATE_CONFIRMATION_REQUIRED");
    assert.equal((await call(ADMIN, "GET", "/plugins/fixture.writer")).json.version, "1.0.0");
    const confirmed = await call(ADMIN, "POST", "/plugins/ecosystem/update", { sourceId: fixture.sourceId, pluginId: "fixture.writer", version: "1.1.0", confirmed: true });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
    const updated = (await call(ADMIN, "GET", "/plugins/fixture.writer")).json;
    assert.equal(updated.version, "1.1.0");
    assert.deepEqual(updated.permissionDiff.added, ["notes:write"]);
    // The new version runs on probation; the added permission stays ungranted until an admin approves it.
    assert.deepEqual([updated.status, updated.lifecycleState], ["enabled", "probation"]);
    assert.equal(updated.permissions.find((row: any) => row.permission === "notes:write")?.granted, 0);

    // A catalog whose content no longer matches its signature is refused.
    fixture.tamperIndex();
    const rejectedCatalog = await call(USER, "GET", `/plugins/ecosystem/catalog?source=${fixture.sourceId}`);
    assert.equal(rejectedCatalog.json.code, "REGISTRY_SIGNATURE_INVALID");
  } finally {
    closeDb();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
