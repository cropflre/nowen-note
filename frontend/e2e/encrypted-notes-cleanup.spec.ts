import { test, expect } from "@playwright/test";
import type {} from "../benchmarks/encrypted-notes-cleanup";

const url = "http://127.0.0.1:5176/benchmarks/encrypted-notes-cleanup.html";
test.beforeEach(async ({ page }) => {
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.conversionCleanupHarness));
  await page.evaluate(() => window.conversionCleanupHarness.seed());
});

test("strict cleanup removes target cache, blobs/jobs, draft and Yjs database while retaining other notes", async ({ page }) => {
  const result = await page.evaluate(() => window.conversionCleanupHarness.cleanup());
  expect(result).toEqual({ noteId: "note", localCleanup: true, physicalErasure: "not_verified" });
  const after = await page.evaluate(() => window.conversionCleanupHarness.snapshot());
  expect(after.notes.map((note) => note.id)).toEqual(["other"]);
  expect(after.attachmentIds).toEqual(["attachment-other"]); expect(after.jobIds).toEqual(["job-other"]);
  expect(after.drafts).toEqual([null, "private-other"]);
  const name = await page.evaluate(() => window.conversionCleanupHarness.collaborationName());
  expect(after.databases).not.toContain(name);
  await expect(page.evaluate(() => window.conversionCleanupHarness.cleanup())).resolves.toEqual(result);
});

test("another window's ordinary editor blocks cleanup without changing any persisted copy", async ({ page, context }) => {
  const before = await page.evaluate(() => window.conversionCleanupHarness.snapshot());
  const other = await context.newPage(); await other.goto(url);
  await other.evaluate(() => window.conversionCleanupHarness.showEditor("note"));
  await expect(other.getByRole("textbox", { name: "ordinary editor" })).toBeVisible();
  const code = await page.evaluate(() => window.conversionCleanupHarness.cleanup().catch((error) => error.code));
  expect(code).toBe("busy");
  expect(await page.evaluate(() => window.conversionCleanupHarness.snapshot())).toEqual(before);
  await other.close();
  // Page closure can finish before Chromium releases the editor's Web Lock.
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.some((lock) => lock.name?.endsWith(":note")))).toBe(false);
  await expect(page.evaluate(() => window.conversionCleanupHarness.cleanup())).resolves.toMatchObject({ localCleanup: true });
});

test("a new editor cannot mount inside another window's exclusive cleanup lease", async ({ page, context }) => {
  await page.evaluate(() => window.conversionCleanupHarness.holdExclusive());
  const other = await context.newPage(); await other.goto(url);
  await other.evaluate(() => window.conversionCleanupHarness.showEditor("note"));
  await expect(other.getByRole("status")).toContainText("正在确认");
  await expect(other.getByRole("textbox")).toHaveCount(0);
  await page.evaluate(() => window.conversionCleanupHarness.releaseExclusive());
  await expect(other.getByRole("textbox")).toBeVisible();
});

test("changing notes releases the old lease without accidentally admitting its pending editor", async ({ page, context }) => {
  await page.evaluate(() => window.conversionCleanupHarness.holdExclusive());
  const other = await context.newPage(); await other.goto(url);
  await other.evaluate(() => window.conversionCleanupHarness.showEditor("note"));
  await expect(other.getByRole("textbox")).toHaveCount(0);
  await other.evaluate(() => window.conversionCleanupHarness.showEditor("other"));
  await expect(other.getByRole("textbox")).toBeVisible();
  await page.evaluate(() => window.conversionCleanupHarness.releaseExclusive());
  const locks = await other.evaluate(() => navigator.locks.query());
  expect(locks.held?.filter((lock) => lock.name?.endsWith(":note"))).toHaveLength(0);
});

test("a blocked IndexedDB deletion keeps the lease and never reports premature success", async ({ page, context }) => {
  await page.evaluate(() => window.conversionCleanupHarness.blockYjsDeletion());
  await page.evaluate(() => window.conversionCleanupHarness.startCleanup());
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.some((lock) => lock.mode === "exclusive"))).toBe(true);
  expect(await page.evaluate(() => window.conversionCleanupHarness.outcome())).toBe("pending");
  const other = await context.newPage(); await other.goto(url);
  await other.evaluate(() => window.conversionCleanupHarness.showEditor("note"));
  await expect(other.getByRole("textbox")).toHaveCount(0);
  await page.evaluate(() => window.conversionCleanupHarness.unblockYjsDeletion());
  await expect.poll(() => page.evaluate(() => window.conversionCleanupHarness.outcome())).toMatchObject({ localCleanup: true });
  await expect(other.getByRole("textbox")).toHaveCount(0);
  await expect(other.getByRole("status")).toContainText("笔记已加密");
  // Refusing the stale editor also releases its lease, allowing cleanup retry.
  await expect(page.evaluate(() => window.conversionCleanupHarness.cleanup())).resolves.toMatchObject({ localCleanup: true });
});

