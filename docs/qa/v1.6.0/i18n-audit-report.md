# v1.6.0 国际化审计记录（部分完成）

日期：2026-11-14；起点：`release/v1.6.0` 的 `16e84acd1`。本记录只覆盖本次实际审计与验证，不能代表全站国际化验收通过。

## A. 范围和方法

- 中文 `zh-CN`、英文 `en`；检查 `frontend/src/i18n/index.ts`、两套基础 JSON、所有通过该入口合并的 Translation Patch、运行时覆盖、`legacySettingsI18nBridge.ts` 以及现有覆盖测试。
- 现有 `releaseI18nCoverage.test.ts` 从实际 `i18n.getResourceBundle` 取得生产初始化后的资源，而非单独比较 JSON。两套语言使用相同的补丁顺序，运行时覆盖最后合并；默认语言检测顺序为 localStorage、浏览器，回退为中文。
- `git ls-files` 显示 `frontend/src` 共 1,817 个 TS/TSX 路径（含测试）。`scripts/i18n-audit.mjs` 对其中 403 个非测试 TSX 文件做 AST 候选扫描：JSX 文本、`title`、`aria-label`、`placeholder`、`alt` 直接字符串和直接 JSX 字符串表达式。它不会扫描所有 TS 计算、模板字面量、三元表达式、对象属性、服务端消息或动态 key；报告中的候选不是确认的缺陷。
- 与本地记录的 `origin/main`（`4c4ec8a78`）三点比较，目标分支对 `frontend/src` 涉及 102 个文件。只用此差异定位优先范围，没有修改或合并 main。
- 兼容桥仍限定设置弹窗作用域；本次没有扩大 DOM 扫描或把用户内容、第三方插件名称和描述交给翻译。

## B. 实测统计

| 项目 | 基线 | 本次修改后 | 方法与限制 |
| --- | ---: | ---: | --- |
| 中文硬编码候选 | 1,568 | 1,560 | AST，403 个 TSX 文件，见上述范围；不能推断其他表达式无缺陷 |
| 英文硬编码候选 | 11 | 6 | 两个以上英文单词的直接 JSX/属性候选；可能包含技术术语、示例和快捷键 |
| 候选所在文件 | 121 | 118 | 中文、英文候选合并去重 |
| 完整运行时资源中静态引用的缺失 key | 0 | 0 | 现有 literal key 测试；动态 key 未穷举 |
| 运行时资源中双语插值不一致 | 0 | 0 | 现有资源叶子测试；不验证每个调用传入的实际参数 |
| 无效非字符串叶子 | 未单独统计 | 0 | 本次新增递归测试 |
| 空值 | 未单独统计 | 7 个有意例外、其余 0 | 迁移 idle、5 个任务无动作状态，以及英文日历数字月无后缀；白名单按完整 key 限定 |
| 确认的语言切换/日期问题 | 1 个模板弹窗 | 已修复该处 | 不代表其他页面没有同类问题 |
| 翻译质量问题、全站布局问题 | NOT_TESTED | NOT_TESTED | 未完成全站人工语义/布局审查，不推断为 0 |

复现：仓库根目录运行 `node scripts/i18n-audit.mjs --base` 对比当前 HEAD，或 `node scripts/i18n-audit.mjs --json > /tmp/nowen-i18n-audit.json` 导出可逐行检查的当前候选。提交后 `--base` 对比的是新的 HEAD；上表基线是 `16e84acd1`。

## C. 修复明细

