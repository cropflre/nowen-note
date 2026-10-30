import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function runBrowserAcceptance({ checkout, evidence, base, password }) {
  const require = createRequire(path.join(checkout, 'frontend/package.json'));
  const { chromium, expect } = require('@playwright/test');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const checks = ['Microsoft Edge ' + browser.version()];
  page.setDefaultTimeout(20_000);
  try {
    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'zh-CN');
      localStorage.setItem('nowen-seen-version', '1.5.1');
    });
    await page.goto(base);
    await page.getByPlaceholder('admin', { exact: true }).fill('qa-owner');
    await page.getByPlaceholder('••••••••', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录工作台', exact: true }).click();
    await expect(page.getByRole('button', { name: '在根目录新建', exact: true })).toBeVisible();
    checks.push('real browser login against built hardened JWT server');
    const token = await page.evaluate(() => localStorage.getItem('nowen-token'));
    for (const format of ['markdown', 'tiptap-json']) {
      const title = 'QA UI ' + format, body = 'QA saved body ' + format;
      await page.getByRole('button', { name: '在根目录新建', exact: true }).click();
      await page.getByRole('menuitem', { name: format === 'markdown' ? 'Markdown 文档' : '富文本文档', exact: true }).click();
      await page.getByLabel('新内容名称', { exact: true }).fill(title);
      await page.getByRole('button', { name: '确认创建', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveValue(title);
      const editor = page.locator(format === 'markdown' ? '.cm-content' : '.tiptap').first();
      await expect(editor).toBeVisible(); await editor.focus();
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(body);
      const readNote = async () => {
        const response = await fetch(base + '/api/notes', { headers: { Authorization: 'Bearer ' + token } });
        const notes = await response.json(); return notes.find((note) => note.title === title);
      };
      await expect.poll(async () => (await readNote())?.contentText, { timeout: 20_000 }).toContain(body);
      await page.screenshot({ path: path.join(evidence, 'browser-' + format + '.png') });
      await page.reload();
      await page.getByText(title, { exact: true }).first().click();
      await expect(page.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveValue(title);
      await expect(page.locator(format === 'markdown' ? '.cm-content' : '.tiptap').first()).toContainText(body);
      checks.push(format + ': UI create and keyboard edit, server body persisted, reload and editor body readback');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('textbox', { name: '笔记标题', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(evidence, 'browser-narrow.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    checks.push('390px viewport editor visible without horizontal page overflow (not Android keyboard acceptance)');
    return checks;
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, 'browser-failure.png') }).catch(() => {});
    throw error;
  } finally { await browser.close(); }
}
