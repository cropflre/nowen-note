# Nowen Extension Experience（1.6.0）— Phase 0 审计、差异矩阵与 ADR

> 状态：Phase 0 交付，仅文档，不改产品代码、合同或用户数据。
> 分支：`feat/extension-platform-experience-v16`（`--no-track`，基于 `origin/release/v1.6.0@088e78469`，2026-11-09）。
> 依据：《NOWEN_EXTENSION_PLATFORM_FULL_DEVELOPMENT_PLAN.md》v1.0 与 `nowen-extension-platform-prototype.html`（独立演示稿，非生产代码）。
> 本文的“已实现”以当前源码和本机实际测试为准；没有运行的检查写明“未运行”。

## 1. 结论

1. 插件平台底座是真实可运行的：V1/V2/V3 Manifest 校验、签名 Registry、隔离安装与权限确认、生命周期与试运行回滚、QuickJS 沙箱、V3 隔离应用页与 Dashboard Widget、Plugin Data、Personal Studio 与 AI 蓝图都有代码和测试。**不需要、也不允许新建第二套插件系统。**
2. 缺口集中在体验层和编辑器合同：
   - 面向普通用户的扩展中心（发现、详情、权限说明、安装状态合并、精选）缺失，现有管理页是管理员工具形态；
   - 工作台只有 V3 插件卡片，没有内置业务卡片、休眠占位、撤销、改名、组件搜索和拖拽反馈；
   - 编辑器扩展合同完全缺失：`editor.slash` / `editor.selection` 没有合同；`menus` 的 `editor.toolbar.actions` 等位置和 Prompt Pack 的 `replace-selection` 只有合同，没有消费者。
3. 基线（§8）：插件专项后端 24 文件 88 项中 85 通过，后端全量 419 文件中 415 通过，前端全量 vitest 4449/4449 通过；SDK 生成物与合同、DCC 映射、后端 tsc、前端构建与 bundle 预算均通过；Plugin Apps E2E 2/2 通过；Markdown 斜杠 E2E 4/9 通过。所有失败均已定位：1 项为既有版本号漂移（真实缺陷），其余为本机环境或既有测试夹具问题，没有一项来自本分支（本分支尚无代码改动）。
4. 进入后续阶段前需要你确认的事项见 §9（D1–D7）。其中 D1（插件宿主版本号）和 D2（官方 AI 文本动作的执行路径）决定 Phase 3 的合同细节，但不阻塞 Phase 1。

## 2. 仓库与并行工作核对

| 项 | 实测 |
| --- | --- |
| 目标基线 | `origin/release/v1.6.0` = `088e78469`，本地与远端一致 |
| 开发分支 | `feat/extension-platform-experience-v16`，未设置上游，避免误推到发行分支 |
| 版本号 | 根 `package.json` 为 1.5.5；插件宿主 `NOWEN_VERSION`（`backend/src/plugins/types.ts:2`）仍为 1.5.3；`EXTENSION_V21_TARGET_NOWEN_VERSION` 为 1.6.0 |
| 合同版本 | `host-api-contract.json` 为 6，`contribution-contract.json` 为 4（已重新核对，与方案一致） |
| 依赖 | React 19.3.1、@tiptap/react 3.30.1、@codemirror/view 6.34.0、framer-motion 12.34、vitest 1.6、Playwright 1.63、TypeScript ~5.6；没有 dnd-kit 等拖拽库 |
| 运行时 | 本机 Node 24.22.1；`backend/node_modules/better-sqlite3` 绑定 Electron 43.8.4（ABI 148），后端测试须用 `ELECTRON_RUN_AS_NODE=1` 运行 Electron 内置的 Node 24.22.1 |
| 维护约束 | release/v1.6.0 已在 `a7c07dcfd` 移除 `nowen-note-development` Skill，核心约束并入 `AGENTS.md §5`（DCC、权限拒绝用例、日志不落正文等），本项目按该节执行 |
| 官方 Registry | `https://cropflre.github.io/nowen-plugin-registry/v2/index.json` 经 301 跳转到 `nowen.cn`（`securePublicFetch` 每跳重新校验）；实测 protocol 2、sequence 4、2027-01-02 过期，只有 `nowenlab.hello`（sandbox-js）和 `nowenlab.wechat-capture`（node-action）两个条目 |

未合并、且与本项目目标文件重叠的分支（`git diff origin/release/v1.6.0...<branch>` 实测）：

| 分支 | 最近提交 | 重叠文件 | 处理 |
| --- | --- | --- | --- |
| `origin/feat/ui-motion-system` | 2026-11-08 `f8f2844d4`（1 个提交，25 个文件） | `App.tsx`、`TiptapEditor.tsx`、`MarkdownEditorImpl.tsx`、`common/CommandPalette.tsx`；另改 `ui/button.tsx`、`ui/confirm.tsx`、`index.css`、`tailwind.config.cjs`、`lib/motion.ts` | 新功能放进独立模块，编辑器和 App 只留最小接入点；该分支合入 release 后再 rebase，届时复用其动效 token，不提前复制 |
| `origin/codex/ai-memory-hub-v160` | 2026-11-06（5 个提交） | `App.tsx` | 同上，App 只增加路由解析所需的最小改动 |

## 3. 现有能力盘点（源码证据）

### 3.1 后端插件平台

