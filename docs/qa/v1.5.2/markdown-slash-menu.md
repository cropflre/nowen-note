# Issue #853 — Markdown 悬浮快捷命令验收

日期：2026-10-16。目标分支：`release/v1.5.2`；本次功能尚未发布，安装包与真机验收待完成。

## 需求与范围

[Issue #853](https://github.com/cropflre/nowen-note/issues/853) 希望在 Markdown 编辑时输入 `/` 显示可搜索的命令菜单，支持 `/H1`、`/code`、`/tab`，用于各平台。

现有 `MarkdownEditorImpl` 已接入 `MarkdownSlashMenu`、Markdown 原子命令及日期命令。复用这些入口，修复可用性问题，无新增笔记格式、API、数据库迁移或同步协议。

## 问题与实现

- 原插件直接在 CodeMirror 插件更新中调用 `coordsAtPos`。CodeMirror 禁止更新阶段读取布局，导致插件可能抛错并失效。改用 `requestMeasure`，合并测量请求，并处理滚动、焦点、销毁及菜单关闭状态。
- 标题、列表等前缀插入后，空光标仍停在标记前，后续输入出现在 `# ` 或列表标记前。通过变更映射将光标置于前缀后；真实浏览器回归验证连续输入。
- 代码块命令读取选区，却替换整行范围，造成行内 `/code` 两侧文字被删除。仅替换实际选区，并保留独立代码块所需换行。
- 菜单按可见视口宽高限制尺寸，支持向上翻转和 Visual Viewport 变化；菜单项至少 44px 高，支持点击/触控，显示命令名并标记列表选项角色。
- 代码、只读、非空选区、多光标和输入法组合输入不执行命令；执行前重新检查当前上下文，阻止过期选项写入。
- Escape、外部点击、失焦关闭时保留输入；执行命令与删除查询合并为一次可撤销操作。

## 实际验证

| 检查 | 实际结果 |
| --- | --- |
| 修复前新增回归 | 19 项中 9 项失败，包含代码环境误触发、丢失邻近文字、多光标及撤销边界；菜单角色和定位检查亦失败 |
| 斜杠菜单专项 Vitest | 27/27 通过；含真实 CM 坐标读取、命令插入、连续输入、键盘选择、取消、只读、IME、原文保留、Visual Viewport 及单步撤销 |
| 相关编辑器、日记命令与 i18n Vitest | 共 6 文件、71/71 项通过 |
| 前端生产构建 | `npm run build` 通过（TypeScript、Vite、同步提示 UI 检查） |
| Playwright Chromium | 1440、320、390px 共 3/3 通过 |
| 浏览器实际行为 | `/H1` 后继续输入；`/code` 通过 Tab 或触控选择；服务端保存完整正文；刷新后代码仍可读；`/tab` 插入表格；`/` 菜单在视口内并可用 Escape 关闭；未出现页面或 CM 插件异常 |
| 截图检查 | 已查看 320px 截图，菜单完整位于视口内，命令、描述和触控行可读 |
| 局部 ESLint | 菜单与新增单测 0 errors，3 条既有 mixed-export Fast Refresh warnings |
| DCC 映射 | `--verify` 通过：12 条不变量、159 个真实测试引用 |
| Diff | `git diff --check` 通过 |

运行命令（在 `frontend/`）：

```bash
npm run test:run -- \
  src/components/__tests__/MarkdownSlashMenu.test.tsx \
  src/components/__tests__/MarkdownEditor.photoUpload.test.tsx \
  src/components/daily-records/__tests__/markdownDailyRecordSlashCommands.test.tsx \
  src/components/__tests__/MarkdownEditor.headingLevel.test.ts \
  src/components/__tests__/MarkdownEditor.mobilePreview.test.ts \
  src/i18n/__tests__/releaseI18nCoverage.test.ts
npm run build
npx playwright test --config playwright.markdown-slash.config.ts
npx eslint src/components/MarkdownSlashMenu.tsx src/components/__tests__/MarkdownSlashMenu.test.tsx
```

仓库根目录：`node scripts/data-consistency-contract.mjs --verify`、`git diff --check`。

浏览器夹具复用隔离的生产后端和临时 SQLite，复制构建产物至临时目录，避免共享工作区的其他构建影响加载；不会读取或改写用户数据库。截图保存在系统临时目录 `nowen-853-browser-artifacts`，由 Playwright 输出具体路径。

jsdom 在已有导入链上仍输出不支持 Canvas 的环境提示；构建提示 Browserslist 数据陈旧。这些提示未导致上述检查失败。

## 数据与发布边界

DCC-002、DCC-010、DCC-011 的保存、离线队列和收据语义继续由原有编辑器与保存链路负责；本次不新增成功状态或修改 ACK/Outbox。浏览器回归证明在线服务端持久化与刷新读取，不代表离线多设备同步已重新验收。

未执行：安装版 Electron、Android/iOS 真机、真实软键盘/中文输入法、多设备离线同步和生产部署验收；未检查远端 CI。不能据此宣称所有平台安装包或发布版本已通过。

安装包复测：在 Markdown 源码和分栏模式，输入 `/`、筛选命令、上下选择/触控执行，检查软键盘遮挡、中文输入法确认、撤销、保存并重启重读。使用说明见 [Markdown 斜杠快捷命令](../../user/markdown-slash-commands.md)。

建议提交信息：`fix(editor): make Markdown slash commands reliable`。
