import { test, expect } from "@playwright/test";

test("wizard, durable Dry Run, SSE logs, and server-enforced disabled publication", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "每一次发布，都有据可查。" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "正式发布 · Phase 2" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "创建发布计划" }).click();
  await page.getByLabel("候选版本").fill("1.5.2");
  await page.getByLabel("发布说明").fill("浏览器回归：计划和 Dry Run");
  await page.getByRole("button", { name: "检查并预览计划" }).click();
  await expect(page.getByText("计划可执行 Dry Run")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "启动调试构建" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "运行 Dry Run" }).click();
  await expect(page.getByLabel("构建日志")).toContainText("dry_run.completed", {
    timeout: 15000,
  });
  await expect(
    page.getByText("Dry Run 只验证计划；未运行编译、打包或发布。"),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Dry Run 只验证计划；未运行编译、打包或发布。"),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("conflicting version remains blocked and renders a failed Dry Run without dispatch", async ({
  page,
}) => {
  await page.goto("/#new");
  await page.getByLabel("候选版本").fill("9.9.9");
  await page.getByRole("button", { name: "检查并预览计划" }).click();
  await expect(page.getByText("存在阻断项")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "启动调试构建" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "运行 Dry Run" }).click();
  await expect(page.getByLabel("构建日志")).toContainText("preflight.failed", {
    timeout: 15000,
  });
});

test("narrow layout, navigation, dark mode and empty state stay usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#artifacts");
  await expect(page.getByText("暂无 Release 资产数据。")).toBeVisible();
  await page.getByRole("button", { name: "切换暗色模式" }).click();
  await expect(page.locator("html")).toHaveClass("dark");
  await page
    .getByRole("navigation", { name: "移动导航" })
    .getByRole("button", { name: "新建发布" })
    .click();
  await expect(page.getByLabel("源码分支")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.locator("html")).toHaveClass("dark");
});

test("archive verification and explicit debug acceptance survive page reload without enabling publication", async ({
  page,
}) => {
  await page.goto("/#artifacts");
  await page
    .getByRole("button", { name: "下载并复核全部平台", exact: true })
    .click();
  await expect(page.getByText("windows · 本机校验通过")).toBeVisible({
    timeout: 15000,
  });
  const accept = page.getByRole("button", {
    name: "记录调试验收",
    exact: true,
  });
  await expect(accept).toBeDisabled();
  await page.getByRole("textbox", { name: /验收版本/ }).fill("1.5.2");
  await page
    .getByRole("checkbox", { name: /我已检查上列文件和固定 SHA/ })
    .check();
  await accept.click();
  await expect(page.getByText("已记录 · 仅调试验收")).toBeVisible();
  await page.reload();
  await expect(page.getByText("已记录 · 仅调试验收")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto("/#builds");
  await expect(
    page.getByRole("heading", { name: "v1.5.2 · 产物复核", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("构建日志")).toContainText("artifact.accepted");
  await page.goto("/#artifacts");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  for (const endpoint of ["/api/publish", "/api/drafts"]) {
    const response = await page.request.post(endpoint, {
      headers: { "X-Release-Center": "1" },
      data: {},
    });
    expect(response.status()).toBe(404);
  }
  await page.goto("/#overview");
  await expect(
    page.getByRole("button", { name: "正式发布 · Phase 2" }),
  ).toBeDisabled();
});