- **安装与信任**：`POST /api/plugins/install`（包上传）、`/registry/install`（V1 社区源）、`/ecosystem/install`（V2 签名源）都是 `requireAdmin`（`routes/plugins.ts:296,347,282`）。V2 信任链依次校验 HTTPS 与固定 Registry 公钥、索引签名、发布者密钥、包 SHA-256、发布者签名、Manifest 一致性、策略与安全公告（`ecosystemRegistry.ts`、`registryTrust.ts`、`extension-platform-v2.md`）。
- **生命周期**：安装后进入 `quarantined`；授权（`PUT /:id/permissions`）、`enable/disable/reload`、卸载（V3 有数据时必须显式 `deleteAppData` 或 `retainAppData`）、回滚、`/ecosystem/update`（新增权限必须 `confirmed`）全部 `requireAdmin`（`routes/plugins.ts:288,384-438`，`pluginService.ts:388,451,473,508`）。
- **执行**：`POST /:id/actions/:actionId/execute`。声明式插件不能执行；输入按 Manifest 严格校验（未声明的键直接拒绝）；交互 10 秒、后台 30 秒（`pluginService.ts:527-545`，`manifest.ts:438-454`）。
- **只读聚合**：`GET /api/plugins`（非管理员只返回已启用）、`/features`、`/actions`、`/contributions`（只含已启用的 V2；`uiExtensions` 关闭时剥离 `uiComponents`，`pluginService.ts:92-101`）、`/apps`、`/widgets`（最多 32 个，预览经 Broker `data.query`，`pluginService.ts:124-146`）、`/widget-events`（SSE，每秒比对指纹，最长 20 分钟，每个凭据最多 4 条）。
- **Manifest**（`manifest.ts`）：V2 有 `commands`（`:71`）和 `menus`，位置包含 `commandPalette`、`note.contextMenu`、`editor.toolbar.actions` 等（`:72-75`）；`promptPacks` 支持 `context: ["selection"]` 与 `outputMode: "replace-selection"`（`:138-152`）；`uiComponents` 只有 `floating-layer` 与 `navigation.open`（`:154-175`）；V2 基础字段含 `categories/keywords/icon/screenshots/uiPlatform`（`:177-191`）；V3 有 `appPages/widgets/inspectors/uiAssets`（`:278-345`）。可执行 V2 的 `contributes` 是 `.strict()`，旧宿主会拒绝不认识的键（`:193-208`）。
- **功能开关**：V2.1 的声明式、UI 扩展、Studio 默认关闭（`featureFlags.ts`）；V3 的 core/appPages/dashboardWidgets/pluginData 默认开启、inspectors 默认关闭（`applicationV3.ts:44-55`）。
- **Personal Studio**：AppSpec v1 只有 text/checkbox 字段和 list/board 布局，最多 8 字段、100 条记录、48 KiB（`personalStudioApps.ts:5-35`）；revision 乐观锁、版本历史（迁移 v134，保留 25 个快照）；AI 预览只返回经 Zod 校验的 AppSpec，不落库（`routes/plugins.ts:83-148`）。

### 3.2 前端

- **API 客户端** `lib/pluginApi.ts`：安装、授权、启停、卸载等变更都经 `contributionMutation` 广播 `PLUGIN_CONTRIBUTIONS_CHANGED_EVENT`（`:183-189`）；`execute` 不传 `workspaceId`（`:228`）。
- **路由**：`/apps`、`/apps/manage`、`/apps/dashboard`、`/apps/studio[/:id]`、`/apps/personal/:id`、`/apps/:pluginId/:pageId`（`lib/pluginApps.ts:3-14`），用 `pushAppPathState` 跳转，支持 popstate 和深链（`App.tsx:433-479`）。入口由 `usePluginApps` 控制：只在 web/desktop 且 V3 `appPages` 开启时显示，**Capacitor 原生端直接关闭**（`hooks/usePluginApps.ts:16`）。
- **插件管理** `settings/plugins/PluginSettingsTab.tsx`：四个页签（已安装/市场/更新与安全/开发者，`:129,215`）；市场只读 V2 签名源，单源下拉，按名称/ID/描述/关键词做子串搜索（`:153-170`）；错误多用 `window.alert`（`:71,179,194`）；“启用”按钮会**一次性授予全部声明权限再启用**，该时刻不展示权限确认（`:108`）；`/apps/manage` 依赖 V3 开关（`PluginApps.tsx:132`）。
- **工作台** `PluginDashboard.tsx` 与 `lib/pluginDashboard.ts`：使用/编辑两态、`<details>` 添加列表、仅编辑态可拖拽、前移/后移、尺寸、显隐、移除、恢复默认、5 套布局 × 12 张卡、设备本地存储、同时只运行一个交互 iframe。布局项 ID 必须是 `<pluginId>/<widgetId>`（`pluginDashboard.ts:24`）；插件缺失时卡片直接不渲染（`PluginDashboard.tsx:93`）；保存失败只显示通用失败文案。
- **声明式 UI**：`pluginUiRegistry.ts` + `FloatingLayerHost.tsx`，只支持 floating-layer。
- **命令面板** `common/CommandPalette.tsx:118-125`：已消费 `menus[location=commandPalette]`，但命令 ID 没有插件命名空间、固定传 `{ noteId }`（Action 未声明该参数时会被服务端拒绝）、丢弃执行结果、错误用 `window.alert`。
- **Prompt Pack**：`pluginPromptRegistry.ts` 只被 AI 对话和 AI 协作的“技能”使用；`replace-selection` 没有在编辑器中执行过。

### 3.3 编辑器

- **Tiptap**：命令类型 `SlashCommandItem.action(editor)`（`SlashCommands.tsx:22-30`）；`getDefaultSlashCommands` 生成默认命令并内联拼接日记命令（`:190-199`）；`TiptapEditor.tsx:6720-6722` 渲染斜杠菜单。选区气泡是手写实现（`:1476`、`:5798`），含格式、加密选区和 AI 改写入口（打开 `AIWritingAssistant`）。
- **Markdown（CodeMirror 6）**：`MdSlashItem`、`getDefaultMdSlashItems`、`createSlashPlugin`（`MarkdownSlashMenu.tsx:54,65,305`）；`MarkdownEditorImpl.tsx:1011-1024` 拼接默认命令与日记命令；独立的选区气泡（`:850,1446,2698`）。
- **双编辑器先例**：`daily-records/dailyRecordSlashCommands.tsx` 与 `markdownDailyRecordSlashCommands.tsx` 共享同一份命令定义，分别生成两种编辑器的命令。Markdown 的异步插入用前后文锚点重定位，属于尽力而为（找不到时回退原位置），不适合“替换选区”。
- **Tiptap 异步锚点** `lib/asyncEditorInsert.ts`：随事务 `mapping` 映射位置，可直接复用于异步结果回写。
- **现有 AI 写作助手** `AIWritingAssistant.tsx`：润色、翻译、摘要等经 `api.aiChat` 流式生成，并带 AI 来源标记。**但 Tiptap 的 `handleAIReplace` 用的是点击“替换”那一刻的当前选区**（`TiptapEditor.tsx:5086-5090`）：生成期间用户移动光标或改字，结果会写到错误范围。这是现有行为，插件动作管线不能沿用这种写法。
- **只读与加密信号**：`EditorPane.tsx:240-241` 的 `effectiveLocked`（数据库锁、会话锁、回收站、切换中）与 `canWriteNote`；`isEncryptedNoteFormat`（`:176`）。

