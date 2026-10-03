# Excel 附件预览与导入

点击 `.xlsx` 附件即可打开只读数据预览。Web、桌面端和移动端使用同一预览入口。顶部可切换工作表；表格支持纵向和横向滚动，列标与行号保持可见。

预览保留 Excel 的第一行和原始行号。文本、数字、布尔值、日期及文件保存时的公式缓存结果可显示。公式没有缓存结果时显示空白，不重新计算公式，也不执行宏或单元格中的脚本。

选择「导入为轻量表格」，选择当前工作区根目录或有创建权限的文件夹，再确认导入。仅当前工作表会创建为一个独立的轻量表格，第一行作为列名。原 Excel 附件不会被修改或覆盖。新表格可在目录树中打开、编辑。

这是数据预览与数据导入，不提供完整 Excel 排版：图表、数据透视表、合并单元格、条件格式、宏和完整样式不保留。日期按日期值显示，不保留完整时间或 Excel 的显示格式。需要原版排版或公式计算时，请选择「下载原文件」并在 Excel / WPS 中打开。

预览限制：

- 文件最多 20 MB，展开 XML 合计最多 64 MB。
- 最多 20 个工作表，每表最多 1000 行、200 列。
- 所有工作表的行数 × 列数合计最多 20 万单元格，每个单元格最多 2 万字符。
- 导入还受轻量表格保存接口限制：最多 5 万个有值单元格。

超出限制时会明确拒绝预览或导入，保留原文件下载入口，不静默截断。损坏或加密的工作簿也提供下载兜底。旧 `.xls`、`.xlsm`、`.xlsb`、`.ods` 和 Numbers 文件暂不支持内联数据预览，沿用系统打开或下载。

## 开发与回归

`sheetXlsx.ts` 的底层 ZIP/XML 与单元格读取逻辑由 `parseWorkbookXlsx` 和既有 `parseSheetXlsx` 共用。前者保留原始首行供预览，后者仍以首行作为列名并导入第一个工作表，兼容既有最多 1000 个数据行的导入行为。只读网格与 `SheetEditor` 共用 `SheetGrid`；只读模式按滚动位置限制挂载行数。

附件 XLSX 组件懒加载。读取前检查附件大小和 HTTP 长度，读取流期间检查实际大小；ZIP 展开先检查声明的 XML 总大小，再在流式解压时检查实际大小。创建接口 `POST /api/knowledge-tree/nodes` 的可选 `sheetData` 参数使用与保存接口相同的数据验证，在已有创建事务内同时写入笔记壳、表格数据和导航节点，遵循目标目录的 `canCreate` 权限。

运行回归：

```sh
cd frontend
npx vitest run src/lib/__tests__/sheetXlsx.test.ts src/lib/__tests__/workbookXlsx.test.ts src/lib/__tests__/attachmentXlsx.test.ts src/lib/__tests__/attachmentOpenStrategy.test.ts src/components/__tests__/AttachmentXlsxPreview.test.tsx src/components/__tests__/SheetGrid.test.tsx
npx playwright test --config playwright.xlsx-preview.config.ts
cd ../backend
node --import tsx --test --test-concurrency=1 tests/lightweight-sheets.test.ts tests/lightweight-sheets-route.test.ts tests/xlsx-sheet-import.test.ts
```