test("a failure inside the real cache transaction rolls back attachment/job and note deletion", async ({ page }) => {
  const before = await page.evaluate(() => window.conversionCleanupHarness.snapshot());
  expect(await page.evaluate(() => window.conversionCleanupHarness.abortCacheCleanup())).toBe("failed");
  expect(await page.evaluate(() => window.conversionCleanupHarness.snapshot())).toEqual(before);
});

test("an in-flight replay in another window blocks cleanup even if its queue targets another note", async ({ page, context }) => {
  const other = await context.newPage(); await other.goto(url);
  await other.evaluate(() => window.conversionCleanupHarness.holdReplay());
  const before = await page.evaluate(() => window.conversionCleanupHarness.snapshot());
  expect(await page.evaluate(() => window.conversionCleanupHarness.cleanup().catch((error) => error.code))).toBe("busy");
  expect(await page.evaluate(() => window.conversionCleanupHarness.snapshot())).toEqual(before);
  await other.evaluate(() => window.conversionCleanupHarness.releaseReplay());
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.some((lock) => lock.name === "nowen-encrypted-conversion-replay:v1"))).toBe(false);
  await expect(page.evaluate(() => window.conversionCleanupHarness.cleanup())).resolves.toMatchObject({ localCleanup: true });
});

test("returning to a previously opened note waits for its new lease instead of reusing old readiness", async ({ page, context }) => {
  const other = await context.newPage(); await other.goto(url);
  await other.evaluate(() => window.conversionCleanupHarness.showEditor("note"));
  await expect(other.getByRole("textbox")).toBeVisible();
  await other.evaluate(() => window.conversionCleanupHarness.showEditor("other"));
  await expect(other.getByRole("textbox")).toBeVisible();
  await page.evaluate(() => window.conversionCleanupHarness.holdExclusive());
  await other.evaluate(() => window.conversionCleanupHarness.showEditor("note"));
  await expect(other.getByRole("status")).toContainText("正在确认");
  await expect(other.getByRole("textbox")).toHaveCount(0);
  await page.evaluate(() => window.conversionCleanupHarness.releaseExclusive());
  await expect(other.getByRole("textbox")).toBeVisible();
});

test("logout during blocked deletion retains the lease until deletion settles and preserves the remaining draft/cache", async ({ page }) => {
  await page.evaluate(() => window.conversionCleanupHarness.blockYjsDeletion());
  await page.evaluate(() => window.conversionCleanupHarness.startCleanup());
  await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.some((lock) => lock.mode === "exclusive"))).toBe(true);
  // Wait for the actual blocked deletion, rather than invalidating during the initial audit.
  await expect.poll(() => page.evaluate(() => window.conversionCleanupHarness.deletionBlocked())).toBe(true);
  await page.evaluate(() => {
    localStorage.removeItem("nowen-token"); window.dispatchEvent(new Event("nowen:token-changed"));
  });
  expect(await page.evaluate(() => window.conversionCleanupHarness.outcome())).toBe("pending");
  await page.evaluate(() => window.conversionCleanupHarness.unblockYjsDeletion());
  await expect.poll(() => page.evaluate(() => window.conversionCleanupHarness.outcome())).toEqual({ code: "scope_changed" });
  const after = await page.evaluate(() => window.conversionCleanupHarness.snapshot());
  expect(after.drafts).toEqual(["private-note", "private-other"]);
  expect(after.notes.map((note) => note.id).sort()).toEqual(["note", "other"]);
});