### 3.4 SDK 与合同

- `scripts/generate-plugin-host-api.mjs` 由三份 JSON 合同生成 9 个文件（后端合同与能力目录、SDK 的 hostApi/contributions/errors/mock、能力目录 JSON、两份文档），`--check` 用于 CI 校验。
- Host API 没有 `ai.*` 方法，执行型插件无法复用用户的 AI 配置（见 D2）。
- 示例：`examples/plugins/task-digest`（sandbox-js 执行型）可作为第三方风格示例的模板；`productivity-pack` 是声明式 noteTemplates/promptPacks（`engines >=1.6.0`）。

## 4. 功能差异矩阵

图例：✅ 已实现 · 🟡 实现但体验不足 · 📄 仅合同（没有消费者或从未执行） · ❌ 缺失

### A. 插件中心（方案 §5，P0）

| # | 需求 | 状态 | 证据 | 复用与改造 |
| --- | --- | --- | --- | --- |
| A1 | 聚合官方与管理员可信源，保留来源标识 | 🟡 | `GET /ecosystem/sources`、`/ecosystem/catalog`；前端只能单源下拉 | 前端并行拉取已启用源，按 sourceId 合并；只有 `official: true`（内置信任根）显示“官方” |
| A2 | 分类（7 类 + 其他） | 🟡 | 官方签名索引实际带 `category`、`keywords`（TS 类型 `EcosystemExtension` 未声明，接口原样透传）；没有图标、截图、更新日志；版本的 `uiPlatform` 含 Manifest 枚举之外的 `mobile` | 分类映射表 + “其他”兜底；平台兼容以安装时校验的 Manifest 为准，索引平台只作展示 |
| A3 | 名称/描述/关键词搜索，加载/空/离线/重试 | 🟡 | `PluginSettingsTab.tsx:167-170`，只有加载态和错误态；后端 `marketplace_cache` 已缓存验签后的条目，但没有离线读取路径 | 抽出纯函数搜索和请求状态机，补重试；离线时是否展示缓存目录（只读、标注“离线缓存”，安装仍需在线验签）在 Phase 1 评估 |
| A4 | 安装/管理/更新/不支持当前平台/需要管理员 等状态 | ❌ | 市场卡片只有安装按钮；兼容性只在已安装卡片显示 | 合并 catalog × installed × updates × `compatibility` × `features` 生成卡片状态（纯函数 + 单测） |
| A5 | 可审计的官方精选，不伪造下载量与评分 | ❌ | — | 仓库内静态精选清单（只有插件 ID 和推荐理由），用测试保证不含指标字段 |
| A6 | 详情：权限、平台、截图、版本、作者、更新记录、来源 | ❌ | 已安装卡片可展开权限、版本、执行记录；没有详情抽屉；V2 图标和截图没有安全的资源路由 | P0 详情抽屉展示权限说明、平台、版本、来源、仓库与许可证；截图需要新增只读、校验哈希的资源接口，列为 P1（D5） |
| A7 | 安装状态机与服务端一致 | ✅ 后端 / 🟡 前端 | 隔离、授权、启用、Node 运行时确认、签名/公告/策略/兼容校验都在服务端；前端从 Registry 安装前不展示权限，启用时一键授予全部权限（`PluginSettingsTab.tsx:108`） | 新增权限确认面板：安装前展示目标版本的 `permissions` 与 `permissionConfig`，启用前再次确认；界面状态只来自服务端返回 |
| A8 | 普通用户分权与“请求安装” | 🟡 | 安装路由 `requireAdmin`，非管理员看不到安装按钮；没有审批接口 | P0 只展示“需由管理员安装”的说明，不假装已发送请求（D6） |
| A9 | 停用后移除动作与卡片，保留休眠占位 | 🟡 | 停用后 `/contributions`、`/widgets` 不再返回；工作台布局保留但不渲染 | Phase 2 渲染休眠占位；Phase 3 编辑器动作随贡献刷新 |
| A10 | 更新时比较权限、复审新增权限、可回滚 | ✅ 后端 / 🟡 前端 | `/ecosystem/update` 要求 `confirmed`；`permissionDiff`；回滚接口 | 详情抽屉展示权限差异，确认后调用既有接口 |
| A11 | 我的插件：状态、版本、来源、设置、权限、日志、卸载保留数据 | 🟡 | 功能齐全，但是管理员调试形态（JSON Action 测试器、`window.confirm`） | 重组为产品级“我的插件”，调试工具放进“高级” |
| A12 | 内置功能卡与插件扩展卡区分 | ❌ | — | 内置卡只有“打开”“添加到工作台”，不能卸载 |
| A13 | Registry 安装路由有自动化测试 | ❌ | 后端和 E2E 都没有 `/ecosystem/catalog`、`/ecosystem/install` 的服务或路由级测试；供应链测试只直接调用信任组件 | Phase 1 增加：测试内生成密钥的签名源，只替换网络传输层，签名、哈希、安装器、策略全部走真实代码 |

### B. 工作台（方案 §6，P0）

