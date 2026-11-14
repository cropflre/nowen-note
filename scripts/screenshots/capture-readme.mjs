#!/usr/bin/env node
/**
 * Nowen Note README 截图自动化。
 *
 * 一条命令完成：登录演示账号 → 准备演示数据 → 桌面/移动端逐页截图 → 输出统计。
 *
 * 用法：
 *   node scripts/screenshots/capture-readme.mjs
 *   node scripts/screenshots/capture-readme.mjs --base-url http://127.0.0.1:5173 --out docs/screenshots
 *
 * 环境变量（均可选）：
 *   NOWEN_SHOT_BASE_URL    前端地址，默认 http://127.0.0.1:5173
 *   NOWEN_SHOT_USER        演示账号，默认 demo
 *   NOWEN_SHOT_PASSWORD    演示密码，默认 demo123456
 *   NOWEN_SHOT_OUT         截图输出目录，默认 docs/screenshots
 *   NOWEN_SHOT_SKIP_DATA=1 跳过演示数据准备
 *
 * 安全约定：
 *   - 只连接本机开发环境；账号可用环境变量覆盖，默认值是 README 已公开的演示账号，
 *     不涉及生产环境，也不会写入任何真实笔记、Token 或 API Key；
 *   - 写入的笔记 / 任务均为虚构演示内容；若目标实例关闭了注册，请先手动创建账号，
 *     再用 NOWEN_SHOT_USER / NOWEN_SHOT_PASSWORD 指定。
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loginOrRegister, seedDemoWorkspace, touchDemoNotes } from "./demo-content.mjs";

const argv = process.argv.slice(2);
const argValue = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const outDir = path.resolve(repoRoot, argValue("--out") || process.env.NOWEN_SHOT_OUT || "docs/screenshots");

const config = {
  baseUrl: argValue("--base-url") || process.env.NOWEN_SHOT_BASE_URL || "http://127.0.0.1:5173",
  username: process.env.NOWEN_SHOT_USER || "demo",
  password: process.env.NOWEN_SHOT_PASSWORD || "demo123456",
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  locale: "zh-CN",
};

const requireFromFrontend = createRequire(path.join(repoRoot, "frontend", "package.json"));
const { chromium } = requireFromFrontend("@playwright/test");

const results = [];
const failures = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  console.log(message);
}

async function settle(page, { timeout = 1200 } = {}) {
  await page.evaluate(() => (document.fonts?.ready ? document.fonts.ready : Promise.resolve()));
  await page.evaluate(() => {
    document.activeElement?.blur?.();
  });
  await page.mouse.move(2, 2).catch(() => {});
  await sleep(timeout);
}

async function capture(page, name, { mobile = false } = {}) {
  const file = path.join(outDir, `${name}.png`);
  try {
    await settle(page);
    await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
    const bytes = statSync(file).size;
    results.push({ name, bytes });
    log(`  ✓ ${name}.png (${Math.round(bytes / 1024)} KB)`);
  } catch (error) {
    failures.push({ name, error: String(error).slice(0, 300) });
    log(`  ✗ ${name}.png 失败：${String(error).slice(0, 200)}`);
    const debugFile = path.join(outDir, `_debug-${name}.png`);
    await page.screenshot({ path: debugFile, fullPage: false }).catch(() => {});
  }
}

async function clickIfVisible(locator, { timeout = 2500 } = {}) {
  const count = await locator.count().catch(() => 0);
  if (!count) return false;
  try {
    await locator.first().click({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function dismissOverlays(page) {
  for (const label of ["我知道了", "知道了", "跳过", "以后再说", "关闭"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    if (await button.count().catch(() => 0)) {
      await clickIfVisible(button);
      await sleep(600);
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(400);
}

async function login(page, { mobile = false } = {}) {
  await page.goto(config.baseUrl, { waitUntil: "domcontentloaded" });
  const username = page.locator('input[placeholder="admin"], form input[type="text"]').first();
  await username.waitFor({ timeout: 120000 });
  await username.fill(config.username);
  await page.locator('input[type="password"]').first().fill(config.password);
  await page.locator('button[type="submit"]').first().click();

  const readyText = mobile ? "所有笔记" : "当前空间";
  await page.waitForFunction(
    (needle) => document.body.innerText.includes(needle),
    readyText,
    { timeout: 120000 },
  ).catch(() => {});
  await sleep(3500);
  await dismissOverlays(page);
  await sleep(1000);
}

async function openRail(page, label) {
  const button = page.locator(`button[aria-label="${label}"]`).first();
  if (await button.count().catch(() => 0)) {
    await button.click({ force: true }).catch(() => {});
    await sleep(2200);
    return true;
  }
  return false;
}

async function setLayoutMode(page, label) {
  const trigger = page.locator('button[aria-label="布局与侧栏"]').first();
  if (!(await trigger.count().catch(() => 0))) return false;
  await trigger.click({ force: true }).catch(() => {});
  await sleep(900);
  const option = page.getByText(label, { exact: true }).first();
  if (await option.count().catch(() => 0)) {
    await option.click({ force: true }).catch(() => {});
    await sleep(1600);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(700);
  return true;
}

async function scrollTreeToTop(page) {
  await page.evaluate(() => {
    const aside = document.querySelector("aside");
    if (!aside) return;
    const scrollers = Array.from(aside.querySelectorAll("div")).filter(
      (node) => node.scrollHeight > node.clientHeight + 40,
    );
    for (const node of scrollers) node.scrollTop = 0;
  });
  await sleep(400);
}

/** 通过「更多目录操作 → 展示层级」批量控制知识树展开深度。 */
async function setTreeDepth(page, label) {
  const more = page.locator('button[aria-label="更多目录操作"]').first();
  if (!(await more.count().catch(() => 0))) return false;
  await more.click({ force: true }).catch(() => {});
  await sleep(800);
  const item = page.getByText(label, { exact: true }).first();
  if (await item.count().catch(() => 0)) {
    await item.click({ force: true }).catch(() => {});
    await sleep(1600);
    await scrollTreeToTop(page);
    return true;
  }
  await page.keyboard.press("Escape").catch(() => {});
  return false;
}

