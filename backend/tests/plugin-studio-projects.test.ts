import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Hono } from "hono";
import JSZip from "jszip";
import { getDb } from "../src/db/schema";
import { pluginStudioMigration } from "../src/db/pluginStudioMigration";
import { PluginStudioProjectPaths } from "../src/plugins/studio/projectPaths";
import { PluginStudioProjectService } from "../src/plugins/studio/projectService";
import { PluginStudioError } from "../src/plugins/studio/types";
import pluginStudioRouter from "../src/routes/plugin-studio";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-plugin-studio-"));
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user'
    );
  `);
  for (const [id, role] of [["studio-owner", "user"], ["studio-other", "user"], ["studio-admin", "admin"]]) {
    db.prepare("INSERT INTO users (id, username, passwordHash, role) VALUES (?, ?, 'hash', ?)")
      .run(id, id, role);
  }
  pluginStudioMigration.up(db);
  const projectRoot = path.join(root, "plugin-projects");
  const service = new PluginStudioProjectService(db, new PluginStudioProjectPaths(projectRoot));
  return {
    db,
    root,
    projectRoot,
    service,
    close: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function assertStudioCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof PluginStudioError && error.code === code);
}

test("Plugin Studio feature gate is fail-closed at the route boundary", async () => {
  const previousParent = process.env.NOWEN_EXTENSIONS_V21;
  const previousStudio = process.env.NOWEN_PLUGIN_STUDIO;
  delete process.env.NOWEN_EXTENSIONS_V21;
  delete process.env.NOWEN_PLUGIN_STUDIO;
  try {
    const app = new Hono();
    app.route("/api/plugins/studio", pluginStudioRouter);
    const response = await app.request("/api/plugins/studio/projects");
    assert.equal(response.status, 404);
    assert.equal((await response.json() as any).code, "PLUGIN_STUDIO_FEATURE_DISABLED");
  } finally {
    if (previousParent === undefined) delete process.env.NOWEN_EXTENSIONS_V21;
    else process.env.NOWEN_EXTENSIONS_V21 = previousParent;
    if (previousStudio === undefined) delete process.env.NOWEN_PLUGIN_STUDIO;
    else process.env.NOWEN_PLUGIN_STUDIO = previousStudio;
  }
});

test("enabled Studio routes create projects and persist files for the owner", async () => {
  const previousParent = process.env.NOWEN_EXTENSIONS_V21;
  const previousStudio = process.env.NOWEN_PLUGIN_STUDIO;
  process.env.NOWEN_EXTENSIONS_V21 = "1";
  process.env.NOWEN_PLUGIN_STUDIO = "1";
  try {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')")
      .run("studio-route-user", "studio-route-user");
    const app = new Hono();
    app.route("/api/plugins/studio", pluginStudioRouter);

    const unauthenticated = await app.request("/api/plugins/studio/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No User" }),
    });
    assert.equal(unauthenticated.status, 401);

    const headers = { "Content-Type": "application/json", "X-User-Id": "studio-route-user" };
    const createdResponse = await app.request("/api/plugins/studio/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Route Project" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as any;

    const writeResponse = await app.request(
      `/api/plugins/studio/projects/${created.project.id}/files/content`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          path: "manifest.json",
          content: "{\"apiVersion\":2}",
          expectedRevision: created.project.revision,
        }),
      },
    );
    assert.equal(writeResponse.status, 200);
    const written = await writeResponse.json() as any;
    assert.equal(written.project.revision, 2);
    assert.equal(written.file.mimeType, "application/json");
  } finally {
    if (previousParent === undefined) delete process.env.NOWEN_EXTENSIONS_V21;
    else process.env.NOWEN_EXTENSIONS_V21 = previousParent;
    if (previousStudio === undefined) delete process.env.NOWEN_PLUGIN_STUDIO;
    else process.env.NOWEN_PLUGIN_STUDIO = previousStudio;
  }
});

test("project ownership, admin review and optimistic revisions are enforced", () => {
  const f = fixture();
  try {
    const owner = { userId: "studio-owner", isAdmin: false };
    const other = { userId: "studio-other", isAdmin: false };
    const admin = { userId: "studio-admin", isAdmin: true };
    const project = f.service.createProject(owner, { name: "Office Helper" });

    assert.equal(f.service.listProjects(owner).length, 1);
    assert.equal(f.service.listProjects(other).length, 0);
    assert.equal(f.service.listProjects(admin).length, 1);
    assertStudioCode(() => f.service.getProject(other, project.id), "PLUGIN_STUDIO_FORBIDDEN");

    const written = f.service.writeFile(owner, project.id, {
      path: "src/index.ts",
      content: "export const value = 1;\n",
      expectedRevision: 1,
    });
    assert.equal(written.project.revision, 2);
    assert.equal(written.file.content, "export const value = 1;\n");
    assertStudioCode(() => f.service.writeFile(owner, project.id, {
      path: "src/index.ts",
      content: "stale",
      expectedRevision: 1,
    }), "PLUGIN_STUDIO_REVISION_CONFLICT");
  } finally {
    f.close();
  }
});

test("project paths reject traversal, disallowed types and symbolic links", () => {
  const f = fixture();
  try {
    const owner = { userId: "studio-owner", isAdmin: false };
    const project = f.service.createProject(owner, { name: "Safe Project" });

    assertStudioCode(() => f.service.writeFile(owner, project.id, {
      path: "../outside.json",
      content: "{}",
      expectedRevision: 1,
    }), "PLUGIN_STUDIO_PATH_TRAVERSAL");
    assertStudioCode(() => f.service.writeFile(owner, project.id, {
      path: ".env",
      content: "SECRET=value",
      expectedRevision: 1,
    }), "PLUGIN_STUDIO_FILE_TYPE_NOT_ALLOWED");

    const outside = path.join(f.root, "outside.json");
    fs.writeFileSync(outside, "{\"secret\":true}");
    fs.symlinkSync(outside, path.join(f.projectRoot, project.id, "escape.json"));
    assertStudioCode(() => f.service.readFile(owner, project.id, "escape.json"), "PLUGIN_STUDIO_SYMLINK_REJECTED");
  } finally {
    f.close();
  }
});

test("projects use explicit export/import while preserving the file sandbox", async () => {
  const f = fixture();
  try {
    const owner = { userId: "studio-owner", isAdmin: false };
    let source = f.service.createProject(owner, { name: "Export Source" });
    source = f.service.writeFile(owner, source.id, {
      path: "manifest.json",
      content: "{\"id\":\"example.export\"}",
      expectedRevision: source.revision,
    }).project;
    source = f.service.writeFile(owner, source.id, {
      path: "assets/icon.png",
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
      encoding: "base64",
      expectedRevision: source.revision,
    }).project;

    const exported = await f.service.exportProject(owner, source.id);
    const imported = await f.service.importProject(owner, {
      name: "Imported Copy",
      archive: exported.archive,
    });
    assert.deepEqual(
      f.service.listFiles(owner, imported.id).map((file) => file.path),
      ["assets/icon.png", "manifest.json"],
    );
    assert.equal(f.service.readFile(owner, imported.id, "manifest.json").content, "{\"id\":\"example.export\"}");

    const malicious = new JSZip();
    malicious.file("../outside.json", "{}");
    const maliciousArchive = await malicious.generateAsync({ type: "nodebuffer" });
    await assert.rejects(
      () => f.service.importProject(owner, { name: "Unsafe", archive: maliciousArchive }),
      (error: unknown) => error instanceof PluginStudioError && error.code === "PLUGIN_STUDIO_PATH_TRAVERSAL",
    );
  } finally {
    f.close();
  }
});
