# Extension Platform V3：实验性应用运行闭环

2026-10-18，基于 `release/v1.5.3` 的 `ec223b46`。本增量覆盖 Phase 1B 和 Phase 1C 的受限 Web 应用闭环；默认关闭，不是 V3 正式发布或跨平台安全验收。

## 可运行范围

复用现有 Manifest、ZIP 安装器、Registry、权限、策略和 HostApiBroker，新增应用目录、独立页面、固定侧栏和 MessageChannel 适配。没有第二套插件安装或业务数据系统。

应用必须是已启用、生命周期稳定、权限全部授予且策略和真实宿主版本兼容的 V3 插件。仅支持 Web 和同源部署的 DesktopFull；Capacitor 原生客户端不展示入口。ElectronLite 的 `file://` 页面与服务器跨源，不在本次支持范围。

当前 `NOWEN_VERSION` 仍是 `1.5.0`，V3 要求至少 `1.6.0`。**打开功能开关仍不能在真实 1.5.x 宿主安装或运行 V3**。代码没有修改版本号或加入生产绕过。未来兼容宿主还必须启用以下全部开关，缺一即关闭：

```text
NOWEN_EXTENSIONS_V21
NOWEN_UI_EXTENSIONS
NOWEN_UI_LAYOUT_EDITOR
NOWEN_SANDBOXED_PLUGIN_UI
NOWEN_EXTENSION_V3_CORE
NOWEN_EXTENSION_V3_APP_PAGES
```

设置中的现有插件管理页也受应用开关控制；管理员沿用现有安装、权限确认和启停流程。V3 UI 明确标为“隔离应用界面代码”，不能按旧声明式零代码扩展展示或跳过授权。

## 资源和隔离边界

每次启动重新检查安装目录内所有 `uiAssets` 的真实路径、文件类型及 SHA-256。资源总量最多 4 MiB、HTML 512 KiB、累计内联引用 4 MiB。脚本、样式、图片仅能引用清单内相对路径；远程、绝对、编码及带查询串引用拒绝。当前支持预构建的独立 JS/IIFE、CSS 和位图；CSS/字体须自行内联，不解析任意模块或资源依赖图。

后端将包内资源转为 data URL，移除 HTML 导航、嵌套框架等标签/属性，注入 SDK 引导。`POST /api/plugins/apps/:pluginId/:pageId/session` 返回随机实例、nonce 和 30 秒有效的一次性文档票据；票据仅能读取代码。文档 `GET /api/plugin-ui-v3/:ticket` 要求 iframe 请求，消费一次后失效。没有通用插件静态目录或携带宿主 Token 的资源 URL。

文档响应同时设置 `CSP sandbox allow-scripts`、`frame-ancestors 'self'`、`X-Frame-Options: SAMEORIGIN`、`no-store` 和 `no-referrer`。iframe 只有 `sandbox="allow-scripts"`，没有 `allow-same-origin`；CSP 禁止 fetch、子 frame、worker、对象和表单。宿主只在应用开关打开时给 `frame-src` 增加 self，不放宽宿主 script-src。插件不能读取宿主 DOM、localStorage、Token 或 Electron preload；Electron 主窗口显式关闭子 frame Node 集成。

**边界：iframe 自身导航并不能由这些 CSP 完整禁止。** 页面出现第二次 load 时销毁 Bridge，但导航的首次请求可能已经发出；不能声称实现了任意恶意 UI 的全面网络隔离。iframe 也不提供 CPU/内存硬配额，不能承诺无限循环或崩溃的进程隔离。对不可信市场插件开放前，这两项仍是安全验收缺口。

## Bridge 与授权

宿主只向指定 `iframe.contentWindow` 转交 MessagePort；opaque origin 要求传递时使用 `*`，身份由独占端口、随机 nonce、插件 ID、实例 ID 和协议共同绑定。不能把 `origin === 'null'` 当作授权。请求/响应都核对插件、实例和 requestId。

所有 RPC 都由宿主持有的 Bearer 凭据调用服务器。实例绑定用户、凭据摘要、插件版本/包校验值、权限快照及 workspace。API Token 不允许创建此 UI 会话。客户端提供的 storage scope 被拒绝；服务器强制个人用户 scope 或当前工作区 scope，并复用 Broker 的权限与工作区读写 ACL。

支持的方法：

| 方法 | 行为 |
| --- | --- |
| `context.get` | 返回协议、方法列表、初始主题、平台及工作区，不返回凭据 |
| `storage.get/set/delete` | 插件专属 KV；读写声明权限分别检查，工作区 viewer 不能写 |
| `navigation.open` | 仅接受 all/favorites/files/diary/tasks/mindmaps/ai-chat/shares 视图键 |

