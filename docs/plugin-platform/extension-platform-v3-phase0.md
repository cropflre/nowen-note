# Nowen Extension Platform V3 — Phase 0 审计与 Phase 1 安全基础

> 状态：开发分支实验性增量。不是可安装的 V3 应用插件 MVP，也不是正式版本声明。基线：release/v1.5.2 @ 64426573d2548eec78d8c9ef441456a507baace3。

> 以下审计表与阶段状态保留原交付时点。按维护者后续要求，V3 应用现已改为 1.5.3 默认开放，宿主版本和示例同步到 1.5.3，并移除未来宿主模拟。最新实现、验收证据及未解决安全边界见 [应用运行闭环](./extension-platform-v3-app-runtime.md)。

## 当前代码审计（真实源码）

| 能力 | 已实现 | 仍缺少 | V3 复用方向 | 优先级 |
|---|---|---|---|---|
| Manifest | V1/V2 严格 Zod 校验、版本与权限校验 | V3 API 合同、appPages/widgets、安装兼容 | backend/src/plugins/manifest.ts 与 types.ts | P0 |
| 安装与更新 | 签名、Registry、隔离 ZIP、版本记录、回滚逻辑 | UI 资源白名单、哈希清单、卸载数据保留选项 | packageValidator / packageInstaller / update coordinator | P0 |
| UI | UI-R0/R1 声明式 floating-layer、用户本地布局 | App Page、iframe、Widget、独立入口和 Bridge | pluginUiRegistry / uiExtensionLayout | P0 |
| Host API | Broker、权限核验、notes/tasks/diary/storage 等 | UI 上下文授权适配与拒绝默认调用 | HostApiBroker 和 Host API 合同生成流程 | P0 |
| 存储 | plugin_storage 和 plugin_settings 已存在 | CRUD 集合/迁移/配额/卸载数据选择、SQLite/PostgreSQL 复核 | storage 命名空间，不另建安装器 | P0/P1 |
| Automation | V1.2 Cron、事件、Webhook、执行审计 | 应用级后台服务配额、AI 审批链 | 现有 WorkflowService | P1 |
| SDK/CLI | nowen-plugin-sdk、nowen-plugin-cli、create-nowen-plugin | V3 app 开发模板、资源打包、Host Bridge API | 扩展现有工具链 | P1 |

## 实际发现与设计决策

1. backend/src/plugins/types.ts 的 NOWEN_VERSION 为 1.5.0，EXTENSION_V21_TARGET_NOWEN_VERSION 为 1.6.0。既有 V2.1 UI 解析明确拒绝 engines.nowen 覆盖 1.5.0 的假兼容范围。V3 不修改此值；必须在真实发布版本具备兼容性后才能向最终用户开放。
2. UI Contribution 仅允许 floating-layer/action/navigation.open 白名单；NOWEN_SANDBOXED_PLUGIN_UI 虽存在，尚不意味着 iframe 自定义 UI 已交付（docs/plugin-platform/ui-contributions.md）。
3. V3 App Registry 必须只消费通过包验证、签名与生命周期状态核验的 Manifest；本次新增 applicationV3.ts 仅提供**声明校验与纯注册解析**，尚未连接安装入口。不得从直接解析数据得出‘插件安全可信’。
4. 应用入口是包内相对 HTML 路径，禁止 URL、查询串、上层目录和隐式重定向；后续 packageValidator 必须验证 ZIP 中确实存在该资源、哈希一致，并禁止 HTML 内未声明的远程资源。
5. 页面导航键采用 /apps/{pluginId}/{pageId}；仅在启用、平台兼容和用户授权后显示。页面本身不能覆写核心路由；所有用户 pin/order 状态与插件声明分离。
6. 复杂 UI 使用无 allow-same-origin 的沙箱 iframe，在独立不可信 origin 下执行。不能把未受信任代码直接挂到宿主 React 树。
7. Host Bridge 本阶段仅交付协议字段、大小限制、请求去重、并发限制、速率限制与撤销 guard；**尚未绑定 iframe.source / MessageChannel / 权限 Broker**。未来必须先建立专用 MessagePort，绑定 frame.contentWindow、实例、随机 nonce；不能仅用 event.origin==='null'。
8. 所有 Bridge 方法必须经过现有 Broker 的 插件权限 ∩ 用户权限 ∩ workspace/资源 ACL，并校验 token 生命周期。任意联网一律复用 secureExternalFetch；Electron 原生桥不可转交。

## Phase 1 集成依赖与尚未完成事项