| # | 需求 | 状态 | 证据 | 复用与改造 |
| --- | --- | --- | --- | --- |
| B1 | 使用/编辑两种模式 | ✅ | `PluginDashboard.tsx:15,78` | 保留语义，升级视觉 |
| B2 | 5 套布局 × 12 张卡上限 | ✅ | `pluginDashboard.ts` 校验 | 不改上限 |
| B3 | 添加、重排、删除、隐藏、尺寸、恢复默认 | ✅（基础） | 原生按钮和 `<select>` | 换成产品级组件与菜单 |
| B4 | 重命名布局、撤销最近一次操作 | ❌ | — | 纯函数撤销栈（内存）；重命名走同一套校验 |
| B5 | 添加面板支持搜索、分类、可用性说明 | ❌ | `<details>` 平铺 | 新的组件面板 |
| B6 | 内置卡（快速记录、日程、任务、最近笔记、收藏、统计等）接真实数据 | ❌ | 只有 V3 插件卡片；布局 ID 只接受 `<pluginId>/<widgetId>` | 内置 ID 用 `nowen-builtin/<id>`：符合现有正则，而 V2/V3 插件 ID 必须含“.”，所以不会冲突，无需迁移；数据走现有笔记/任务/日记 API；番茄钟这类没有业务数据的卡片标注“仅本设备” |
| B7 | 插件缺失、停用、无权限时显示休眠占位，且不清除布局 | 🟡 | 不渲染但保留布局项 | 渲染占位与“前往安装/启用”，不泄露历史数据 |
| B8 | 拖拽反馈，键盘与移动端排序兜底 | 🟡 | 没有把手、投放占位和动画；有前移/后移按钮 | HTML5 拖拽 + 把手 + 投放指示；键盘和移动端复用同一个 move 函数；不引入新依赖 |
| B9 | 保存失败显式提示“未保存”，多标签页同步 | 🟡 / ❌ | 失败只设通用错误；没有监听 `storage` 事件 | 未保存提示 + `storage` 事件刷新 + 覆盖前提示 |
| B10 | 按账号、服务器、工作区、桌面/窄屏隔离 | ✅ | `dashboardStorageKey` 基于 `getOfflineQueueStorageKey()` | 沿用 |
| B11 | 只运行一个交互 iframe，隐藏时回收，不做逐卡轮询 | ✅ | 单个 `activeApp`；单条 SSE | 沿用 |
| B12 | 工作台不依赖插件也能启动 | ❌ | 页面依赖 V3 `dashboardWidgets` 开关，且只有插件卡片 | 内置卡片不依赖 V3；V3 区块按开关显示 |

### C. 编辑器扩展（方案 §7，P0 关键）

| # | 需求 | 状态 | 证据 | 复用与改造 |
| --- | --- | --- | --- | --- |
| C1 | `editor.slash` 合同 | ❌ | 合同和 Manifest 都没有 | 新增 `editorActions` Contribution（合同 v5），走 合同 → 生成器 → SDK → Zod → 聚合接口 → 前端注册器 |
| C2 | `editor.selection` 合同 | ❌ | 同上 | 同上 |
| C3 | `editor.toolbar.actions`（复用 menus） | 📄 | `manifest.ts:73` 有该位置，前端没有消费者 | 由同一个注册器挂到两种编辑器的“扩展”菜单 |
| C4 | `editor.contextMenu` 与全局命令面板（P1） | 📄 / 🟡 | `note.contextMenu` 没有消费者；命令面板已消费，但有命名空间与传参问题 | P1 修正命令面板接入：加命名空间、按 Action 输入声明传参、反馈结果 |
| C5 | 统一执行流程：上下文 → 可用性 → 选区快照 → 受控执行 → 预览 → 二次校验 → 事务应用 | ❌ | 现有 `/actions/:id/execute` 可作执行底座，但不校验笔记 ACL 与加密状态 | 新增编辑器动作执行端点：服务端校验插件已启用、动作已声明、笔记可读/可写、未加密锁定、输入未超限，再调用既有执行管理器；正文写入只发生在编辑器事务中，并走现有保存与同步链路 |
| C6 | 旧选区、切换笔记、并发编辑都不覆盖新内容 | ❌（新增）；现有 AI 助手有覆盖风险 | `asyncEditorInsert.ts` 能映射位置；`handleAIReplace` 用当前选区 | Tiptap 用映射 + 原文比对，CodeMirror 用 `ChangeSet.mapPos` + 原文比对；不一致时提示“文档已变化”，提供复制结果或重新运行 |
| C7 | 撤销/重做与保存链路 | ✅ 可复用 | Tiptap history、CodeMirror history、现有自动保存 | 一次动作 = 一个事务 = 一步撤销 |
| C8 | 中文输入法组合输入时不误触 | 🟡 | 斜杠插件已有组合输入处理，需逐项核对 | Phase 3 补两种编辑器的组合输入单测 |
| C9 | 加密锁定、只读、访客、回收站时禁止执行 | 🟡 | 编辑器已有 `effectiveLocked`、`canWriteNote`、`isGuest` | 前端隐藏或禁用并说明原因；服务端执行端点再次拒绝 |
| C10 | 两个证明插件（官方 AI 文本动作、第三方文本转换） | ❌ | — | 第三方：sandbox-js 纯函数动作（包围选区、大小写、列表转换、插入模板）；官方：见 D2 |
| C11 | 大文档与移动端性能 | 🟡 | 已有大文档安全模式 | 注册器只在贡献变化时重建；选区菜单节流；输入时不请求接口 |

### D. 零代码创建（方案 §8，P1）

| # | 需求 | 状态 | 证据 | 复用与改造 |
| --- | --- | --- | --- | --- |
| D1 | 统一入口（模板 / AI） | 🟡 | `/apps/studio` 与 `PersonalStudioAI` 已有，但入口分散在“我的应用” | 扩展中心“创建应用”页聚合两条路径 |
| D2 | 首批 6 个官方模板 | 🟡 | 现有 3 个（`personalApps.ts` 的 checklist/records/tracker） | 用现有 text/checkbox 字段补齐 6 个，不改 AppSpec |
| D3 | AI 生成 → 预览 → 确认保存 → 继续编辑，失败保留草稿 | ✅（基础） | AI 预览不落库，保存走 revision；错误码已映射 | 补“AI 未配置时改用模板”的引导、可取消、切换账号时销毁请求 |
| D4 | 添加到工作台 | ❌ | — | 内置快捷卡 `nowen-builtin/studio-<appId>`（符合现有布局正则，无需迁移） |
| D5 | 文案国际化 | 🟡 | Studio 文案是组件内的中英常量 | 新增文案走 i18n，不顺手迁移旧文案 |

