import { expect, test } from "@playwright/test";
import JSZip from "jszip";

test("XLSX lazy preview scrolls on desktop and mobile and imports only the chosen worksheet", async ({ page }, testInfo) => {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="预算" r:id="r1"/><sheet name="说明" r:id="r2"/></sheets></workbook>');
  zip.file("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="r1" Type="a/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="a/worksheet" Target="worksheets/sheet2.xml"/></Relationships>');
  const rows = Array.from({ length: 1000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${i === 0 ? "名称" : `项目 ${i}`}</t></is></c><c r="H${i + 1}"><v>${i + 1}</v></c></row>`).join("");
  zip.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData>${rows}</sheetData></worksheet>`);
  zip.file("xl/worksheets/sheet2.xml", '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>内容</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>第二工作表</t></is></c></row></sheetData></worksheet>');
  const original = await zip.generateAsync({ type: "nodebuffer" });
  const mutations: any[] = [];
  await page.route("**/fixture.xlsx*", route => route.fulfill({ body: original, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  await page.route("**/api/knowledge-tree/**", route => {
    if (route.request().method() === "POST") {
      mutations.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { id: "created", resourceId: "new-sheet" } });
    }
    return route.fulfill({ json: { nodes: [{ id: "folder", resourceType: "notebook", title: "数据目录", access: { capabilities: { canCreate: true } } }] } });
  });
  await page.goto("/e2e/xlsx-preview.html");
  await expect(page.getByRole("tab", { name: "预算", exact: true })).toBeVisible();
  await expect(page.getByText("名称", { exact: true })).toBeVisible();
  const grid = page.locator('[data-swipe-blocker="sheet-grid"]');
  expect(await grid.locator("tbody tr").count()).toBeLessThan(90);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const left = await grid.evaluate(element => { element.scrollLeft = 200; return element.scrollLeft; });
  if (testInfo.project.name === "mobile") expect(left).toBeGreaterThan(0);
  await grid.evaluate(element => { element.scrollTop = 31000; });
  await expect(page.getByText("项目 970", { exact: true })).toBeAttached();
  await expect(grid.locator("thead")).toBeVisible();
  expect(await grid.locator("tbody tr").count()).toBeLessThan(90);
  await page.getByRole("tab", { name: "说明", exact: true }).click();
  await expect(page.getByText("第二工作表", { exact: true })).toBeVisible();
  expect(mutations).toHaveLength(0);
  await page.getByRole("button", { name: "导入为轻量表格", exact: true }).click();
  await page.getByRole("combobox", { name: "目标目录", exact: true }).selectOption("folder");
  expect(mutations).toHaveLength(0);
  await page.getByRole("button", { name: "导入工作表：说明", exact: true }).click();
  await expect.poll(() => mutations.length).toBe(1);
  expect(mutations[0]).toMatchObject({ parentId: "folder", nodeType: "sheet", title: "预算 · 说明", sheetData: { cells: { "r1:c1": "第二工作表" } } });
  await expect(page.getByRole("button", { name: "导入工作表：说明", exact: true })).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("xlsx-preview.png"), fullPage: true });
});