拒绝 action、通知、笔记/任务/附件业务访问、密钥和任意网络调用；不透传完整 Broker。主题、可见性和销毁作为 `theme.changed`、`visibility.changed`、`destroy` 事件发送。SDK 导出 `getPluginAppClient()`，框架内提供 `window.NowenApp`。

限制沿用 V3 Guard：消息/响应 64 KiB、16 个并发、每分钟 120 次、会话内最多 4096 个已接受请求 ID，完整会话去重。会话 20 分钟，最多全局 128、每用户 8，待消费文档合计 16 MiB。SDK 调用超时 10 秒；写入响应丢失可能已经保存，用户应重新读取核对，不自动重试。

`POST /api/plugins/app-sessions/:id/{call,events,close}` 均走认证；events 为 POST SSE，nonce 放请求体而非 URL。先订阅撤销再返回 ready；禁用、权限修改、重载和卸载通知活跃实例关闭。断流、切账号/工作区、页面退出、超时和意外导航也回收实例。服务端每次 RPC 和 SSE 每秒检查权限/成员资格/策略。元数据列表通过本地生命周期事件及窗口 focus 刷新，不承诺所有客户端列表立即同步。

## 数据生命周期

KV 复用 `plugin_storage`，不修改核心笔记、任务、Outbox 或 Sync V2。服务重启后数据保留；禁用/重新启用也保留。侧栏 pin 仅保存于当前设备，按服务器与账号隔离，不是跨设备同步功能。

卸载包含 KV 数据的 V3 应用，服务器要求显式 `deleteAppData: true`；管理界面告知管理员这将删除所有用户和工作区的该插件数据。取消卸载并禁用可保留数据。没有提供卸载保留、数据导出、集合查询、迁移或 Dashboard；这些留给后续 Plugin Data 阶段。

## 验证与证据边界

测试均使用临时数据库/安装目录，不触碰用户数据。`futureCompatibleFixture` 仅在 `NODE_ENV=test` 可安装：它模拟安装校验的 1.6.0 版本，并仅在测试实例中调整策略输入的版本范围，其余安装/权限/ACL 保留。浏览器服务在安装 fixture 后使用生产路由和静态构建。此 fixture **不等于正式宿主已经具备 1.6.0 兼容性**；后端另有真实 1.5.0 安装拒绝断言。

本地已执行：

- 插件后端专项及 V1/V2、声明式生命周期、权限路由、供应链、沙箱和恢复回归：12 文件、52 项通过。
- 前端导航、服务器路径、运行模式和 MessageChannel：4 文件、102 项通过。
- Chrome 真实安装授权与应用运行浏览器验收：1 项通过（9.8 秒），包括后端进程重启后的持久化读取。
- 后端 TypeScript、前端生产构建、SDK 构建/既有合同及真实 CLI 打包通过。
- DCC 映射检查通过；Node 22 下前端 DCC：28 文件、238 项通过。
- 后端 DCC 未全通过：运行在 `sync-v2-mobile-multidevice.test.ts` 停止；该文件 76 项中 61 项失败，首个错误为任务不存在/无权限。在未修改的 `ec223b46` 独立工作树、相同 Electron Node ABI 130 环境复现同样的 15 通过/61 失败。其余未执行文件不能记为通过。

浏览器测试 `frontend/e2e/plugin-apps.spec.ts` 使用 CLI 产物、真实登录/插件管理 UI 安装授权、应用入口、保存读取、DOM/Token 拒绝、CSP、主题事件、服务器重启、禁用恢复及意外导航回收。运行方式：

```sh
cd examples/plugins/hello-nowen-app
node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack
cd ../../../frontend
npm run build
npx playwright install chromium
npx playwright test --config playwright.plugin-apps.config.ts --reporter=line
```

Windows 的本地 better-sqlite3 如绑定 Electron ABI，可通过 `NOWEN_QA_NODE` 指定 Electron 可执行文件；测试以 `ELECTRON_RUN_AS_NODE=1` 启动，使用独立临时配置。`NOWEN_QA_BROWSER_CHANNEL=chrome` 可使用本机 Chrome。CI 使用 Node 22 安装匹配的依赖及 Chromium。

新增 CI 配置不代表远程 Actions 已运行。Electron 成品、Docker/NAS、Android/iOS/HarmonyOS 及真实用户环境均未验收；当前不能宣称完整 V3 MVP 或跨平台安全验收完成。下一阶段应先补齐安全边界与实际兼容版本的平台验收，再开始 Dashboard Widget / 结构化插件数据。