async function openNote(page, title, { root = "aside", expectText = "", retries = 2 } = {}) {
  const exact = new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const button = page.locator(`${root} button`).filter({ hasText: exact }).first();
    if (!(await button.count().catch(() => 0))) {
      await sleep(600);
      continue;
    }
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click({ force: true }).catch(() => {});
    await sleep(2400);
    if (!expectText) return true;
    const body = await page.locator("body").innerText().catch(() => "");
    if (body.includes(expectText)) return true;
    await sleep(800);
  }
  log(`  ! 未能确认打开「${title}」`);
  return false;
}

async function setMarkdownPreview(page) {
  const preview = page.getByRole("button", { name: "预览", exact: true }).first();
  if (await preview.count().catch(() => 0)) {
    await preview.click({ force: true }).catch(() => {});
    await sleep(1800);
    return true;
  }
  return false;
}

async function captureDesktop(browser, { token }) {
  log("\n[desktop] 1440×900 @2x");
  const context = await browser.newContext({
    viewport: config.desktop,
    deviceScaleFactor: config.deviceScaleFactor,
    locale: config.locale,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await login(page);

  if (token) {
    await touchDemoNotes({ baseUrl: config.baseUrl, token });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.innerText.includes("当前空间"), null, { timeout: 60000 });
    await sleep(3000);
    await dismissOverlays(page);
  }

  // 三栏布局：知识树 + 笔记列表 + 编辑器
  await setLayoutMode(page, "三栏模式");
  await setTreeDepth(page, "展开到第 3 层");
  await openNote(page, "AI 应用开发笔记", { expectText: "把大模型接进笔记应用" });
  await setMarkdownPreview(page);
  await capture(page, "desktop-overview");

  // 知识树与文档管理
  await setTreeDepth(page, "展开到第 3 层");
  await openNote(page, "编辑器交互规范", { expectText: "这份规范用于统一桌面端" });
  await setMarkdownPreview(page);
  await capture(page, "desktop-knowledge-tree");

  // 富文本编辑器
  await setLayoutMode(page, "标准模式");
  await openNote(page, "Sprint 25 需求评审", { expectText: "这次评审聚焦" });
  await page.keyboard.press("Escape").catch(() => {});
  await capture(page, "desktop-editor");

  // Markdown 分屏
  await openNote(page, "Markdown 使用指南", { expectText: "Nowen Note 的 Markdown 笔记支持实时预览" });
  const split = page.getByRole("button", { name: "分屏", exact: true }).first();
  if (await split.count().catch(() => 0)) {
    await split.click({ force: true }).catch(() => {});
    await sleep(2200);
  }
  await capture(page, "desktop-markdown");

  // AI 写作助手
  await openNote(page, "AI 应用开发笔记", { expectText: "把大模型接进笔记应用" });
  await setMarkdownPreview(page);
  const aiButton = page.getByRole("button", { name: /AI 助手/ }).first();
  if (await aiButton.count().catch(() => 0)) {
    await aiButton.click({ force: true }).catch(() => {});
    await sleep(2600);
    const prompt = page.getByPlaceholder(/例如：整理这篇笔记/).first();
    if (await prompt.count().catch(() => 0)) {
      await prompt.fill("把「踩过的坑」整理成三条要点，并补一段结论。").catch(() => {});
      await sleep(900);
    }
  }
  await capture(page, "desktop-ai-writing");
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(600);

  // 任务中心
  await openRail(page, "待办事项");
  await sleep(1500);
  const collapse = page.locator('button[aria-label="收起侧栏"]').first();
  if (await collapse.count().catch(() => 0)) {
    await collapse.click({ force: true }).catch(() => {});
    await sleep(1200);
  }
  await capture(page, "desktop-tasks");

  // AI 服务商配置
  const settings = page.locator('button[aria-label="设置"]').first();
  if (await settings.count().catch(() => 0)) {
    await settings.click({ force: true }).catch(() => {});
    await sleep(2000);
    const aiTab = page.getByText("AI 助手", { exact: true }).last();
    if (await aiTab.count().catch(() => 0)) {
      await aiTab.click({ force: true }).catch(() => {});
      await sleep(2400);
    }
    await page.evaluate(() => {
      const scrollers = Array.from(document.querySelectorAll("div")).filter(
        (node) => node.scrollHeight > node.clientHeight + 120 && node.clientHeight > 300,
      );
      const target = scrollers[scrollers.length - 1];
      if (target) target.scrollTop = 200;
    });
    await sleep(900);
  }
  await capture(page, "settings-ai");

  await context.close();
}

async function captureMobile(browser) {
  log("\n[mobile] 390×844 @2x");
  const context = await browser.newContext({
    viewport: config.mobile,
    deviceScaleFactor: config.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    locale: config.locale,
    colorScheme: "light",
    reducedMotion: "reduce",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  await login(page, { mobile: true });

  // 笔记列表
  await capture(page, "mobile-list", { mobile: true });

  // 侧边栏与知识树
  const menu = page.locator("header button").first();
  if (await menu.count().catch(() => 0)) {
    await menu.click({ force: true }).catch(() => {});
    await sleep(1600);
    const kb = page.getByText("我的知识库", { exact: true }).first();
    if (await kb.count().catch(() => 0)) {
      await kb.click({ force: true }).catch(() => {});
      await sleep(1600);
    }
    const design = page.getByText("产品设计", { exact: true }).first();
    if (await design.count().catch(() => 0)) {
      await design.click({ force: true }).catch(() => {});
      await sleep(1600);
    }
  }
  await capture(page, "mobile-sidebar", { mobile: true });

  // 移动端编辑器
  const note = page.getByText("Sprint 25 需求评审", { exact: true }).first();
  if (await note.count().catch(() => 0)) {
    await note.click({ force: true }).catch(() => {});
    await sleep(3000);
  }
  await capture(page, "mobile-editor", { mobile: true });

  await context.close();
}

async function main() {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  log("Nowen Note README 截图");
  log(`  地址：${config.baseUrl}`);
  log(`  输出：${path.relative(repoRoot, outDir)}`);
  log(`  账号：${config.username}`);

  let token = null;
  if (!process.env.NOWEN_SHOT_SKIP_DATA) {
    log("\n[data] 准备演示数据…");
    token = await loginOrRegister({
      baseUrl: config.baseUrl,
      username: config.username,
      password: config.password,
    });
    await seedDemoWorkspace({ baseUrl: config.baseUrl, token, log });
  }

  const browser = await chromium.launch();
  try {
    await captureDesktop(browser, { token });
    await captureMobile(browser);
  } finally {
    await browser.close();
  }

  log("\n[summary]");
  log(`  成功 ${results.length} 张，失败 ${failures.length} 张`);
  for (const item of results) log(`   - ${item.name}.png  ${Math.round(item.bytes / 1024)} KB`);
  for (const item of failures) log(`   ! ${item.name}: ${item.error}`);
  if (failures.length) process.exitCode = 1;
}

await main();
