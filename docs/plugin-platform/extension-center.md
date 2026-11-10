# 扩展中心（1.6.0 Phase 1）

扩展中心把现有的插件安装、权限与管理能力整理成面向普通用户的界面。它不新增插件状态：所有安装、授权、启用、更新与卸载都调用既有的 `/api/plugins/*` 接口，界面只显示服务器返回的状态。

## 入口与路由

左侧导航“应用”进入扩展中心，顶部五个分区都是应用内路由（支持前进/后退和刷新深链）：

| 分区 | 路由 | 内容 |
| --- | --- | --- |
| 我的应用 | `/apps` | 零代码应用与已安装的 V3 应用页（与 1.5.3 相同） |
| 发现插件 | `/apps/discover` | 签名 Registry 目录、内置功能卡、搜索与分类 |
| 我的插件 | `/apps/manage` | 已安装插件；管理员可上传 `.nowen-plugin`，“高级”保留原有管理工具 |
| 工作台 | `/apps/dashboard` | 内置卡片与插件卡片，见 [工作台](./workbench.md) |
| 创建应用 | `/apps/studio` | Personal Studio |

扩展中心与工作台在 Web 与桌面端可用，不再依赖 V3 `appPages` 或 `dashboardWidgets` 开关；V3 应用页、固定到侧栏和工作台中的插件卡片仍受各自开关控制。Capacitor 原生端保持原状，不显示入口。

## 发现插件

- 目录来自所有已启用的 V2 签名源。服务器先验证 HTTPS、固定公钥、索引签名、发布者与防降级，界面再展示。单个来源失败只在该来源上显示错误，不影响其他来源；来源请求超过 20 秒视为失败。
- 只有来自客户端内置信任根的来源才显示“官方”；自定义源即使在索引中自称 official，也显示“自定义源”。
- 分类优先读取索引的 `category`，再读已安装 Manifest 的 `categories`，无法识别时归入“其他”。
- “为你精选”是仓库内的静态清单（`frontend/src/lib/extensionCatalog.ts` 的 `FEATURED_EXTENSIONS`），只包含 ID 和推荐理由，测试保证不含下载量、评分等字段；清单中的插件不存在时不显示。
- 内置功能卡（个人工作台、零代码应用、任务、日记、思维导图、AI 助手）只能“打开”，不能安装或卸载，也不冒充第三方插件。
- 版本选择与服务器一致：取满足当前 Nowen 版本和服务器运行平台的最新版本。界面判断只用于提示，安装时服务器会重新校验。

## 安装、授权与启用

1. 管理员点击“安装”，确认框列出目标版本声明的全部权限（按密钥、联网、写入、读取分级）和外部服务地址；Node 运行时插件会额外提示风险。
2. 服务器下载并验签后，插件进入“待确认权限”（隔离）状态，不会运行。
3. 点击“审核权限并启用”，确认框再次列出权限；确认后授予声明的权限并启用。声明式扩展没有数据权限，只执行启用。
4. 更新时，界面先向服务器读取权限差异；新增权限或兼容边界变化需要明确确认。更新后的版本进入试运行，新增权限保持未授予，详情中可单独“审核新增权限”。
5. 卸载 V3 应用时可选择“卸载并保留数据”或“删除数据并卸载”，均需二次确认。

普通成员可以浏览目录、查看已启用插件和调整自己的插件设置，但看不到安装入口；需要安装时界面只提示联系管理员，不会假装已经发送请求。服务器对安装、授权、启停、更新、卸载全部要求管理员。

## 详情抽屉

点击插件名称或“详情/管理”打开，包含状态与可执行操作、权限（已授予/未授予）、兼容性、来源、仓库与许可证、插件设置（密钥只写入服务器加密存储，不回显）和最近运行记录。抽屉支持 Esc 关闭、焦点循环与焦点归还，窄屏下占满屏幕。

## 已知限制

- 官方 Registry 当前只有少量插件，且索引没有图标、截图和更新日志；截图展示需要新增安全的资源接口，列为后续工作。
- 没有真实的“申请安装”审批流程。
- 离线时不展示缓存目录（服务器已缓存验签后的条目，但没有离线读取接口）。
- 插件宿主版本号仍为 1.5.3，要求 `>=1.6.0` 的声明式扩展暂时无法安装，见 [Phase 0 文档](./extension-experience-v16-phase0.md) D1。

## 测试

```bash
cd backend
ELECTRON_RUN_AS_NODE=1 node ../node_modules/electron/cli.js --import tsx --import ./tests/setup-db-isolation.ts --test tests/extension-center-registry-routes.test.ts
```

```bash
cd frontend && npx vitest run src/lib/__tests__/extensionCatalog.test.ts src/components/extension-center
```

```bash
cd frontend && npm run build && NOWEN_QA_NODE="$PWD/../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" npx playwright test --config playwright.plugin-apps.config.ts --reporter=line
```

后端路由测试与浏览器验收使用 `backend/tests/helpers/signedRegistryFixture.ts`：在测试进程内生成 Ed25519 密钥并签名索引和插件包，只替换 `EcosystemRegistry.transport` 这一网络传输层；签名、哈希、发布者、安装器和策略校验都走生产代码。浏览器验收通过 `V3_BROWSER_REGISTRY_FIXTURE=1` 启用该夹具，并额外创建一个普通成员账号。在系统 Node 与 better-sqlite3 ABI 一致的环境（如 CI）可以直接用 `node` 代替 Electron。
