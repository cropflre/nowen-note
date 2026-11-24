import { test, expect, type Locator } from "@playwright/test";
import fs from "node:fs";

const version = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
type TreeNode = { id: string; resourceId: string; parentId: string | null; title: string };

async function expectInsideViewport(row: Locator, viewport: Locator) {
  await expect(row).toBeVisible();
  await expect.poll(async () => {
    const [item, frame] = await Promise.all([row.boundingBox(), viewport.boundingBox()]);
    return !item || !frame ? Infinity : Math.max(frame.y - item.y, item.y + item.height - frame.y - frame.height);
  }).toBeLessThanOrEqual(1);
}

for (const format of ["markdown", "tiptap-json"] as const) {
test(`${format}: search, template naming and title reveal keep the actual document location visible`, async ({ page, request }) => {
  // The config starts the isolated QA fixture; never authenticate against a personal database.
  const login = await request.post("/api/auth/login", {
    data: { username: "assets_qa", password: "assets-qa-only-password" },
  });
  expect(login.ok()).toBe(true);
  const tokens = await login.json();
  const headers = { Authorization: `Bearer ${tokens.token}` };
  const create = async (title: string, parentId: string | null, nodeType = "folder"): Promise<TreeNode> => {
    const response = await request.post("/api/knowledge-tree/nodes?workspaceId=personal", { headers, data: { title, parentId, nodeType } });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const productFolder = await create("A02-来料加工资料 QA", null);
  const otherFolder = await create("Z99-其他资料 QA", null);
  // A real virtual list makes an offscreen search result exercise index-based positioning.
  for (let index = 0; index < 112; index += 1) {
    await create(`普通产品-${String(index).padStart(3, "0")}`, productFolder.id, "markdown");
  }
  const product = await create("驰铭-13011606_CM3342-V1.1 0.5W 3030 QA", productFolder.id, format === "markdown" ? "markdown" : "note");
  const childFolder = await create("261020-001 QA", product.id);
  const child = await create("产品测试记录 QA", product.id, "markdown");
  const nested = await create("不含产品编码的附件说明 QA", childFolder.id, "markdown");
  const content = await request.put(`/api/notes/${product.resourceId}`, {
    headers, data: {
      content: format === "markdown" ? "# 产品首件及批量测试要求\n\n1. 首件测试\n2. 批量测试" : JSON.stringify({
        type: "doc", content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "产品首件及批量测试要求" }] },
          { type: "paragraph", content: [{ type: "text", text: "首件测试与批量测试" }] },
        ],
      }),
      contentFormat: format, version: 1,
    },
  });
  expect(content.ok()).toBe(true);
  const templateResponse = await request.post(`/api/note-templates/from-note/${product.resourceId}?workspaceId=personal`, {
    headers, data: { name: `SMT-产品测试记录-模板 QA ${format}` },
  });
  expect(templateResponse.ok()).toBe(true);
  const template = (await templateResponse.json()).template;

  await page.addInitScript(({ tokens, version }) => {
    localStorage.setItem("nowen-token", tokens.token);
    localStorage.setItem("nowen-refresh-token", tokens.refreshToken);
    localStorage.setItem("i18nextLng", "zh-CN");
    localStorage.setItem("nowen-seen-version", version);
    localStorage.setItem("nowen-note-workspace-layout", "three-column");
    localStorage.setItem("nowen.desktopKnowledgeTree.viewMode.v1", "tree");
  }, { tokens, version });
  await page.goto("/");
  const sidebar = page.locator('[data-sidebar-variant="desktop"]:visible');
  const row = (id: string) => sidebar.locator(`[data-knowledge-tree-node-id="${id}"]`);
  const treeViewport = sidebar.locator('[data-swipe-blocker="knowledge-tree-scroll"]');
  const search = sidebar.locator('input[data-knowledge-tree-search]:visible');
  await expect(row(productFolder.id)).toBeVisible();
  await search.fill("3342");
  for (const node of [product, childFolder, child, nested]) await expect(row(node.id)).toBeVisible();
  await expect(row(otherFolder.id)).toHaveCount(0);
  await row(product.id).getByRole("button", { name: "折叠", exact: true }).click();
  await expect(row(childFolder.id)).toHaveCount(0);
  await expect(row(child.id)).toHaveCount(0);
  await row(product.id).getByRole("button", { name: "展开", exact: true }).click();
  for (const node of [childFolder, child, nested]) await expect(row(node.id)).toBeVisible();
  await row(product.id).getByRole("button", { name: "折叠", exact: true }).click();
  await row(product.id).getByRole("button", { name: product.title, exact: true }).click();
  for (const node of [childFolder, child, nested]) await expect(row(node.id)).toBeVisible();
  const virtualViewport = page.locator('[data-note-list-scroll-viewport="virtual"]');
  const middleProduct = page.locator(`[data-note-list-note-id="${product.resourceId}"]`);
  await expectInsideViewport(middleProduct, virtualViewport);
  expect(await virtualViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(search).toHaveValue("3342");
  await page.screenshot({ path: test.info().outputPath("search-subtree-and-middle-location.png") });

  await row(product.id).hover();
  await row(product.id).getByRole("button", { name: `在“${product.title}”下新建`, exact: true }).click();
  await page.getByRole("menuitem", { name: "从模板新建", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "从模板新建", exact: true });
  await expect(picker).toBeVisible();
  const createdResponse = page.waitForResponse((response) => response.url().includes(`/note-templates/${template.id}/create-note`) && response.request().method() === "POST");
  await picker.getByRole("button", { name: new RegExp(`^SMT-产品测试记录-模板 QA ${format}`) }).click();
  const createdResult = await (await createdResponse).json();
  const created = createdResult.node as TreeNode;
  expect(created.parentId).toBe(product.id);
  await expect(picker).toHaveCount(0);
  await expect(row(created.id)).toHaveAttribute("aria-selected", "true");
  const name = row(created.id).getByRole("textbox", { name: "文档名称", exact: true });
  await expect(name).toBeFocused();
  await expect.poll(() => name.evaluate((input: HTMLInputElement) => ({
    start: input.selectionStart, end: input.selectionEnd, length: input.value.length,
  }))).toEqual({ start: 0, end: created.title.length, length: created.title.length });
  await expectInsideViewport(name, treeViewport);
  await page.screenshot({ path: test.info().outputPath("template-created-selected-title.png") });
  await name.fill("261111-011 QA");
  await row(created.id).getByRole("button", { name: "确认重命名", exact: true }).click();
  await expect(row(created.id).locator("[data-knowledge-tree-title]")).toHaveText("261111-011 QA");
  const title = page.locator('[data-markdown-mobile-title] textarea, [data-mobile-editor-title] textarea').filter({ visible: true });
  await expect(title).toHaveValue("261111-011 QA");
  const middleCreated = page.locator(`[data-note-list-note-id="${created.resourceId}"]`);
  const ordinaryViewport = page.locator('[data-radix-scroll-area-viewport]').filter({ has: middleCreated });
  await expectInsideViewport(middleCreated, ordinaryViewport);

  // Renaming must retain the confirmed note version so the next body save cannot conflict.
  const conflicts: number[] = [];
  page.on("response", (response) => {
    if (response.url().includes(`/api/notes/${created.resourceId}`) && response.request().method() === "PUT" && response.status() === 409) {
      conflicts.push(response.status());
    }
  });
  const marker = "导航回归：重命名后正文继续保存";
  const source = page.locator(format === "markdown" ? '.cm-content[contenteditable="true"]:visible' : '.tiptap[contenteditable="true"]:visible').first();
  await source.click();
  await source.press("ControlOrMeta+End");
  await source.press("Enter");
  await source.pressSequentially(marker);
  await expect.poll(async () => {
    const result = await request.get(`/api/notes/${created.resourceId}`, { headers });
    return (await result.json()).content;
  }, { timeout: 15_000 }).toContain(marker);
  expect(conflicts).toEqual([]);

  // Selecting another folder keeps the editor open; a conflicting tree filter hides its row.
  await row(otherFolder.id).locator(`button[title="${otherFolder.title}"]`).click();
  await search.fill("Z99");
  await expect(row(created.id)).toHaveCount(0);
  await title.dblclick();
  await expect(search).toHaveValue("");
  await expect(row(created.id)).toHaveAttribute("aria-selected", "true");
  await expectInsideViewport(row(created.id), treeViewport);
  await expectInsideViewport(middleCreated, ordinaryViewport);
  await expect(title).toHaveValue("261111-011 QA");
  await page.screenshot({ path: test.info().outputPath("title-double-click-location.png") });
  const persisted = await request.get("/api/knowledge-tree/?workspaceId=personal", { headers });
  expect((await persisted.json()).nodes.find((node: TreeNode) => node.id === created.id)).toMatchObject({ parentId: product.id, title: "261111-011 QA" });
  const savedNote = await request.get(`/api/notes/${created.resourceId}`, { headers });
  expect(await savedNote.json()).toMatchObject({ title: "261111-011 QA", content: expect.stringContaining(marker) });
  await page.reload();
  await search.fill("261111-011");
  await row(created.id).getByRole("button", { name: "261111-011 QA", exact: true }).click();
  await expect(title).toHaveValue("261111-011 QA");
  await expect(source).toContainText(marker);
});
}
