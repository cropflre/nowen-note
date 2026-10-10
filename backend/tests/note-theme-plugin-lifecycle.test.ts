import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-theme-plugin-lifecycle-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(tempDirectory, "lifecycle.test.db");
process.env.ELECTRON_USER_DATA = tempDirectory;
process.env.NOWEN_EXTENSIONS_V21 = "1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sample = JSON.parse(fs.readFileSync(
  path.join(root, "examples/plugins/theme-pack/manifest.json"),
  "utf8",
));
const parseOptions = { extensionsV21: true, currentVersion: "1.6.0" } as const;

test("Theme Pack install lifecycle preserves the requested note theme for automatic recovery", async () => {
  const [{ PluginService }, schemaModule] = await Promise.all([
    import("../src/plugins/pluginService"),
    import("../src/db/schema"),
  ]);
  const db = schemaModule.getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("theme-user", "theme-user", "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name, icon) VALUES (?, ?, ?, ?)")
    .run("theme-notebook", "theme-user", "Themes", "🎨");
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version, themeId)
    VALUES (?, ?, ?, ?, ?, ?, 'markdown', 1, ?)
  `).run(
    "theme-note",
    "theme-user",
    "theme-notebook",
    "Theme lifecycle",
    "# Theme lifecycle",
    "Theme lifecycle",
    "nowenlab.theme-pack/sepia",
  );

  const archive = new JSZip();
  archive.file("manifest.json", JSON.stringify(sample));
  const bytes = Buffer.from(await archive.generateAsync({ type: "uint8array" }));
  const service = new PluginService();
  const validated = await service.installer.inspect(bytes, parseOptions);
  const installed = await service.installer.installValidated(validated, "theme-user", {
    source: "package",
    trustLevel: "community",
  });
  assert.equal(installed.status, "quarantined");

  // This branch still reports host version 1.5.0. Package parsing above verifies the real
  // 1.6.0 contract; bypass only that pre-release host-version gate to exercise the lifecycle.
  service.policy.assertAllowed = () => "declarative";

  const enabled = await service.enable(sample.id);
  assert.equal(enabled.status, "enabled");
  assert.equal(enabled.lifecycleState, "stable");
  assert.equal(enabled.executionMode, "declarative-zero-code");
  assert.equal(service.contributions()[0]?.pluginId, sample.id);
  assert.equal((service.contributions()[0] as any)?.noteThemes?.[0]?.id, "sepia");

  await service.disable(sample.id);
  assert.equal(service.contributions().length, 0);
  assert.equal(
    (db.prepare("SELECT themeId FROM notes WHERE id=?").get("theme-note") as { themeId: string }).themeId,
    "nowenlab.theme-pack/sepia",
  );

  await service.enable(sample.id);
  assert.equal(service.contributions()[0]?.pluginId, sample.id);

  await service.uninstall(sample.id);
  assert.equal(service.registry.get(sample.id), undefined);
  assert.equal(service.contributions().length, 0);
  assert.equal(
    (db.prepare("SELECT themeId FROM notes WHERE id=?").get("theme-note") as { themeId: string }).themeId,
    "nowenlab.theme-pack/sepia",
  );

  await service.installer.installValidated(validated, "theme-user", {
    source: "package",
    trustLevel: "community",
  });
  await service.enable(sample.id);
  assert.equal(service.contributions()[0]?.pluginId, sample.id);
  assert.equal(
    (db.prepare("SELECT themeId FROM notes WHERE id=?").get("theme-note") as { themeId: string }).themeId,
    "nowenlab.theme-pack/sepia",
  );

  schemaModule.closeDb();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});
