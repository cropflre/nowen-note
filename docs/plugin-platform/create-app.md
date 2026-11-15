# 创建应用（1.6.0 Phase 4）

扩展中心的“创建应用”把现有 Personal Studio 的两条路径放到同一个入口：
- **从模板开始**：选一个官方模板，进入可视化编辑器。
- **让 AI 帮我设计**：用一句话描述需求，现有 Studio AI 生成声明式草稿。

两条路径都只打开**未保存的草稿**，点“保存应用”之后才创建。应用仍是 AppSpec v1：只有文本和勾选字段，不运行任何自定义或生成的代码。

本阶段沿用 Personal Studio 的存储、修订号和版本历史，没有新增存储、数据库迁移或功能开关（见 [Phase 0 文档](./extension-experience-v16-phase0.md) ADR-08）。后端只新增一个只读接口 `GET /api/plugins/personal-apps/ai-status`。

## 入口与页面

| 路由 | 页面 |
| --- | --- |
| `/apps/studio` | 扩展中心“创建应用”：AI 描述、模板库；选定后在同一页编辑草稿 |
| `/apps/studio/:id` | 编辑已有应用（可视化编辑、AI 修改、版本历史），保持原有整页布局 |
| `/apps/personal/:id` | 运行应用：添加/编辑记录、“添加到工作台”、编辑、删除 |

“我的应用”里的“创建自己的应用”、发现页的“缺少想要的功能？”以及导航里的“创建应用”都进入 `/apps/studio`。

## 模板库

模板是前端数据（`frontend/src/lib/personalApps.ts` 的 `STUDIO_TEMPLATES`），名称和字段名来自翻译（`extensionCenter.create.templates.<id>`），随界面语言生成。后端测试直接导入这份目录，确认每个模板在中英文下都能原样通过服务端的 AppSpec 校验并保存。

| 模板 | 展示 | 字段（中文） |
| --- | --- | --- |
| 项目进度 | 卡片 | 项目事项、项目、完成☑ |
| 阅读记录 | 列表 | 书名、作者、读到哪里、读书笔记、已读完☑ |
| 习惯追踪 | 列表 | 日期、习惯、已完成☑、备注（每次打卡记一条） |
| 会议纪要 | 列表 | 议题、日期、参会人、结论、会后待办、负责人、已跟进☑ |
| 旅行清单 | 列表 | 物品或事项、分类、备注、已准备☑ |
| 日常待办 | 列表 | 事项、完成☑ |
| 个人资料库 | 卡片 | 名称、备注 |

“项目进度”“日常待办”“个人资料库”是原有的 3 个模板，中文内容保持不变。英文界面下，这 3 个模板现在生成英文名称和字段（此前固定为中文）。

## AI 设计

- **先确认能否使用**：页面先请求 `ai-status`，再决定是否显示输入框。
  - 模型未配置，或用户在设置中关闭了 AI：显示提示和“打开设置”，引导改用模板，不显示无法完成的输入框或加载动画。
  - 状态检查本身失败：照常显示输入框，由预览请求报告真实原因。
- **先推荐模板**：描述里出现模板关键词（例如“阅读”“会议”“travel”）时，直接给出可用的模板。英文关键词只按词首匹配，“notebook”不会命中“book”。
- **边界说明**：输入框下方写明当前支持的字段类型与上限。日期、数字建议先用文本字段记录。
- **可取消**：生成中可以取消，描述保留；迟到的结果会被丢弃。切换账号或工作区时，待处理的请求作废，并重新检查 AI 状态。
  - 服务端对每个用户同一时间只处理一个 Studio AI 请求。已取消的模型调用结束前（最长 25 秒），再次生成会收到“请求过于频繁”，稍后重试即可。
- **预览后再采用**：草稿列出：
  - **将创建**：应用、展示方式、字段数。
  - **权限**：不需要任何插件权限，也不运行生成的代码。
  - **数据**：不读取笔记、任务或附件；记录只保存在当前服务器的你的账号下。

  采用后进入可视化编辑器，仍需手动保存。

以下沿用原有 Studio AI 的规则，本阶段未改动：
- 发给模型的只有需求、应用名、说明和字段结构，不含记录内容。
- 模型不能删除字段，也不能改变已有字段的类型（服务端强制）。
- 输出不合法时严格拒绝。
- 每分钟最多 6 次。