### E. 平台、安全与测试（方案 §9–§12）

| # | 需求 | 状态 | 证据 | 复用与改造 |
| --- | --- | --- | --- | --- |
| E1 | 单一贡献注册与缓存 | ❌ | 市场、命令面板、Prompt、UI 扩展各自拉取 `/contributions` | 新增共享的扩展注册 Hook，订阅 `PLUGIN_CONTRIBUTIONS_CHANGED_EVENT` 与账号/工作区变化；新功能先用，旧调用方逐步迁移，不一次性重写 |
| E2 | 前端判断不等于授权 | ✅ | 所有变更路由都在服务端校验 | 新端点同样补拒绝用例 |
| E3 | 移动端 | 🟡 | 原生端隐藏应用入口；V3 iframe 不支持 Capacitor 与 ElectronLite（`file://`） | P0 验收 Web、同源桌面端与 390px 窄屏；原生端保持现状并标注“需真机验收” |
| E4 | 既有测试基线 | 🟡 | 见 §8 | 既有失败不计入新回归，但数量不得增加 |

## 5. 原型对照

| 原型元素 | 处理 | 理由 |
| --- | --- | --- |
| 左栏“插件中心 / 工作台 / 编辑器”的独立 SPA | 调整 | 复用 NavRail 的“应用”入口与 `/apps/*` 路由 |
| 用 `localStorage` 保存安装和启用状态 | 拒绝 | 以 `/api/plugins` 为唯一真相 |
| `contenteditable` 演示编辑器与 `execCommand` | 拒绝 | 走 Tiptap / CodeMirror 事务 |
| “人气推荐”“精选”徽章 | 调整 | 只用可审计的官方精选清单，不显示下载量和评分 |
| 插件卡片（图标、名称、摘要、作者、兼容性、状态、主操作） | 保留 | 映射到真实字段 |
| 详情弹窗 + 权限列表 + 启用开关 + 卸载确认 | 保留并加强 | 改为抽屉；权限来自真实声明；卸载区分保留数据与删除数据 |
| 工作台问候语与统计卡（累计笔记、待办、专注时长） | 调整 | 只展示有真实数据源的统计；“专注时长”没有数据源，不展示 |
| 内置组件：快速记录、日历、待办、最近笔记、书签、专注计时、图谱、趋势 | 调整 | 有真实 API 的做成内置卡；书签、趋势、图谱没有对应数据，不做或标注“预览”；专注计时做成本设备工具卡 |
| 编辑器选区工具栏、`/` 菜单、“扩展”菜单、右侧扩展栏 | 保留前三项 | 右侧扩展栏挤占编辑区，列为 P2 |
| ⌘K 全局命令面板 | 复用现有 CommandPalette | P1 |
| “AI 插件工坊 DEMO” | 调整 | 落到 Personal Studio AI（声明式），不生成可执行插件 |
| 深色模式切换 | 复用全站主题 | 不引入第二套皮肤 |

## 6. 架构决策记录（ADR）

### ADR-01 唯一真相来源

- 插件状态只来自 `pluginService` 与现有路由，不新增插件表、不在前端保存安装状态。
- 若现有聚合不够，只新增**只读**视图接口（例如合并 catalog、installed、updates 的 DTO），且必须由既有服务计算，不维护第二份状态。
- 前端新增一个共享的扩展注册 Hook（订阅 `PLUGIN_CONTRIBUTIONS_CHANGED_EVENT`、`nowen:token-changed`、`nowen:workspace-changed`）。扩展中心、工作台、编辑器动作先使用它；既有调用方（命令面板、Prompt、浮层）在各自阶段按需迁移。

### ADR-02 扩展中心路由

| 路由 | 现状 | 计划 |
| --- | --- | --- |
| `/apps` | 我的应用（Studio 库 + 已安装应用页） | 扩展中心外壳：四区导航 + “我的应用”概览；保留现有按钮与文案键，保证现有 E2E 不失效 |
| `/apps/discover` | 无 | 新增：发现插件；详情用查询参数深链（如 `?plugin=<id>&source=<sourceId>`） |
| `/apps/manage` | PluginSettingsTab | 我的插件（产品级）+ “高级”（更新与安全、开发者、Registry 源，沿用现有实现） |
| `/apps/dashboard` | V3 卡片工作台 | 工作台（内置卡片 + 插件卡片） |
| `/apps/studio[/:id]`、`/apps/personal/:id` | Studio | 创建应用（模板 / AI）+ 现有编辑与运行页 |
| `/apps/:pluginId/:pageId` | V3 应用页 | 不变 |

`discover` 不含“.”或“-”，而插件页路由要求插件 ID 含分隔符，所以不会与 `/apps/<pluginId>/<pageId>` 冲突。扩展中心的发现与管理不再依赖 V3 `appPages` 开关，V3 相关区块继续按开关显示；原生端入口保持现状（见 E3）。

### ADR-03 内置功能卡与插件扩展卡

内置能力（工作台卡片、编辑器内置命令）以“功能卡（内置）”出现在同一发现界面，操作只有“打开”“添加到工作台”，不能卸载，也不伪装成第三方插件。

### ADR-04 工作台布局

- 保持现有 v1 布局结构与 localStorage 键，不做迁移。
- 内置组件 ID 使用保留命名空间 `nowen-builtin/<id>`：符合现有校验正则，且 V2/V3 插件 ID 必含“.”，不可能冲突。前端另加纯函数校验，拒绝未知的内置 ID。
- 插件卡片在插件缺失、停用或无权限时渲染休眠占位，不读取、不展示任何历史数据。
- 撤销栈只在内存中；保存失败显示“未保存”，不显示成功。
- 跨设备布局同步属于 P2，不在本项目实施。

