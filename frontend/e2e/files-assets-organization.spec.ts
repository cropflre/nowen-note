import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const evidence = path.resolve(
  "../docs/qa/files-assets-center-v2/screenshots/phase-c",
);
test("Phase C: real tags, batch changes, saved filters, identical files and responsive UI", async ({
  page,
  request,
  browser,
}) => {
  fs.mkdirSync(evidence, { recursive: true });
  const login = await request.post("/api/auth/login", {
    data: { username: "assets_qa", password: "assets-qa-only-password" },
  });
  expect(login.ok()).toBe(true);
  const account = (await login.json()) as {
    token: string;
    refreshToken: string;
  };
  const headers = { Authorization: `Bearer ${account.token}` };
  await page.addInitScript(
    (tokens) => {
      localStorage.setItem("nowen-token", tokens.token);
      localStorage.setItem("nowen-refresh-token", tokens.refreshToken);
      localStorage.setItem("i18nextLng", "zh-CN");
      localStorage.setItem("nowen-seen-version", tokens.version);
    },
    {
      ...account,
      version: JSON.parse(
        fs.readFileSync(path.resolve("../package.json"), "utf8"),
      ).version as string,
    },
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const images = (await (
    await request.get("/api/files?category=image", { headers })
  ).json()) as {
    items: Array<{ id: string; filename: string }>;
    accessUrls: Record<string, string>;
  };
  const image = images.items.find(
    (file) => file.filename === "项目参考图-1.png",
  )!;
  const originalUrl = images.accessUrls[image.id];
  const originalBytes = await (await request.get(originalUrl)).body();
  const original = (await (
    await request.get(`/api/files/${image.id}`, { headers })
  ).json()) as { id: string; folderId: string; url: string };
  const files: string[] = [];
  for (const name of ["C-tagged-one.txt", "C-tagged-two.txt"]) {
    const upload = await request.post("/api/files/upload", {
      headers,
      multipart: {
        file: {
          name,
          mimeType: "text/plain",
          buffer: Buffer.from(`Phase C fixture: ${name}`),
        },
      },
    });
    expect(upload.ok()).toBe(true);
    files.push(((await upload.json()) as { id: string }).id);
  }
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "插入加密内容", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "文件管理", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索文件名" }).fill(image.filename);
  await page.getByRole("button", { name: image.filename, exact: true }).click();
  const editor = page.locator('section[aria-label="标签"]').filter({
    has: page.getByRole("textbox", { name: "搜索标签，按 Enter 新建" }),
  });
  await editor.getByRole("textbox").fill("设计素材");
  await editor.getByRole("textbox").press("Enter");
  await expect(editor.getByTitle("从文件移除此标签")).toContainText("设计素材");
  await page.screenshot({ path: path.join(evidence, "detail-tags.png") });
  const organization = (await (
    await request.get("/api/files/organization", { headers })
  ).json()) as { tags: Array<{ id: string; name: string }> };
  const tag = organization.tags.find((item) => item.name === "设计素材")!;
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "搜索文件名" }).fill("C-tagged");
  await expect(page.locator("main footer")).toContainText("2 个文件");
  await page.getByRole("button", { name: "选择文件", exact: true }).click();
  for (const name of ["C-tagged-one.txt", "C-tagged-two.txt"])
    await page.getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: "批量标签", exact: true }).click();
  const batch = page.locator('section[aria-label="标签"]').filter({
    has: page.getByText("添加或移除所选 2 个文件的标签；其他标签保持不变。", {
      exact: true,
    }),
  });
  await batch.getByRole("button", { name: "添加", exact: true }).click();
  for (const id of files)
    await expect
      .poll(async () => {
        const result = (await (
          await request.get(`/api/files/organization/assets/${id}`, { headers })
        ).json()) as { tags: Array<{ id: string }> };
        return result.tags.map((item) => item.id);
      })
      .toContain(tag.id);
  await page.screenshot({ path: path.join(evidence, "batch-tags.png") });
  await page
    .locator('aside section[aria-label="标签"] button[aria-pressed]')
    .filter({ hasText: "设计素材" })
    .click();
  await expect(page.locator("main footer")).toContainText("3 个文件");
  await page
    .getByRole("combobox", { name: "文件格式", exact: true })
    .selectOption("image/png");
  await expect(page.locator("main footer")).toContainText("1 个文件");
  await page
    .getByRole("button", { name: "保存为智能文件夹", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("textbox").fill("带标签的 PNG");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确定", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.locator('aside section[aria-label="智能文件夹"]'),
  ).toContainText("带标签的 PNG");
  await page.screenshot({ path: path.join(evidence, "smart-folder.png") });
  await page.reload();
  await page.getByRole("button", { name: "文件管理", exact: true }).click();
  await page
    .locator('aside section[aria-label="智能文件夹"] button[aria-pressed]')
    .filter({ hasText: "带标签的 PNG" })
    .click();
  await expect(page.locator("main footer")).toContainText("1 个文件");
  await expect(
    page.getByRole("button", { name: image.filename, exact: true }),
  ).toBeVisible();
  const after = (await (
    await request.get(`/api/files/${image.id}`, { headers })
  ).json()) as typeof original;
  expect({ id: after.id, folderId: after.folderId, url: after.url }).toEqual({
    id: original.id,
    folderId: original.folderId,
    url: original.url,
  });
  expect(await (await request.get(originalUrl)).body()).toEqual(originalBytes);
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "仅显示相同内容文件", exact: true })
    .check();
  await expect(page.locator("main footer")).toContainText("2 个文件");
  await page.getByRole("button", { name: image.filename, exact: true }).click();
  await expect(
    page
      .getByRole("button", { name: "legacy-identical-copy.png", exact: true })
      .last(),
  ).toBeVisible();
  await page.screenshot({ path: path.join(evidence, "identical-files.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({ path: path.join(evidence, "dark-filters.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator('aside section[aria-label="智能文件夹"] button[aria-pressed]')
    .filter({ hasText: "带标签的 PNG" })
    .click();
  await expect(page.locator("main footer")).toContainText("1 个文件");
  await expect(
    page.getByRole("button", { name: image.filename, exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: path.join(evidence, "mobile-filters.png") });
  const englishContext = await browser.newContext({
    viewport: { width: 1600, height: 950 },
  });
  await englishContext.addInitScript(
    (tokens) => {
      localStorage.setItem("nowen-token", tokens.token);
      localStorage.setItem("nowen-refresh-token", tokens.refreshToken);
      localStorage.setItem("i18nextLng", "en");
      localStorage.setItem("nowen-seen-version", tokens.version);
    },
    {
      ...account,
      version: JSON.parse(
        fs.readFileSync(path.resolve("../package.json"), "utf8"),
      ).version as string,
    },
  );
  const english = await englishContext.newPage();
  english.on("pageerror", (error) => errors.push(error.message));
  await english.goto("http://127.0.0.1:4197/");
  await english.getByLabel("Files", { exact: true }).click();
  await english
    .locator('aside section[aria-label="Smart folders"] button[aria-pressed]')
    .filter({ hasText: "带标签的 PNG" })
    .click();
  await expect(
    english.getByRole("button", { name: "Save as smart folder", exact: true }),
  ).toBeVisible();
  await expect(english.locator("main footer")).toContainText("1 files");
  await english.screenshot({
    path: path.join(evidence, "english-smart-folder.png"),
  });
  await englishContext.close();
  expect(errors).toEqual([]);
});