for (const method of ["GET", "PUT"] as const) {
  test(`an actual in-flight ${method} request in another window blocks cleanup through response parsing`, async ({ page, context }) => {
    const other = await context.newPage(); await other.goto(url);
    let finish!: () => void;
    let started = false;
    await other.route("**/api/notes/note", async (route) => {
      started = true;
      await new Promise<void>((resolve) => { finish = resolve; });
      await route.fulfill({ json: { id: "note", version: 1, content: "private-note", contentText: "private-note", contentFormat: "markdown" } });
    });
    const pending = other.evaluate((method) => window.conversionCleanupHarness.requestNote(method), method);
    await expect.poll(() => started).toBe(true);
    expect(await page.evaluate(() => window.conversionCleanupHarness.cleanup().catch((error) => error.code))).toBe("busy");
    finish(); await pending;
    await expect.poll(() => page.evaluate(() => window.conversionCleanupHarness.cleanup().then(() => "clean", (error) => error.code))).toBe("clean");
  });
}

test("a background writer lease in another window blocks cleanup without deleting existing copies", async ({ page, context }) => {
  const other = await context.newPage(); await other.goto(url);
  await other.evaluate(() => window.conversionCleanupHarness.holdCacheWrite());
  const before = await page.evaluate(() => window.conversionCleanupHarness.snapshot());
  expect(await page.evaluate(() => window.conversionCleanupHarness.cleanup().catch((error) => error.code))).toBe("busy");
  expect(await page.evaluate(() => window.conversionCleanupHarness.snapshot())).toEqual(before);
  await other.evaluate(() => window.conversionCleanupHarness.releaseCacheWrite());
  await expect.poll(() => page.evaluate(() => window.conversionCleanupHarness.cleanup().then(() => "clean", (error) => error.code))).toBe("clean");
});

test("late cache/list/download/draft/queue writes cannot resurrect plaintext, even after reopening a window", async ({ page, context }) => {
  await page.evaluate(() => window.conversionCleanupHarness.cleanup());
  const other = await context.newPage(); await other.goto(url);
  expect(await other.evaluate(() => window.conversionCleanupHarness.writeStaleCopies())).toEqual(Array(5).fill("converted_note"));
  const after = await page.evaluate(() => window.conversionCleanupHarness.snapshot());
  expect(after.notes.map((note) => note.id)).toEqual(["other"]);
  expect(after.attachmentIds).toEqual(["attachment-other"]); expect(after.jobIds).toEqual(["job-other"]);
  expect(after.drafts).toEqual([null, "private-other"]);
  await other.evaluate(() => window.conversionCleanupHarness.cacheEncrypted());
  await other.evaluate(() => window.conversionCleanupHarness.writeStaleCopies());
  const latest = await page.evaluate(() => window.conversionCleanupHarness.snapshot());
  expect(latest.notes.find((note) => note.id === "note")).toMatchObject({ contentFormat: "encrypted-note-v1", contentText: "", version: 2 });
});

test("cross-window confirmation clears workbench plaintext and requests a list refresh", async ({ page, context }) => {
  const other = await context.newPage(); await other.goto(url);
  await other.evaluate(() => window.conversionCleanupHarness.showApp());
  await expect(other.getByText("state ready")).toBeVisible();
  await other.evaluate(() => window.conversionCleanupHarness.seedAppState());
  await expect.poll(() => other.evaluate(() => window.conversionCleanupHarness.appState()?.activeNote?.id)).toBe("note");
  await page.evaluate(() => window.conversionCleanupHarness.cleanup());
  await expect.poll(() => other.evaluate(() => window.conversionCleanupHarness.appState()?.activeNote)).toBeNull();
  const state = await other.evaluate(() => window.conversionCleanupHarness.appState());
  expect(state?.notes.map((note) => note.id)).toEqual(["other"]);
  expect(state?.openNoteTabs).toEqual([]); expect(state?.editorSplit).toBeNull(); expect(state?.notesRefreshToken).toBe(1);
});

test("switching accounts cancels a pending ordinary editor instead of admitting the former account's body", async ({ page, context }) => {
  await page.evaluate(() => window.conversionCleanupHarness.holdExclusive());
  const other = await context.newPage(); await other.goto(url);
  await other.evaluate(() => window.conversionCleanupHarness.showEditor("note"));
  await expect(other.getByRole("status")).toContainText("正在确认");
  await page.evaluate(() => localStorage.setItem("nowen-token", `header.${btoa(JSON.stringify({ userId: "other" }))}.signature`));
  await expect(other.getByRole("status")).toContainText("无法确认");
  await page.evaluate(() => window.conversionCleanupHarness.releaseExclusive());
  await expect(other.getByRole("textbox")).toHaveCount(0);
  await expect.poll(() => other.evaluate(async () => (await navigator.locks.query()).held?.some((lock) => lock.name?.endsWith(":note")))).toBe(false);
});