## 添加到工作台

- **卡片 ID**：个人应用卡片的 ID 是 `nowen-builtin/studio-<appId>`，符合现有布局校验，无需迁移布局。它是宿主渲染的快捷卡，不是 iframe。
- **入口**：
  - 应用页的“添加到工作台”：跳到工作台，由工作台按与“添加组件”相同的规则插入当前设备当前布局。已存在、布局已满（12 张）都会提示，插入可以撤销。这次交接绑定服务器、账号和工作区，切换后作废。
  - 工作台“添加组件”面板的“我的应用”分组：列出当前账号的个人应用。
- **卡片内容**：名称、说明、记录数（有勾选字段时显示完成数）、最新 3 条记录的首个文本字段，以及“打开应用”。
- **休眠占位**：应用被删除，或不属于当前账号时，卡片变为休眠占位，不显示任何内容；编辑布局时可以移除。
- **账号隔离**：切换账号后，在新账号的应用列表到达之前，卡片只显示加载状态，不复用上一个账号的列表。

## 数据范围

- 个人应用只属于创建它的账号，保存在当前服务器，暂不参与 Sync V2 离线同步。
- 个人应用不按工作区区分，同一账号在各工作区看到的是同一批应用。
- 工作台布局只保存在当前设备，并按服务器、账号、工作区和屏幕尺寸分别存放（ADR-04）。所以把卡片加到工作台，只改变这台设备上当前工作区的布局。

## 接口

`GET /api/plugins/personal-apps/ai-status`

| 响应 | 含义 |
| --- | --- |
| `{ "available": true }` | 可以使用 Studio AI |
| `{ "available": false, "code": "STUDIO_AI_NOT_CONFIGURED" }` | 未配置模型地址、模型名或密钥（ollama、lmstudio 不需要密钥） |
| `{ "available": false, "code": "STUDIO_AI_UNAVAILABLE" }` | 用户在设置中关闭了 AI |

- 判定与 `POST /personal-apps/ai-preview` 共用同一个函数。
- 响应不含任何配置内容，设置 `Cache-Control: no-store`。
- 与其他 Personal Studio 接口一样，只接受已登录用户，拒绝 API Token。
- 该路由注册在 `/personal-apps/:appId` 之前，不会被当作应用 ID。

## 平台

与扩展中心一致，只在 Web 和桌面端提供。Android、iOS 原生端不显示扩展中心入口。390px 窄屏下页面没有横向滚动（E2E 校验）。

## 已知限制

- 字段只有文本和勾选，每个应用最多 8 个字段、100 条记录，每个账号最多 32 个应用。日期、数字、选择、关联笔记等字段类型需要 versioned schema 与数据迁移，留待后续评估。
- 取消生成只在浏览器端生效，服务端仍会等已发出的模型调用结束。
- 工作台布局不跨设备同步（P2）。

## 测试

```bash
cd backend && ELECTRON_RUN_AS_NODE=1 node ../node_modules/electron/cli.js --import tsx --import ./tests/setup-db-isolation.ts --test tests/personal-studio-create.test.ts
```

```bash
cd frontend && npx vitest run src/lib/__tests__/personalApps.test.ts src/lib/__tests__/pluginDashboard.test.ts src/components/extension-center/__tests__/CreateAppLanding.test.tsx src/components/dashboard/__tests__/PluginDashboard.test.tsx
```

```bash
cd frontend && npm run build && NOWEN_QA_NODE="$PWD/../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" npx playwright test --config playwright.plugin-apps.config.ts --reporter=line
```

浏览器验收（`frontend/e2e/create-app.spec.ts`）：
- 一次性后端开启 `V3_BROWSER_AI_FIXTURE=1`，只把模型调用换成确定性桩；路由、校验、限流和“不能删除字段”规则都走真实代码。
- 覆盖：
  - 入口位于扩展中心、模板推荐、取消后保留描述；
  - AI 草稿保存后刷新仍在；
  - 添加到工作台（卡片不含 iframe，刷新后保留，可打开应用）；
  - 模板应用保存后刷新仍在；
  - 删除应用后卡片变为休眠占位；
  - 390px 无横向滚动。
- `plugin-apps.spec.ts` 在没有模型的后端上校验“AI 未配置”提示。
