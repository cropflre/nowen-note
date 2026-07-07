import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import JSZip from "jszip";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-siyuan-zip-budget-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.SIYUAN_IMPORT_MAX_ZIP_ENTRIES = "3";
process.env.SIYUAN_IMPORT_MAX_SY_FILES = "1";
process.env.SIYUAN_IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES = "100";
process.env.SIYUAN_IMPORT_MAX_SINGLE_SY_BYTES = "20";
process.env.SIYUAN_IMPORT_MAX_SINGLE_ASSET_BYTES = "4";

let closeDb: () => void;
let getDb: () => import("better-sqlite3").Database;
let importSiyuanPackageFromZipFile: typeof import("../src/services/siyuanPackageImport").importSiyuanPackageFromZipFile;
let app: Hono;

async function writeZip(name: string, files: Record<string, string | Uint8Array>) {
  const zip = new JSZip();
  for (const [filePath, content] of Object.entries(files)) {
    zip.file(filePath, content);
  }
  const zipPath = path.join(tmpDir, name);
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
  return zipPath;
}

async function assertBudgetRejected(zipPath: string) {
  await assert.rejects(
    () => importSiyuanPackageFromZipFile(zipPath, { userId: "zip-budget-user", workspaceId: null }),
    (err: any) => err?.code === "SIYUAN_ZIP_BUDGET_EXCEEDED",
  );
}

test.before(async () => {
  const [serviceModule, schemaModule, exportModule] = await Promise.all([
    import("../src/services/siyuanPackageImport"),
    import("../src/db/schema"),
    import("../src/routes/export"),
  ]);
  importSiyuanPackageFromZipFile = serviceModule.importSiyuanPackageFromZipFile;
  closeDb = schemaModule.closeDb;
  getDb = schemaModule.getDb;
  app = new Hono();
  app.route("/export", exportModule.default);
  getDb()
    .prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("zip-budget-user", "zip-budget-user", "hash");
});

test.after(async () => {
  closeDb();
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (err?.code !== "EBUSY") throw err;
      if (i === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("rejects siyuan packages with too many entries before buffering", async () => {
  const zipPath = await writeZip("too-many-entries.zip", {
    "a.sy": "{}",
    "b.txt": "b",
    "c.txt": "c",
    "d.txt": "d",
  });

  await assertBudgetRejected(zipPath);
});

test("rejects siyuan packages with too many sy documents before buffering", async () => {
  const zipPath = await writeZip("too-many-sy.zip", {
    "a.sy": "{}",
    "b.sy": "{}",
  });

  await assertBudgetRejected(zipPath);
});

test("rejects oversized sy and asset entries before buffering", async () => {
  const oversizedSy = await writeZip("oversized-sy.zip", {
    "a.sy": JSON.stringify({ ID: "a", Content: "x".repeat(30) }),
  });
  await assertBudgetRejected(oversizedSy);

  const oversizedAsset = await writeZip("oversized-asset.zip", {
    "a.sy": "{}",
    "assets/big.bin": new Uint8Array([1, 2, 3, 4, 5]),
  });
  await assertBudgetRejected(oversizedAsset);
});

test("rejects siyuan packages whose total uncompressed size exceeds the budget", async () => {
  const zipPath = await writeZip("too-large-total.zip", {
    "a.sy": "{}",
    "assets/a.bin": new Uint8Array(50),
    "assets/b.bin": new Uint8Array(50),
    "assets/c.bin": new Uint8Array(1),
  });

  await assertBudgetRejected(zipPath);
});

test("siyuan package route returns 413 when zip budgets are exceeded", async () => {
  const zipPath = await writeZip("route-budget.zip", {
    "a.sy": "{}",
    "assets/big.bin": new Uint8Array([1, 2, 3, 4, 5]),
  });
  const form = new FormData();
  form.set("file", new File([fs.readFileSync(zipPath)], "route-budget.zip", { type: "application/zip" }));

  const res = await app.request("/export/import/siyuan-package?workspaceId=personal", {
    method: "POST",
    headers: { "X-User-Id": "zip-budget-user" },
    body: form,
  });

  const text = await res.text();
  assert.equal(res.status, 413, text);
  const payload = JSON.parse(text) as { code?: string };
  assert.equal(payload.code, "SIYUAN_ZIP_BUDGET_EXCEEDED");
});
