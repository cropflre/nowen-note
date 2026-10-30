import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const evidence = path.resolve(
  "../docs/qa/files-assets-center-v2/screenshots/phase-d-visual-tools",
);
test("D4 real app: similar images, atomic rename preview, identity and responsive dialogs", async ({
  page,
  request,
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
      if (!localStorage.getItem("i18nextLng")) localStorage.setItem("i18nextLng", "zh-CN");
      localStorage.setItem("nowen-seen-version", tokens.version);
    },
    {
      ...account,
      version: JSON.parse(
        fs.readFileSync(path.resolve("../package.json"), "utf8"),
      ).version as string,
    },
  );
  const before = (await (
    await request.get("/api/files?category=image", { headers })
  ).json()) as {
    items: Array<{ id: string; filename: string; url: string }>;
    accessUrls: Record<string, string>;
  };
  const anchor = before.items.find(
    (file) => file.filename === "项目参考图-1.png",
  )!;
  const bytes = await (await request.get(before.accessUrls[anchor.id])).body();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "插入加密内容", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "文件管理", exact: true }).click();
  await page.getByRole("button", { name: "图片", exact: true }).click();
  await page
    .getByRole("button", { name: anchor.filename, exact: true })
    .click();
  await page.getByRole("button", { name: "查找相似图片", exact: true }).click();
  const similar = page.getByRole("dialog", {
    name: "查找相似图片",
    exact: true,
  });
  await expect(similar).toContainText("当前扫描已完成");
  await expect(
    similar.getByText("legacy-identical-copy.png", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(evidence, "similar-images.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await similar.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: path.join(evidence, "similar-mobile.png") });
  await page.keyboard.press("Escape");
  await expect(similar).toBeHidden();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.getByRole("button", { name: "选择文件", exact: true }).click();
  await page
    .getByRole("button", { name: anchor.filename, exact: true })
    .click();
  await page
    .getByRole("button", { name: "legacy-identical-copy.png", exact: true })
    .click();
  await page.getByRole("button", { name: "批量重命名", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "批量重命名", exact: true });
  await rename.getByLabel("统一名称", { exact: true }).fill("设计参考");
  await expect(rename).toContainText("设计参考-001.png");
  await expect(rename).toContainText("设计参考-002.png");
  await page.screenshot({
    path: path.join(evidence, "batch-rename-preview.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await rename.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: path.join(evidence, "batch-rename-mobile.png"),
  });
  await page.setViewportSize({ width: 1600, height: 950 });
  // Simulate another tab renaming between preview and confirmation.
  const changed = await request.patch(`/api/files/${anchor.id}`, {
    headers,
    data: { filename: "其他窗口已重命名.png" },
  });
  expect(changed.ok()).toBe(true);
  await rename
    .getByRole("button", { name: "确认重命名 2 个文件", exact: true })
    .click();
  await expect(rename.getByRole("alert")).toContainText("本批未修改");
  const duplicate = before.items.find(
    (file) => file.filename === "legacy-identical-copy.png",
  )!;
  expect(
    (
      (await (
        await request.get(`/api/files/${duplicate.id}`, { headers })
      ).json()) as { filename: string }
    ).filename,
  ).toBe(duplicate.filename);
  await page.screenshot({
    path: path.join(evidence, "batch-rename-conflict.png"),
  });
  await rename.getByRole("button", { name: "刷新预览", exact: true }).click();
  await expect(rename).toContainText("其他窗口已重命名.png");
  await rename
    .getByRole("button", { name: "确认重命名 2 个文件", exact: true })
    .click();
  await expect(rename).toBeHidden();
  const renamed = (await (
    await request.get(`/api/files/${anchor.id}`, { headers })
  ).json()) as { id: string; filename: string; references: unknown[] };
  expect(renamed.id).toBe(anchor.id);
  expect(renamed.filename).toMatch(/^设计参考-00[12]\.png$/);
  expect(renamed.references).toHaveLength(3);
  expect(
    await (await request.get(before.accessUrls[anchor.id])).body(),
  ).toEqual(bytes);
  await page.evaluate(() => localStorage.setItem("i18nextLng", "en"));
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: /Insert encrypted content|插入加密内容/,
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Files", { exact: true }).click();
  await page.getByRole("button", { name: "Images", exact: true }).click();
  await page
    .getByRole("button", { name: renamed.filename, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Find similar images", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Find similar images", exact: true }),
  ).toContainText("Current scan complete");
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({
    path: path.join(evidence, "similar-dark-english.png"),
  });
  expect(errors).toEqual([]);
});