### ADR-05 编辑器动作合同（提案，Phase 3 以生成器产物为准）

```jsonc
// contribution-contract v5 新增类型 editorActions（只允许可执行 V2：sandbox-js / node-action）
"editorActions": [{
  "id": "wrap-quote",                    // 插件内唯一，运行时 ID = <pluginId>/<id>
  "command": "acme.text.wrap-quote",     // 必须引用同插件 contributes.commands[].id，再由 command 指向 actions[]
  "label": "用引号包围",
  "description": "把选中的文字放进引号",
  "icon": "quote",                       // Host 白名单图标键
  "keywords": ["quote", "引号"],
  "placements": ["editor.slash", "editor.selection", "editor.toolbar.actions"],
  "appliesTo": ["tiptap", "markdown"],
  "selectionMode": "text",               // none | text | optional-text
  "resultMode": "replace-selection",     // none | insert | replace-selection | open-preview
  "requiresConfirmation": true
}]
```

- `placements` 只是 UI 位置，不授予读取正文的权限；Host 只把选中文本作为 `{ text }` 传入，被引用的 Action 必须在 `input` 中声明 `text: string`（安装时校验）。
- 插件拿不到编辑器实例、ProseMirror `EditorView` 或 CodeMirror View；结果只能是受限大小的纯文本（Host 不按 HTML 渲染）。
- 不允许任意脚本回调、`href`、内联 HTML/CSS 或绕过桥接。
- 旧宿主对 `contributes` 是严格校验，带 `editorActions` 的包会在旧宿主安装时被拒绝，天然 fail-closed。

### ADR-06 编辑器动作的执行与回写

1. 点击时生成快照：`noteId`、编辑器类型、选区范围与原文、文档版本。Tiptap 快照登记进 `asyncEditorInsert` 的锚点集合随事务映射；CodeMirror 用更新监听合成 `ChangeSet` 并 `mapPos`。
2. 执行走新的编辑器动作端点（ADR-05），服务端完成插件、动作、笔记 ACL、加密/锁定、输入上限检查后调用既有执行管理器；不把正文写进日志。
3. 结果返回后重新确认：同一笔记、编辑器仍挂载、映射后的范围文本与快照原文一致（替换模式）或插入位置有效（插入模式）。任一不满足就提示“文档已变化”，提供复制结果或重新运行，**绝不整篇覆盖**。
4. 通过一次编辑器事务写入，进入原有撤销栈，并由原有保存、Yjs/Sync V2 链路落盘；不新增正文写入 API。Phase 3 仍按 `AGENTS.md §5` 运行 DCC 相关前端套件与映射校验。

### ADR-07 功能开关

- 扩展中心与工作台升级只复用既有 API，不新增后端开关；现有 V3 开关继续控制 V3 区块。旧管理界面在 Phase 5 验收前保留为“高级”入口。
- 编辑器动作新增 fail-closed 开关（暂名 `NOWEN_EDITOR_ACTIONS`），开发期默认关闭：关闭时安装带 `editorActions` 的包会被拒绝（与 `PLUGIN_UI_FEATURE_DISABLED` 同一模式），`/contributions` 剥离该字段，执行端点拒绝。是否默认开启在 Phase 5 安全验收后由你决定（D3）。

### ADR-08 创建应用

复用 Personal Studio 与 AI 蓝图，不新增存储；模板是前端数据（AppSpec v1）；“添加到工作台”用内置快捷卡（ADR-04）；不执行任何 AI 生成的脚本。

### ADR-09 测试环境

- 后端：每个测试文件独立进程，用 Electron 内置 Node（`ELECTRON_RUN_AS_NODE=1`）。
- macOS：`plugin-studio-projects` 需要真实路径的 TMPDIR（`/var` 是 `/private/var` 的软链），而 TMPDIR 过长会让 `docker-updater-jobs` 的 Unix socket 路径超长。TMPDIR 需要既是真实路径又足够短；本次基线把两类用例分开运行。
- 时区：本机 PST 时，`attachment-file-share` 与前端 3 个已知用例依赖东八区，用 `TZ=Asia/Shanghai` 运行。
- E2E：复用 `backend/tests/application-v3-browser-server.ts` 一次性后端与生产构建；`NOWEN_QA_NODE` 指向 Electron 可执行文件。
- Registry 安装 E2E 只替换网络传输层（测试内签名的夹具源），签名、哈希、安装器与策略全部走真实代码，并在报告中明示。

### ADR-10 本项目不做或延后

跨设备工作台同步、`editor.block` 嵌入块、AI 生成可执行插件、真实下载量与评分、Android/iOS 原生端插件 UI 均为 P2，单独规划；不修改主导航结构、编辑器核心与 Sync V2。

## 7. 合同、迁移与 PR 拆分

| 对象 | 现状 | 计划 |
| --- | --- | --- |
| contribution-contract | v4 | Phase 3 升到 v5（新增 `editorActions`，既有类型不变） |
| host-api-contract | v6 | 默认不变；若 D2 选 (b) 则升到 v7 |
| Manifest | V1 / V2 / V3 | 可执行 V2 增加可选的 `contributes.editorActions` |
| 工作台布局 | v1（localStorage） | 结构不变；内置 ID 使用保留命名空间 |
| Registry 索引 | protocol 2 | 客户端兼容读取可选展示字段（D5） |
| 数据库 | 当前 schema | Phase 1–4 预计不新增迁移；若 D6 要求真实安装申请，则需新迁移 |