1. `frontend/src/components/NoteTemplatePickerDialog.tsx`：模板管理和创建弹窗的标题、说明、空状态、删除确认、加载/错误回退与无障碍标签使用 `noteTemplatePicker.*`；原有后端错误消息仍按原契约展示。模板名称和第三方插件数据不翻译。时间格式使用当前 i18n 语言。Vitest 验证弹窗开启时双向切换并保留模板数据；Playwright 验证双视口的英文、切换中文、刷新与弹窗边界。
2. `frontend/src/components/HtmlPreviewPane.tsx`：iframe 的 `HTML Preview` 标题复用 `editor.htmlPreview.switchToPreview`；`frontend/src/components/SettingsModal.tsx`：站点图标 alt 复用 `settings.siteIcon`。运行时资源完整性测试通过。
3. `frontend/src/components/MindMapEditor.tsx`：节点缩放辅助标签由父组件传入当前语言，避免为每个节点新增订阅；`frontend/src/components/tasks/CalendarExportTargetSettings.tsx` 路径前缀和 `PluginPromptPicker.tsx` 内置提示词包标签使用现有 i18n。插件贡献内容和用于 AI 的上下文不被自动翻译。相关思维导图和插件测试通过。
4. `frontend/src/i18n/__tests__/releaseI18nCoverage.test.ts` 新增真实合并资源的无效值与空值检查；`scripts/i18n-audit.mjs --guard` 对模板弹窗和两个知识树搜索控件的直接可见硬编码设防，其他文件的候选只报告，未静默忽略为通过。`frontend/package.json` 提供 `npm run i18n:check`；`.github/workflows/i18n-release-ci.yml` 将此检查加入现有工作流并使其在 `release/v1.6.0` 推送时运行。CI 目前不执行本次 Playwright 验收。

## D. 验证

环境：macOS、Node 24.22.1、npm 11.19.1；浏览器为 Playwright Chromium。Playwright 服务使用 `scripts/run-files-assets-qa-server.mjs` 及新建临时数据库，不连接用户真实数据。

| 命令 | 结果 |
| --- | --- |
| `cd frontend && npm run i18n:check` | PASS：5 文件、38 测试；真实资源 key/插值、值检查和组件测试 |
| `cd frontend && npm run test:run -- src/components/__tests__/PluginPromptPicker.test.tsx src/components/__tests__/MindMapEditor.documentMode.test.tsx src/components/__tests__/MindMapUxGuards.test.ts` | PASS：3 文件、20 测试 |
| `cd frontend && npm run build` | PASS：含 `tsc -b`、生产 Vite 构建和后续检查；有已有 chunk/Browserslist 提示 |
| `cd frontend && npx playwright test --config playwright.i18n-audit.config.ts` | PASS：2 测试，1440×900 与 390×844；模板弹窗的英文显示、界面切换中文、刷新保存及弹窗位置和尺寸 |
| `cd frontend && npm run lint` | FAIL：1,447 errors、282 warnings；输出包含大量未修改的项目文件。本次涉及的模板组件、其测试、提示词组件及测试、i18n 测试、Playwright 配置与用例单独 ESLint 通过；4 个其余改动组件分别与 HEAD 的 ESLint 报告按规则和消息比较，新增问题均为 0；全量其他文件未逐项归因 |
| `git diff --check` | PASS |

本次最初的新增空值检查暴露了 7 个有意空值，经检查调用方后仅按完整路径添加例外；最初插件提示词测试因期望旧的固定英文而失败，已改用真实 i18n 并重新通过。

## E. 剩余问题和风险

- **未完成全站审计。** 1,560 条中文、6 条英文直接 JSX 候选尚未逐条核实，且扫描不覆盖动态字符串和服务端错误。优先排查笔记本分享、分享管理、文件管理、插件设置、同步冲突和日记。自动候选包含品牌、示例和协议文案，不能批量翻译。
- `frontend/src/components/tasks/CalendarExportTargetSettings.tsx` 等仍有大量中文硬编码；其他涉及插件 Manifest、命令、权限、第三方贡献的文案需按所有权判断，不能直接改写第三方数据。
- 完整资源重复定义、覆盖顺序的语义、未引用/动态 key、日期数字与翻译质量尚未全面人工核实；运行时一致性测试不等价于语义正确。
- Playwright 仅覆盖模板管理、设置语言切换及刷新；登录页面、其他编辑器状态、工作台、插件中心、Studio、AI、任务、导入导出、同步错误与全站溢出均为 **NOT_TESTED**。Android 和 Electron 实机、账号切换与重新打开应用均为 **NOT_TESTED**；未验证 CI 云端运行结果。
- `npm run lint` 全量未通过；需建立基线后逐项治理，不能将其记为通过。
