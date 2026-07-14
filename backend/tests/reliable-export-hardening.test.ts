import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import {
  handleReliableExportDownload,
  stageReliableGeneratedExport,
  validatePreparedMarkdownNotes,
} from "../src/services/reliableExportJobs";

test("cumulative inline asset quota is enforced", () => {
  const notes = [{
    id: "note-1",
    title: "quota",
    notebookName: null,
    createdAt: "2026-07-12",
    updatedAt: "2026-07-12",
    markdown: "body",
    inlineAssets: [
      { relPath: "assets/a.bin", base64: Buffer.from("abc").toString("base64") },
      { relPath: "assets/b.bin", base64: Buffer.from("def").toString("base64") },
    ],
  }];

  assert.throws(
    () => validatePreparedMarkdownNotes(notes, { maxInlineAssetBytes: 5 }),
    (error: any) => error?.code === "INLINE_ASSETS_TOO_LARGE" && error?.status === 413,
  );
});

test("download capability token can be retried before expiry", async () => {
  const body = new Response(new TextEncoder().encode("markdown")).body;
  assert.ok(body);
  const staged = await stageReliableGeneratedExport({
    userId: "user-export-hardening",
    filename: "note.md",
    contentType: "text/markdown",
    body,
  });

  const app = new Hono();
  app.get("/download/:token", handleReliableExportDownload);
  const first = await app.request(`/download/${staged.downloadToken}`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-nowen-reliable-export"), "1");
  assert.equal(await first.text(), "markdown");

  const retry = await app.request(`/download/${staged.downloadToken}`);
  assert.equal(retry.status, 200);
  assert.equal(await retry.text(), "markdown");
});

test("download response keeps binary content uncompressed", async () => {
  const body = new Response(new TextEncoder().encode("zip-content")).body;
  assert.ok(body);
  const staged = await stageReliableGeneratedExport({
    userId: "user-export-identity",
    filename: "notes.zip",
    contentType: "application/zip",
    body,
  });

  const app = new Hono();
  app.get("/download/:token", handleReliableExportDownload);
  const response = await app.request(`/download/${staged.downloadToken}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), "identity");
  assert.equal(Number(response.headers.get("content-length")), "zip-content".length);
  assert.equal(await response.text(), "zip-content");
});