| 阶段 | PR | 内容 | 验收 |
| --- | --- | --- | --- |
| P0 | 本 PR | 审计、ADR、基线文档 | 评审 |
| P1 | 1a | 扩展目录纯函数：状态合并、分类映射、搜索、精选清单校验 + 单测 | vitest |
| P1 | 1b | Registry 目录与安装路由集成测试（签名夹具源） | node:test |
| P1 | 1c | 扩展中心界面：发现、详情抽屉、权限确认面板、我的插件 + 路由 + i18n | vitest + E2E（管理员安装授权启用、普通用户被拒、错误态、深色、390px） |
| P2 | 2a | 布局纯函数：撤销、重命名、内置 ID 校验、休眠判定 + 单测 | vitest |
| P2 | 2b | 内置卡片（最近笔记、待办、日记日历、快速记录、收藏、统计）+ 工作台界面 | vitest + E2E |
| P3 | 3a | 合同 v5 + Manifest + 生成器 + SDK + 聚合接口 + 执行端点 + 后端测试 | node:test + `--check` |
| P3 | 3b | 前端注册器 + 两种编辑器 Adapter + 斜杠/选区/工具栏 + 预览与冲突处理 | vitest + E2E（双编辑器、撤销、旧版本失败） |
| P3 | 3c | 两个证明插件 + 开发者文档 | 打包 + E2E |
| P4 | 4a | 创建应用入口 + 6 个模板 + 添加到工作台 | vitest + E2E |
| P5 | 5a | 安全回归、跨平台、性能对比、用户与开发者文档、发布检查报告 | 全量回归 |

## 8. 测试基线（全部为本机实际运行结果）

环境：macOS（Darwin 27.3）、本机时区 PST、Node 24.22.1、Electron 43.8.4（内置 Node 24.22.1，ABI 148）。被测代码为未修改的 `088e78469`。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 插件专项后端（24 文件） | 每个文件独立运行：`ELECTRON_RUN_AS_NODE=1 node node_modules/electron/cli.js --import tsx --import ./tests/setup-db-isolation.ts --test tests/<file>`（在 `backend/` 下） | 88 项：85 通过、3 失败（下表 F1、F2） |
| 后端全量（419 文件） | `ELECTRON_RUN_AS_NODE=1 <Electron> scripts/run-tests-serial.mjs`，TMPDIR 设为真实路径 | 415 通过、4 失败（F1、F3、F4、F5），用时 310 秒 |
| 后端 TypeScript | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 通过 |
| SDK 生成物 | `node scripts/generate-plugin-host-api.mjs --check` | 通过（9 个文件，digest `7177e571…`） |
| SDK 构建与合同测试 | `tsc -p packages/nowen-plugin-sdk/tsconfig.json`；`node packages/nowen-plugin-sdk/tests/generated-contract.test.mjs` | 通过；1/1 |
| DCC 映射 | `node scripts/data-consistency-contract.mjs --verify` | 通过（12 条不变量、289 条测试引用、50 个后端文件、46 个前端文件） |
| 前端全量 vitest | `TZ=Asia/Shanghai npx vitest run` | 759 文件 / 4449 项全部通过（53.5 秒） |
| 前端 lint 基线 | `npm run lint:baseline` | 失败（既有）：1436 条历史错误 + 103 条“新增”。其中 96 条来自被忽略的构建产物（`frontend/ios/App/App/public/assets` 48 条、本地 `frontend/dist.bak` 48 条），7 条在受控文件：`e2e/three-end-sync.spec.ts:285`、`EditorPane.tsx:3`、`EditorPane.tsx:2390`、`TiptapEditor.tsx:3`、`UserManagement.tsx:963`、`NoteWorkspaceLayoutController.test.tsx:161`、`api.impl.ts:2`。后续阶段以“改动文件不新增 lint 错误”为门槛 |
| 前端生产构建 | `npm run build` | 通过（vite 15.5 秒，含 `tsc -b` 共 31 秒） |
| Bundle 预算 | `npm run verify:bundle` | 通过：首屏 4 个请求 / 1.61 MiB raw / 504.6 KiB gzip / 439.3 KiB br |
| Plugin Apps E2E | `NOWEN_QA_NODE=<Electron> npx playwright test --config playwright.plugin-apps.config.ts` | 2/2 通过（26.2 秒） |
| Markdown 斜杠 E2E | `npx playwright test --config playwright.markdown-slash.config.ts` | 4/9 通过；5 项失败（F6） |

失败归因：

| 编号 | 用例 | 原因 | 证据 | 归类 |
| --- | --- | --- | --- | --- |
| F1 | `application-v3-foundation`：V3 默认开启… | 断言插件宿主 `NOWEN_VERSION` 等于根 `package.json` 版本，实际 1.5.3 ≠ 1.5.5；同一用例还断言 `NOWEN_VERSION === "1.5.3"`，两者在当前分支不可能同时成立 | `tests/application-v3-foundation.test.ts:24-25`；`release-version-sync` 测试不覆盖 `plugins/types.ts` | **既有真实缺陷**（D1） |
| F2 | `plugin-studio-projects` 两个 TOCTOU 用例 | 测试用未解析软链的路径比对 `fs.openSync` 参数，macOS 的 `/var` → `/private/var` 使替换从未触发 | 改用真实路径 TMPDIR 后 9/9 通过 | 环境（macOS） |
| F3 | `attachment-file-share` 过期分享返回 410 | 依赖东八区 | `TZ=Asia/Shanghai` 下 6/6 通过 | 环境（时区） |
| F4 | `docker-updater-jobs` | 为避免 F2 设置的长 TMPDIR 使 Unix socket 路径超长（`listen EINVAL`） | 默认 TMPDIR 下 19/19 通过 | 环境（本次运行设置） |
| F5 | `migration-release-upgrade` 的 bundle 入口用例 | 用的是本机 11-02 构建的旧 `backend/dist/index.js`，报“数据库版本 142 高于当前程序支持的 140” | 同文件 tsc 入口用例通过；测试要求先 `npm run build` | 环境（过期本地构建，未重建以免覆盖你的产物） |
| F6 | Markdown 斜杠 E2E 的 5 个用例 | 登录后等待 `nowen:onboarding-welcome-opened:v1:*` 键，该键已在 `ca76128c5`（11-03，引导改为服务端门控）中删除；失败点在夹具阶段，斜杠菜单逻辑未执行到 | `e2e/markdown-slash-menu.spec.ts:243,367` | 既有测试夹具漂移（Phase 3 修复，仅改测试） |

