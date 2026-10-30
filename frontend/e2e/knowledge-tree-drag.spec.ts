import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve("..");
const electron = createRequire(import.meta.url)("electron") as string;
const test = base.extend<{ server: string }>({
  server: async ({ browserName }, provide) => {
    void browserName;
    // Reuse the production-app fixture; it requires this temp profile prefix.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-composer-browser-"));
    let backend: ChildProcess | undefined, logs = "";
    try {
      const port = await new Promise<number>(resolve => {
        const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => {
          const port = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(port));
        });
      });
      const server = `http://127.0.0.1:${port}`;
      backend = spawn(electron, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/task-composer-browser-server.ts")], {
        cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TASK_COMPOSER_PROFILE: directory, FRONTEND_DIST: path.join(root, "frontend/dist"), PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
      });
      backend.stdout?.on("data", chunk => { logs += chunk; }); backend.stderr?.on("data", chunk => { logs += chunk; });
      await expect.poll(() => fetch(`${server}/api/health`).then(r => r.ok).catch(() => false), { timeout: 20000 }).toBe(true);
      await provide(server);
    } finally {
      if (backend && backend.exitCode === null) {
        const exited = new Promise<void>(resolve => backend!.once("exit", () => resolve())); backend.kill(); await exited;
      }
      fs.rmSync(directory, { recursive: true, force: true });
      if (backend?.exitCode && backend.exitCode !== 0) console.error(logs.slice(-1000));
    }
  },
});

test("nested notes keep their position on drag and persist sorting and moves (#869)", async ({ page, server }) => {
  const registration = await page.request.post(`${server}/api/auth/register`, { data: { username: "drag_user", password: "drag-browser-test-password" } });
  expect(registration.ok()).toBe(true);
  const account = await registration.json(), headers = { Authorization: `Bearer ${account.token}` };
  const create = async (title: string, parentId: string | null, nodeType = "folder") => {
    const response = await page.request.post(`${server}/api/knowledge-tree/nodes?workspaceId=personal`, { headers, data: { title, parentId, nodeType } });
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{ id: string }>;
  };
  const a = await create("Root A", null), b = await create("Root B", null);
  const sub = await create("Subfolder", a.id);
  const second = await create("Second level", a.id, "note"), secondSibling = await create("Second sibling", a.id, "note");
  const third = await create("Third level", sub.id, "note"), thirdSibling = await create("Third sibling", sub.id, "note");
  const list = async () => {
    const response = await page.request.get(`${server}/api/knowledge-tree/?workspaceId=personal`, { headers });
    expect(response.ok()).toBe(true);
    return (await response.json()).nodes as Array<{ id: string; parentId: string | null; sortOrder: number }>;
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(server);
  await page.evaluate(() => { localStorage.setItem("i18nextLng", "zh-CN"); localStorage.setItem("nowen-seen-version", "1.5.3"); });
  await page.reload();
  await page.getByPlaceholder("admin", { exact: true }).fill("drag_user");
  await page.locator("input[type=password]").fill("drag-browser-test-password");
  await page.locator("button[type=submit]").click();
  const row = (id: string) => page.locator(`[data-knowledge-tree-node-id="${id}"]`).filter({ visible: true });
  await expect(row(a.id)).toBeVisible();
  const guide = page.locator('[data-knowledge-tree-node-id]').filter({ has: page.locator('button[title="Nowen Note 使用指南 / Guide"]') });
  if (await guide.count()) await guide.first().getByRole("button", { name: "折叠", exact: true }).click();
  for (const folder of [a, sub]) {
    const expand = row(folder.id).getByRole("button", { name: "展开", exact: true });
    if (await expand.count()) await expand.click();
  }

  // jsdom has no layout: explicitly catch the former 42px jump in a browser.
  for (const source of [second, third]) {
    const before = await row(source.id).boundingBox();
    const targetBefore = await row(b.id).boundingBox();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await row(source.id).dispatchEvent("dragstart", { dataTransfer });
    await expect(page.locator("[data-knowledge-tree-root-drop]")).toBeVisible();
    expect((await row(source.id).boundingBox())?.y).toBe(before?.y);
    expect((await row(b.id).boundingBox())?.y).toBe(targetBefore?.y);
    await row(source.id).dispatchEvent("dragend", { dataTransfer });
    await dataTransfer.dispose();
  }

  // Start a real native mouse drag before reading the target's position.
  const startDrag = async (id: string) => {
    await row(id).scrollIntoViewIfNeeded();
    const box = (await row(id).boundingBox())!;
    await page.mouse.move(box.x + 100, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 110, box.y + box.height / 2);
    await expect(page.locator("[data-knowledge-tree-root-drop]")).toBeVisible();
  };
  for (const [source, sibling, parent] of [[second, secondSibling, a], [third, thirdSibling, sub]]) {
    await startDrag(sibling.id);
    const target = (await row(source.id).boundingBox())!;
    await page.mouse.move(target.x + 100, target.y + 2);
    await page.mouse.up();
    await expect.poll(async () => (await list()).filter(node => node.parentId === parent.id)
      .sort((left, right) => left.sortOrder - right.sortOrder).map(node => node.id).filter(id => [source.id, sibling.id].includes(id)))
      .toEqual([sibling.id, source.id]);
    await startDrag(source.id);
    const destination = (await row(b.id).boundingBox())!;
    await page.mouse.move(destination.x + 100, destination.y + destination.height / 2);
    await page.mouse.up();
    await expect.poll(async () => (await list()).find(node => node.id === source.id)?.parentId).toBe(b.id);
  }
  await startDrag(thirdSibling.id);
  const rootDrop = (await page.locator("[data-knowledge-tree-root-drop]").boundingBox())!;
  await page.mouse.move(rootDrop.x + rootDrop.width / 2, rootDrop.y + rootDrop.height / 2);
  await page.mouse.up();
  await expect.poll(async () => (await list()).find(node => node.id === thirdSibling.id)?.parentId).toBeNull();
  await page.reload();
  await expect(row(thirdSibling.id)).toBeVisible();
  expect((await list()).filter(node => [second.id, third.id].includes(node.id)).every(node => node.parentId === b.id)).toBe(true);
});
