# React 19 升级验证（2026-10-28）

## 范围

- 分支：`release/v1.5.4`；本次提交仅包含 React 升级，工作区原有 Node 24 / Electron 43 升级改动单独保留。
- 主前端和 Release Center：React / React DOM 从 `18.3.1` 升至 `19.3.1`；类型包升至 `19.3.0`。
- 沿用各包原有的版本范围风格，更新各自 lockfile；仅升级 React、类型与必需的 scheduler，保留其他依赖版本。
- 按 [React 官方迁移指南](https://react.dev/blog/2024/04/25/react-19-upgrade-guide) 适配 `useRef` 初值、可空 `RefObject`、`React.JSX`、`ReactElement` props 类型，以及测试的 `act` 导入。
- React 19 会移除空字符串的媒体 `src`。两个视频渲染入口在授权尚未就绪时显式省略 `src`，测试同时验证授权到达后重新加载正确地址。
- 更新根目录中英文 README 和 frontend README 中的 React 版本说明。
- 修正两处浏览器测试的过时前提：Electron 的已读更新版本从固定 `1.5.1` 改为项目版本；图片源码复制断言与现有 `/api/f/:token.png` 短链路由对齐，仍验证匿名访问成功且没有暴露临时授权参数。

版本来源：[React 19.3.1 官方发布记录](https://github.com/react/react/releases/tag/v19.3.1) 及执行时 npm `latest`。

## 验证结果

环境：macOS arm64，Node `24.22.1`，npm `11.19.1`；浏览器使用 Playwright Chromium。

| 检查 | 结果 |
| --- | --- |
| 升级前主前端 `tsc -b` | 通过 |
| 升级后主前端 `npm run build`（含 TypeScript / Vite / 同步提示 UI 检查） | 通过 |
| 两处 `npm ls react react-dom @types/react @types/react-dom --all` | 通过，无 peer dependency 冲突，React / DOM 均为 19.3.1 |
| 主前端全量 Vitest，升级前 | 723 个文件：711 通过、12 失败；4106 个用例：4096 通过、10 失败；另有 2 个未处理错误 |
| 主前端全量 Vitest，升级后 | 同样的 12 个文件、10 个用例失败；失败集合与升级前完全一致；无新增失败 |
| 最后一次视频入口调整后的定向 Vitest | 8 个文件、57 个用例全部通过 |
| Release Center `npm run build` | 通过 |
| Release Center `npm test` | 135 个用例通过 |
| Release Center `npm run test:browser` | 10 个用例通过，覆盖桌面、窄屏、深色及发布禁用状态 |
| 产品 Chromium 任务创建 | 桌面 / 窄屏流程通过 |
| 产品 Electron 43 任务创建 | 修正版本弹窗测试前提后通过 |
| 富文本 / Markdown 斜杠菜单浏览器检查 | 5 个用例通过，覆盖 1440px / 390px 等视口 |
| Markdown 图片上传、保存重开、预览、源码复制和匿名访问 | 对齐现有短链断言后通过 |
| DCC 映射 `node scripts/data-consistency-contract.mjs --verify` | 12 项契约、213 项测试引用通过；映射检查不代替行为验收 |
| `git diff --check`（本次涉及路径） | 通过 |

全量命令：`npm --prefix frontend run test:run -- --maxWorkers=4 --minWorkers=1`。

定向检查覆盖 `VideoExtension`、`useAttachmentVideoRenderSource`、`PlainTextEditor`、`TaskQuickAdd`、`TaskContextMenu`、`useLazyNodeView`、`SiyuanRichTextCalloutBridge` 和 `noteAttachmentAccessBridge`。附件读取仍走已有授权链路，DCC-006 的账号 / 服务器隔离边界未改变；未修改数据写入、Outbox 或恢复协议。

## 既有失败

本节记录初次升级的基线；这些失败已在文末的第二阶段本地回归中全部修复。

以下失败在 React 18 的同一工作区已存在，本次未修改这些功能来使测试通过：

- `LargeMarkdownSafeEditor.preview`、`MarkdownPreview.calloutTypes`、`MarkdownPreview.html`、`StatsCenter`、`markdownCodeBlockFormatting`：`react-i18next` mock 缺少 `initReactI18next`。
- `LoginPageSiteSettingsProviderIcp`：mock 初始化失败。
- `releaseI18nCoverage`：缺少 `auth.login` 翻译。
- `DesktopSidebarReadability`、`EditorPaneMobileHeader`、`PublicNotebookReadOnlyPermissions`：源码字符串契约断言不匹配。
- `FileOrganization`：5 个用例失败；React 18 基线另报 2 个未处理错误。
- `apiFileUpload`：上传 headers 断言不匹配。

## 平台与环境限制

- 原始产品浏览器测试因 backend 的 `better-sqlite3` 是 x86_64、运行时是 arm64 而无法启动。
- 为隔离验证，在 `/tmp/nowen-react-native` 复制该原生依赖，并仅在临时目录为 Electron `43.8.4` arm64 重建，通过临时 `NODE_OPTIONS` loader 重定向该二进制；没有重建或替换工作区的后端原生库。
- Release Center 浏览器测试生成的已有截图已恢复，新的测试截图留在临时目录。
- Vite 仍报告既有大 chunk / Browserslist 数据提示。
- 尚未执行 Android / iOS / HarmonyOS 真机验收、远程 CI 或发布。

## 第二阶段：测试收尾（2026-10-28）

起点为 `fc0b6eed382648e9593420e04f47811641ea7dda`，本节记录其上的测试收尾变更。上述初次升级的测试与环境限制保留为历史证据，以本节更新项为准。

先定向重现全部 12 个失败文件，再逐项修复：

- 6 个 i18n mock 改为保留真实模块导出，只覆盖组件所需的翻译 hook，避免丢失 `initReactI18next`。
- 列表行高、桌面工具栏和只读编辑入口断言与当前代码对齐；四个可编辑入口均继续受权限、锁定和切换状态约束。
- 文件组织用例使用当前目录选择按钮，并校验移动请求携带原目录前置条件；标签与描述组件使用独立 mock，其各自的回归另行通过。保留移动失败、只读文件、外部访问失败及迟到响应保护用例。
- 上传断言兼容标准 `Headers`，同时检查 Bearer 授权和由浏览器设置 multipart Content-Type。
- 唯一产品代码修改是授权过期时的登录按钮复用已有 `auth.loginButton` 翻译键；新增中英文显示回归。没有更改登录动作或同步流程。

最终本地结果：

| 检查 | 结果 |
| --- | --- |
| `npm --prefix frontend run test:run -- --maxWorkers=4 --minWorkers=1` | **723 个文件、4150 个用例全部通过**，退出码 0 |
| `npm --prefix frontend run build` | TypeScript、Vite 和同步提示 UI 检查通过 |
| 文件组织、移动同步设置、标签与描述定向回归 | 通过；全量检查包含新增的过期授权翻译用例 |
| `git diff --check` | 通过 |

全量测试仍输出 jsdom Canvas 等非阻塞环境提示，生产构建仍有既有 chunk 大小和 Browserslist 提示。

已在线核实起点提交 `fc0b6eed` 触发的以下 6 项 Actions 均已完成且成功：

- [Editor UX](https://github.com/cropflre/nowen-note/actions/runs/40664918100)
- [Extension Ecosystem V2 RC1](https://github.com/cropflre/nowen-note/actions/runs/40664917969)
- [Extension Platform V2.1](https://github.com/cropflre/nowen-note/actions/runs/40664917995)
- [Voice Memo](https://github.com/cropflre/nowen-note/actions/runs/40664917963)
- [Editor Agent P0](https://github.com/cropflre/nowen-note/actions/runs/40664917953)
- [Encrypted Notes](https://github.com/cropflre/nowen-note/actions/runs/40664918060)

这些 CI 结果仅覆盖起点提交，不覆盖本节修复，也不代表正式发布验收。仍需本轮修复对应的 CI、签名安装包与旧版覆盖升级验证、移动端真机和真实 NAS / 生产环境验收。