基线 chunk 尺寸（供后续性能对比）：`App` 1,226.79 kB（gzip 335.73）、`index` 1,261.58 kB（gzip 430.74）、`TiptapEditorInitializationRuntime` 536.85 kB（gzip 164.82）、`PluginApps` 47.45 kB（gzip 16.05）、`PluginSettingsTab` 38.29 kB（gzip 11.62）、`CommandPalette` 40.96 kB（gzip 13.49）。

未运行：Electron 成品包、Docker/NAS、Android/iOS 真机、本分支的远程 CI（尚未推送）、上述之外的 Playwright 套件、编辑器输入延迟剖析。这些按阶段需要补跑，Phase 5 汇总。

## 9. 需要你决策的事项

| 编号 | 问题 | 选项与建议 | 影响阶段 |
| --- | --- | --- | --- |
| D1 | 插件宿主版本 `NOWEN_VERSION` 停在 1.5.3（根版本 1.5.5），导致 F1；1.6.0 的声明式/UI 合同要求 `engines >=1.6.0`，当前宿主会拒绝安装 | 建议在 1.6.0 发版准备时由你决定是否把插件宿主版本与发布版本对齐；本功能分支默认不改它（改它会改变所有插件的兼容判定）。Phase 3 的示例插件版本范围据此确定 | P3 |
| D2 | 官方“智能文本助手”（选区润色/翻译）如何调用 AI | (a) 推荐：声明式 Prompt Pack 由 Host 走现有 AI 写作链路执行，插件不运行代码，无需新 Host API；(b) 新增 Host API `ai.*` 与新权限，供执行型插件调用用户的 AI 配置（合同 v7，扩大攻击面）；(c) 插件自带 `external:fetch` + 密钥连接，不复用你的 AI 配置 | P3 |
| D3 | 编辑器动作开关在 1.6.0 是否默认开启 | 建议开发期默认关闭，Phase 5 安全验收通过后再由你决定 | P3/P5 |
| D4 | 声明式运行时 `NOWEN_EXTENSIONS_V21` 默认关闭；若 D2 选 (a)，需要它开启，或把官方动作包做成“可执行插件 + Prompt Pack” | 建议后者（不改变 V2.1 开关的默认值） | P3 |
| D5 | Registry 展示元数据（图标、截图、更新日志）和证明插件发布到官方源 | 官方索引在另一个仓库，签名私钥在你手中；客户端只做兼容读取。是否扩充索引字段、何时发布示例插件由你决定，发布前用包上传和测试签名源验收 | P1/P3 |
| D6 | 普通用户“请求安装” | P0 只给说明，不假装发送；若要真实审批流程，需要新表、通知和管理员处理界面，建议放到 P1 之后单独评审 | P1+ |
| D7 | 现有 AI 写作助手按“当前选区”替换的覆盖风险（§3.3） | 不属于本项目范围；建议作为独立修复，复用 ADR-06 的锚点校验 | 独立 |

## 10. 需要新增的测试（对应方案 §12.2）

| # | 闭环 | 阶段 | 形态 |
| --- | --- | --- | --- |
| 1 | 管理员：搜索 → 查看权限 → 安装 → 授权 → 启用 → 详情显示“已启用” | P1 | Playwright + 测试签名源（仅替换传输层） |
| 2 | 普通用户看到权限限制；直接调用安装、授权、启用接口均 403 | P1 | Playwright + node:test 路由拒绝 |
| 3 | 工作台：内置卡 + 第三方 Widget，拖动、调尺寸、刷新后保留；停用后休眠，重新启用恢复 | P2 | Playwright（现有示例包） |
| 4 | Tiptap：`/` 执行第三方插入 → 保存刷新 → 正文存在 → 撤销 | P3 | Playwright + Adapter 单测 |
| 5 | Markdown：同一命令 → 保存刷新 → 撤销/重做 | P3 | Playwright（先修 F6 夹具）+ 单测 |
| 6 | 选区异步转换 → 预览 → 替换；中途改字后旧结果被拒绝 | P3 | 确定性单测 + Playwright |
| 7 | 加密锁定、只读共享、未授权插件：服务端拒绝且正文不变 | P3 | node:test + Playwright |
| 8 | 账号 A/B、工作区切换不串数据 | P2/P3 | Playwright + 单测 |
| 9 | 更新、新增权限、回滚、保留卸载、重装、备份恢复后隔离 | P1/P5 | 既有 node:test 回归 + 新路由测试 |
| 10 | Web/Electron 可运行范围；移动端降级提示 | P5 | Playwright 390px；Electron 成品需人工 |

## 11. Phase 1 计划

1. 扩展目录纯函数（catalog × installed × updates × compatibility × features → 卡片状态、分类映射、搜索、精选清单）及单测 → 验证：vitest。
2. Registry 目录与安装的路由集成测试（测试内签名源、只替换传输层；覆盖管理员成功、普通用户 403、签名错误、哈希不一致、新增权限需确认） → 验证：node:test。
3. 扩展中心界面：`/apps/discover`、详情抽屉、权限确认面板、“我的插件”、四区导航；错误态区分网络/权限/签名/不兼容；键盘、焦点恢复、ARIA、深色、390px → 验证：vitest + Playwright。
4. 普通用户“需管理员安装”说明（不发送请求）；内置功能卡展示 → 验证：Playwright。
5. 回归：插件专项后端、前端全量 vitest、构建与 bundle 预算、Plugin Apps E2E、lint（改动文件零新增）。

Phase 1 不修改合同、数据库和编辑器；不会触碰 F1 的版本号。

## 12. 基线复现

```bash
cd backend
ELECTRON_RUN_AS_NODE=1 node ../node_modules/electron/cli.js --import tsx --import ./tests/setup-db-isolation.ts --test tests/ui-contribution.test.ts
```

```bash
cd frontend && TZ=Asia/Shanghai npx vitest run
```

```bash
for d in hello-nowen-app personal-dashboard resource-inspector; do (cd examples/plugins/$d && node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack); done
```

```bash
cd frontend && npm run build && NOWEN_QA_NODE="$PWD/../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" npx playwright test --config playwright.plugin-apps.config.ts --reporter=line
```
