# 工作台（1.6.0 Phase 2）

工作台（`/apps/dashboard`）在 1.5.3 V3 Dashboard 的基础上升级，新增：
- 官方内置卡片
- 组件面板
- 撤销
- 布局改名
- 休眠占位
- 多窗口同步

不新增后端存储或功能开关。布局结构与 localStorage 键沿用 v1（见 [Phase 0 文档](./extension-experience-v16-phase0.md) ADR-04）。第三方卡片的合同与运行限制见 [Dashboard 与插件数据](./extension-platform-v3-dashboard-data.md)。

## 使用与编辑

- **使用模式**（默认）：卡片可以直接操作，拖动页面不会重排卡片。
- **编辑布局**：
  - 添加卡片：组件面板按“内置 / 插件”分组，可按标题和说明搜索。已在布局中或已达上限的条目会注明原因，且不能添加。
  - 排序：桌面端可拖动卡片，投放位置会高亮。也可以聚焦卡片的拖动把手用方向键移动，或用“上移/下移”按钮。键盘移动后焦点仍在原卡片上。
  - 尺寸（小/中/大）、隐藏/显示、移除。隐藏的卡片在使用模式下不占位置。
  - 撤销：撤销最近的布局操作。内存中最多保留 20 步，刷新页面或切换账号/工作区后清空。
  - 布局：最多 5 套，可新建、改名、切换、删除。名称为 1–40 个字符，不能重名。“恢复默认”和删除布局需要确认。
- 每套布局最多 12 张卡片。默认布局先放已启用插件的卡片，再放内置卡片，合计不超过 12 张。

## 内置卡片

内置卡片使用保留命名空间 `nowen-builtin/<id>`。它们直接调用现有业务接口，不另存业务数据副本：

| 卡片 | ID | 数据来源 | 行为 |
| --- | --- | --- | --- |
| 快速记录 | `nowen-builtin/quick-note` | `POST /api/notes` | 选择当前空间的笔记本，保存为 Markdown 笔记；第一行（去掉开头的 `#`，最多 80 字）作为标题；保存失败时保留草稿；⌘/Ctrl+Enter 保存 |
| 今日任务 | `nowen-builtin/today-tasks` | `GET /api/tasks?filter=today`、`PATCH /api/tasks/:id/toggle` | 最多 6 条，不含已归档任务；勾选即完成 |
| 最近笔记 | `nowen-builtin/recent-notes` | `GET /api/notes?sortBy=recent&limit=5` | 按更新时间倒序，点击后在主界面打开 |
| 任务统计 | `nowen-builtin/task-stats` | `GET /api/tasks/stats/summary` | 待办、今天到期、已逾期、今天完成 |
| 日记日历 | `nowen-builtin/diary-calendar` | `GET /api/diary/timeline?from=&to=` | 按本地日期标记当月日记数，可切换月份 |
| 收藏 | `nowen-builtin/favorites` | `GET /api/notes?isFavorite=1&sortBy=recent&limit=5` | 当前用户最近收藏的 5 篇 |

所有请求都带当前工作区，并沿用服务器原有的成员与权限校验。每张卡片各自处理加载、空状态和失败重试；空状态提供跳转到对应视图的入口。

番茄钟、书签和独立日程没有后端数据源，本阶段不提供这些卡片，也不用假数据展示。

### 后端改动

`GET /api/notes` 新增两个可选参数，旧客户端不受影响：

- `sortBy=recent`：只按 `updatedAt` 倒序，更新时间相同时按 `id` 排序；置顶笔记不再固定在最前。
- `limit`：1–100 的正整数，超过 100 按 100 处理。缺失或非法时保持原行为，返回全部。

`LIMIT` 加在全部权限与范围条件之后，所以回收站、他人笔记和非成员工作区的笔记仍不会返回；非成员请求仍返回 403。离线时笔记列表来自本地缓存，该路径不支持排序参数；旧服务器会忽略这两个参数。因此卡片还会在客户端按更新时间排序，再截取 5 条。

## 第三方卡片与休眠占位

- 第三方卡片仍受 V3 `dashboardWidgets` 开关控制。`NOWEN_EXTENSION_V3_DASHBOARD_WIDGETS=0` 只关闭插件卡片，工作台和内置卡片照常可用。
- 插件停用、卸载、无权限或开关关闭时，布局引用的插件卡片显示“组件暂不可用”占位，并提供“前往我的插件”入口。原位置保留，占位不读取、不显示任何历史数据。插件重新启用后，该位置恢复为实时卡片。
- 插件卡片列表加载失败时，占位会提示稍后刷新，不会删除布局项。
- 布局中出现本版本不认识的内置 ID（例如来自更新的版本）时，显示“此卡片需要更新版本的 Nowen。”占位，并保留该项。

## 存储、隔离与多窗口

- **存储位置**：布局只保存在本设备的 localStorage，不写入 Sync V2，也不跨设备同步。存储键与结构沿用 v1，按服务器、账号、工作区以及桌面/窄屏（≤767px）分别隔离。
- **校验**：所有修改都经过纯函数校验（上限、重名、重复 ID）。读取时也校验已存储的布局：损坏、重复 ID、非法尺寸或超出 5/12 上限的数据会整体回退为默认布局。原存储值在下一次保存前不会被改写。
- **保存失败**：每次修改先在内存中提交（可撤销），再写入本地存储。写入失败时显示“未保存”提示和“重试保存”按钮，不显示成功。
- **多窗口**：其他窗口保存了同一布局时，当前窗口改用新布局，并提示“布局已在其他窗口更新”。本窗口的撤销记录同时清空，避免旧布局覆盖新布局。
- **切换范围**：切换账号、服务器或工作区时，重新读取该范围的布局与数据。新范围的默认布局只使用在该范围内加载到的插件卡片。

## 平台

- **Web 与桌面端**：功能完整。窄屏下单列显示并使用独立布局，主要按钮和拖动把手的触控尺寸不小于 44px。
- **Capacitor 原生端**：沿用 Phase 1，不显示扩展中心入口，因此无法进入工作台。

## 已知限制

- 布局不跨设备同步（P2）。
- 撤销只覆盖布局操作，且只在当前页面有效。
- 快速记录固定保存为 Markdown 笔记。

## 测试

```bash
cd backend
ELECTRON_RUN_AS_NODE=1 node ../node_modules/electron/cli.js --import tsx --import ./tests/setup-db-isolation.ts --test tests/note-list-recent-limit.test.ts
```

```bash
cd frontend && npx vitest run src/lib/__tests__/pluginDashboard.test.ts src/components/dashboard
```

```bash
cd frontend && npm run build && NOWEN_QA_NODE="$PWD/../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" npx playwright test --config playwright.plugin-apps.config.ts --reporter=line
```

`frontend/e2e/workbench.spec.ts` 全程走生产路由，依次验证：
- 安装并启用用 CLI 打包的 Hello 示例。
- 快速记录写入笔记，新笔记出现在“最近笔记”。
- 勾选今日任务。
- 编辑布局（调整尺寸、隐藏、移除后撤销、键盘排序、改名），刷新后保持。
- 停用插件后出现休眠占位，重新启用后恢复。
- 深色主题与 390px 窄屏。
- 普通成员账号看到的是自己的默认布局与数据。

运行前需先用现有 CLI 打包 `examples/plugins/hello-nowen-app`。