- [x] 独立分支，不修改 release 与 main
- [x] 现有插件/UI/权限/版本约束初步审计
- [x] V3 纯 App Registry 与包内入口安全校验
- [x] V3 功能开关嵌套于旧版隔离开关，默认关闭
- [x] Bridge 消息格式校验与会话 Guard
- [x] 在 V3 Manifest Zod、安装器、Registry、权限初始化上落地版本化合同；完整兼容矩阵仍待端到端验收
- [x] 安装包 UI 静态文件 SHA-256 完整性验证
- [ ] 安全资源服务（无同源权限）及真实签名安装端到端验收
- [ ] iframe CSP、MessageChannel、source 绑定、Bridge 与 HostApiBroker 联调
- [ ] 完整 App 路由与可固定侧栏入口；禁用/切用户/卸载即时回收
- [ ] Hello Nowen App 的真实打包、安装、点击、数据存储和 E2E 验证
- [ ] 安全攻击矩阵及 Web/Electron/Docker/NAS 验收

## 兼容性与安全

V3 复用现有解析、安装、权限声明、更新与安全策略链路；V1/V2 保留原有合同。当前仍是 fail-closed 过渡阶段，不使 V3 在 1.5.x 运行时可安装。正式验收必须先证明安装→授权→渲染→持久化→禁用/卸载及恶意插件隔离端到端成立。

## 测试

新增 backend/tests/application-v3-foundation.test.ts 覆盖开关、入口路径、页面 ID 与声明权限、隔离路由、消息伪造、超限与撤销。执行：cd backend && node --import tsx --import ./tests/setup-db-isolation.ts --test tests/application-v3-foundation.test.ts。还需跑 backend/npm test、frontend 测试和跨平台端到端；不能在未执行时标为通过。

## 下一阶段开发顺序

Phase 1A：Manifest V3 合同、包签名完整性、配置隔离；1B：iframe 与 Bridge Broker；1C：UI App Registry 接入 App/侧栏及 Hello Nowen App。之后才开始 Dashboard/Plugin Data。Phase 3 Inspector/Previewer/Background/AI 和 Phase 4 SDK/市场应在 P0 可用后推进。

## Phase 1A 更新（Manifest / 安装包安全）

- 新增 API V3 声明式应用 Manifest Schema：appPages 与 uiAssets SHA-256 清单。
- 沿用 ZIP 包验证，仅允许已声明的 ui/ 静态资源，HTML/JS/CSS 验证 SHA-256；旧 V2 声明式 JavaScript 禁令不变。
- V3 默认关闭，仍要求真实 Nowen 1.6.0 以上兼容版本，当前 1.5.0 运行时不能启用 V3。
- 应用注册读取 GET /plugins/apps?platform=web|desktop|android|ios，仅返回已启用、符合策略且授权的页面声明。不会执行 UI 代码。
- **未完成**：安全 iframe 静态文件服务、CSP、MessageChannel、Host Broker 授权及 UI E2E。

## 2026-10-18 审查修复与 1.5.3 集成

- V3 的图标、截图必须位于 `ui/`，扩展名限 PNG/JPG/JPEG/WebP/GIF，并登记在 `contributes.uiAssets`。除根目录 `manifest.json` 外，ZIP 文件不再因被声明为图标或截图而免除路径、登记与哈希校验；开发目录使用同一 Manifest 合同和哈希规则。V1/V2 元数据规则不变。
- V3 `engines.nowen` 仅接受完整稳定版本的比较符与空格 AND 组合，必须包含下界不低于 `1.6.0` 的约束；拒绝 `>=1.5.1`、`>=1.5.99`、比较符尾随内容和预发布版本范围。最终仍检查真实运行时是否匹配范围，允许未来插件声明更高的最低版本，不改宿主版本号。
- Bridge 在整个会话中拒绝重复的已接受请求 ID，包括请求完成、速率窗口过期后。最多记录 4096 个请求 ID；达到上限后，新请求撤销会话并返回 `PLUGIN_UI_SESSION_EXHAUSTED`，后续调用返回 `PLUGIN_UI_SESSION_REVOKED`。未来 UI Host 必须重新握手并生成新 nonce，不能通过淘汰旧 ID 重新接受旧请求。拒绝的请求不进入去重记录；本阶段仍不执行 Host API。
- 修复前新增的 4 类回归用例均失败，修复后 V3 12/12、V2.1/UI 8/8 通过，后端 TypeScript `--noEmit` 通过；DCC 映射校验通过。测试使用临时目录和隔离数据库，不修改用户数据。
- 另以 Electron Node ABI 130 和仓库串行测试运行器验证插件 V1/V2、声明式生命周期、权限路由、生态、供应链、沙箱攻击及更新恢复，共 8 个文件、31 项测试通过，0 失败、0 跳过。未运行全量后端或真实安装包/设备验收。
- V3 CI 同样预加载 `setup-db-isolation.ts`；开发目录验证测试会加载数据库模块，必须在导入前设置临时数据库目录，不能打开仓库数据库。安全护栏已实际阻止缺少隔离配置的 CI 启动，补齐预加载后重跑验证。
- 集成目标按维护者授权改为 `release/v1.5.3`。V3 默认关闭，iframe、Broker、完整应用页面与跨平台 E2E 仍未交付；本次集成不代表 V3 MVP 验收或正式发布。
