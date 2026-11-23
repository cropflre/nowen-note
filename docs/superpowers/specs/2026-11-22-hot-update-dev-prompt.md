# Nowen Note 四端热更新：AI 开发提示词

> 用法：把本文全文交给负责开发的 AI（Codex、Claude Code 等），在 nowen-note 仓库里执行。
> 本文写于 2026-11-22，依据当时 `origin/release/v1.6.1` 附近的代码。开工前先逐条核对第 2 节，和代码对不上时先停下汇报，不要自行猜测。
>
> 进度：阶段 1（发版流水线）已在分支 `feat/hot-update` 完成，实际格式与用法以 [docs/architecture/hot-update.md](../../architecture/hot-update.md) 为准。阶段 1 对本文做了四处调整，已改在下文：签名信封替代单独的 `.sig`；清单不放 `dbSchema`；打包配置不计入壳指纹；R2 路径为 `hot/<tag>/`。

## 0. 角色与目标

你是负责这次改造的高级工程师。目标：让安卓（Capacitor）和 Windows / macOS / Linux（Electron）用户在大多数版本更新时**不用重装安装包**，在应用内完成热更新。整个方案必须**免费**，**不依赖任何代码签名证书或第三方热更新云服务**。

完成标准（每一条都要有可复现的验证）：

1. 只改了热更新层的版本，已安装同一壳版本的客户端能自动下载、验签，并在下次启动时生效。
2. 被篡改、签名不对、壳版本不匹配、版本更低（降级或重放）的包一律拒绝，且不影响正常使用。
3. 新包启动失败（白屏、主进程崩溃、后端起不来）时，自动回退到上一个可用版本，用户数据无损。
4. 不产生费用；不需要苹果开发者账号、公证或 Windows Authenticode 证书；不向第三方发送设备或用户数据。

已定的选型（不要再换）：

- 安卓：`@capawesome/capacitor-live-update` 的自托管模式。不选 Capgo：它默认把更新检查和设备统计发到 capgo.app。
- 桌面：自己实现。electron-updater 只负责整包，不用它做热更新；也不用 Capawesome 的 Electron 支持，因为它依赖 `@capawesome/capacitor-electron` 平台，而本项目是原生 Electron。
- 签名：RSA（安卓插件只支持 RSA）。
- 托管：GitHub Release 和 `download.nowen.cn`（Cloudflare R2），都是项目现有的免费渠道。

## 1. 硬性约束

- **只用免费、自托管的方案**：不注册、不调用任何热更新云服务（Capawesome Cloud、Capgo Cloud、Appflow 等）。安卓插件只用自托管下载能力，禁止调用 `sync`、`fetchLatestBundle`、`fetchChannels`、`setChannel`、`getDeviceId`、`setCustomId`；不配置 `appId`、`serverDomain`；不用 `setConfig` 改公钥。
- **信任来自项目自己的密钥**：用项目自有的 RSA 密钥签名。私钥只放在 GitHub Actions Secret，绝不进仓库、日志、构建产物、Issue 或 PR；公钥入库，并编进安装包。不要替用户生成正式密钥，也不要写入 Secret，只提供脚本和说明。
- **更新地址和公钥写死在客户端**：renderer、服务器响应、用户输入都不能指定下载地址、清单地址或公钥（与 `electron/updater.js` 的现有原则一致）。只有开发或测试构建可以用环境变量指向本地测试服务器，正式构建必须在编译期关掉这个入口。
- **不改 WebView origin**：`frontend/capacitor.config.ts` 的 `androidScheme` 保持默认的 `https`（即 `https://localhost`）。改了 origin，用户 localStorage 里的登录 token、服务器地址等会全部丢失。
- **整包更新政策不变**：
  - Windows、macOS 继续用浏览器手动下载；
  - Linux AppImage 继续用 electron-updater 在应用内安装；
  - 微软商店版（`electron/storeChannel.js` 的 `isMicrosoftStorePackage`）完全不启用热更新；
  - iOS 本期不启用热更新，但 iOS 构建必须照常通过；
  - Web 和 Docker 不在范围内。
- **遵守 AGENTS.md**，尤其是第 5 节：
  - 涉及数据写入、离线、恢复的改动，按 `docs/architecture/data-consistency-contract.md` 执行；
  - 在 `docs/architecture/data-consistency-contract.matrix.json` 里按编号登记条目并关联失败用例（按编号检索，不要整读）；
  - 运行 `node scripts/data-consistency-contract.mjs --verify`；
  - 不以清空本地数据或 Outbox 作为修复手段，破坏性恢复前先备份；
  - 日志里不得出现正文、密钥、凭据。
- **简洁优先**：只做本文要求的内容。灰度发布、增量（manifest）下载、iOS 热更新、第三方代理镜像都不做。
- **工作方式**：
  - 从最新的 `origin/release/v1.6.1` 新建 git worktree 和分支 `feat/hot-update`；如果用户指定了别的目标发版分支，以用户为准；
  - 不要在主检出里改动，主检出有其他 agent 在用；
  - 按阶段提交，提交信息用中文；
  - 不推送、不合并、不打 tag、不发版、不改 Secret，每个阶段结束都汇报并等用户确认。

## 2. 现状（2026-11-22 已核实，开工前再核对一遍）

### 桌面端

- Electron 43.8.4，electron-updater 6.3.9。入口是 `electron/main-bootstrap.js`，它最后执行 `require('./main.js')`。
- `electron/main.js`：
  - `getFrontendDist()` 在打包态返回 `process.resourcesPath/frontend/dist`。主窗口用 `loadFile(<前端目录>/index.html, { query: { serverUrl } })` 加载。
  - `getBackendEntry()` 返回 `resources/backend/dist/index.js`。`launchBackend()` 用 Electron 自身（`ELECTRON_RUN_AS_NODE=1`）启动后端子进程，环境变量里有 `FRONTEND_DIST`、`DB_PATH`、`ELECTRON_USER_DATA` 等。
  - `preloadPath = path.join(__dirname, "preload.js")`。
- 后端由 esbuild 打成单文件 CommonJS（见 `backend/build.bundle.mjs`，约 7.7MB）。只有少数原生包是 external，运行时从 `resources/backend/node_modules` 解析。
- `electron/builder.base.config.js`：
  - `extraResources` 把 `backend/dist`、`backend/node_modules`、`backend/package.json`、`backend/templates`、`frontend/dist` 放在 asar 外；
  - `electron/**/*` 打进 app.asar；
  - Windows 安装包未签名（配置里写着没有可信发布者身份）；macOS 是否签名和公证，取决于 CI 有没有提供凭据。
- `electron/updater.js`：
  - Windows、macOS 只打开浏览器下载（见 `electron/updaterPolicy.js`，提交 cf0ddbc2d）；Linux 只有 AppImage 能在应用内安装；
  - `backupDatabaseBeforeUpdate()` 在安装前把 `nowen-note.db` 及 `-wal`、`-shm` 复制到 `<数据目录>/backups-pre-update/<时间戳>/`，保留最近 3 份；
  - 安装前广播 `preparing-install`，让 renderer 保存编辑器内容、把队列写入磁盘；
  - IPC 名称是 `updater:*`（见 `electron/preload.js`）。
- `electron/security.js`：主窗口的 file:// 只允许当前入口文件自身重载。
- 根 `package.json` 里的 jszip、archiver 是 devDependencies，不会打进 app.asar。主进程目前没有可用的解压库。
- `docs/CODE_SIGNING.md` 写明：GitHub 直装的 Windows EXE 未签名，并且"完整性元数据不能替代发布者签名身份"。
- `backend/src/db/schema-compatibility.ts` 里已有 `DatabaseUpgradeRequiredError`：数据库 schema 高于代码支持的版本时，后端拒绝启动。

### 安卓

- Capacitor 8.4.3。`frontend/capacitor.config.ts` 里 `webDir: "dist"`，生产环境不设 `server.url`，前端打包在 APK 的 `app/src/main/assets/public` 里。
- 自定义原生插件在 `frontend/android/app/src/main/java/com/nowen/note/`，由 `MainActivity` 的 `registerPlugin` 注册。
- 本地数据库 `frontend/src/lib/nativeDatabase.ts`：`SCHEMA_VERSION = 13`；`PRAGMA user_version` 高于支持版本时直接报错。

### 更新提示

- `frontend/src/components/common/UpdateNotifier.tsx`：
  - 服务器版本较新时的软提示只执行 `window.location.reload()`。安卓和桌面加载的是安装包里的前端，刷新不会变新；
  - 安卓硬提示拿前端编译版本 `__APP_VERSION__` 和服务器的 `minClientVersion` 比较。热更新以后，这个值不再代表 APK 版本。
- 桌面更新中心的界面在 `frontend/src/components/DesktopUpdateCenterCore.tsx`。

### 发版

- `.github/workflows/release-build.yml`：
  - desktop 调用 `release-center-candidate.yml`；
  - android job 依次执行 `npm run build`、`npx cap sync android`、`gradlew assembleRelease bundleRelease`，并校验签名证书的 SHA-256。
- `.github/workflows/release-publish.yml` 发布到 GitHub、Gitee、R2。R2 镜像由 `sync-r2-release.yml` 完成，地址格式是 `https://download.nowen.cn/<tag>/<文件名>`，目前没有指向最新版的固定地址。
- 资产清单和校验分布在 `scripts/release-ci-assets.mjs`、`scripts/verify-release-update-assets.mjs`、`scripts/lib/update-metadata-validator.cjs` 和 `tools/release-center`。改资产清单时要一起改，包括它们的测试。

### 历史数据（v1.4.11 到 1.6.1，共 14 个版本）

- `backend/src` 每个版本都改了。
- `electron/` 里的主进程 JS（不含构建配置和测试）改了 7 次。
- 安卓的 Java 代码或清单改了 5 次：v1.4.14、v1.5.0、v1.5.1、v1.5.3、v1.6.0。
- Electron 从 33 升到 43 发生在 v1.5.4。
- 结论：桌面热更新必须把后端和主进程 JS 一起换，否则几乎没有版本能热更新。

## 3. 设计（按此实现）

### 3.1 两层划分

| | 壳（只能整包更新） | 热更新层 |
|---|---|---|
| 安卓 | APK 原生代码、清单、权限、Capacitor 插件及其版本、`capacitor.config.ts` | `frontend/dist` |
| 桌面 | Electron 二进制、`main-bootstrap.js`、热更新加载器、`backend/node_modules`（原生依赖）、打包结构（extraResources、clipper native host、图标、文件关联等） | `frontend/dist`、`backend/dist`、`backend/templates`、`backend/package.json`、其余运行时会加载的 `electron/*.js`（主进程和 preload；不含构建配置、测试、bootstrap、加载器） |

### 3.2 壳版本：runtimeVersion

- 每个壳构建内置一个 runtimeVersion 字符串，每个热更新包也声明自己的 runtimeVersion，客户端只接受**完全相等**的包。壳一变，旧客户端就收不到新的热更新包，继续走现有的整包提示。
- 新增 `scripts/hot-update/runtime-fingerprint.mjs`：对壳的输入做规范化哈希，再拼上一个手动维护的整数 `runtimeEpoch`。指纹漏判时，人工把它加一。
  - 安卓的输入：`frontend/android/**`（排除 `app/src/main/assets/public/**`、构建产物，以及 `build.gradle` 里的 versionCode、versionName）、`frontend/capacitor.config.ts`、lockfile 里所有含原生代码的 Capacitor 插件的解析版本。
  - 桌面的输入：Electron 版本；根 `package.json` 生产依赖（打进 app.asar）的解析版本；`backend/build.bundle.mjs` 的 external 名单以及这些包的解析版本；`main-bootstrap.js`、`electron/hot-update/**`（加载器）；clipper native host 相关文件。
  - 两端都计入 `hot-update/public-keys.json`。
  - **不计入** electron-builder 配置（`electron/builder*.js`、`build/`）：它们大多是构建期校验，计入会让很多版本白白失去热更新。打包结构的改动如果让新代码依赖了新资源或过滤规则，必须手动把 `hot-update/config.json` 的 `runtimeEpoch` 加一。
  - 单测必须覆盖两类情况。只改 versionName、前端或后端源码时，指纹不变；改了 Java、插件版本、Electron 版本或原生依赖时，指纹改变。
- runtimeVersion 必须存在壳里，不能放进会被热更新替换的目录：
  - 安卓：构建时写入 BuildConfig 或原生资源，通过一个最小的原生方法读出来，加在现有的自定义插件里就行；
  - 桌面：打包时生成 `electron/runtime.json` 放进 app.asar，由加载器读取。

### 3.3 热更新包、清单、签名、托管

**产物**（每次正式发版由 CI 生成）

- `nowen-hot-android-<version>.zip`：`frontend/dist` 的内容，zip 根目录就是 `index.html`。
- `nowen-hot-desktop-<version>.zip`：按仓库结构放 `electron/`、`frontend/dist/`、`backend/dist/`、`backend/templates/`、`backend/package.json`，三个桌面平台共用一份。如果发现里面有和平台相关的文件，停下汇报。
- 打包必须是确定性的：文件顺序和时间戳固定，同一个输入目录打两次，sha256 相同。
- 热更新包要用同一次发版构建出的产物生成，优先复用 android 和 desktop job 已经构建好的 `frontend/dist`、`backend/dist`。清单里记录源 commit。

**清单** `nowen-hot-<target>-<runtimeVersion>.json`，字段至少包括（下面的数值只是示例）：

```json
{
  "schema": 1,
  "target": "android",
  "channel": "stable",
  "runtimeVersion": "<壳指纹>",
  "version": "1.6.3",
  "bundleId": "1.6.3-<zip sha256 前 8 位>",
  "sequence": 1795000000,
  "commit": "<git sha>",
  "urls": [
    "https://download.nowen.cn/hot/<tag>/nowen-hot-android-1.6.3.zip",
    "https://github.com/cropflre/nowen-note/releases/download/<tag>/nowen-hot-android-1.6.3.zip"
  ],
  "size": 8455158,
  "sha256": "<zip 的 sha256>",
  "zipSignature": "<base64>",
  "files": { "frontend/dist/index.html": "<sha256>" },
  "revokedBundleIds": [],
  "createdAt": "2026-11-22T00:00:00Z"
}
```

- `sequence` 单调递增，可以用发版时间戳。客户端记录见过的最大值，拒绝更小的，防止有人重放旧清单让客户端降级。
- `files` 是每个文件的 sha256，桌面必填，安卓可以不填。
- 清单不放数据库版本：后端 schema 版本由 2000 多行迁移代码在运行时算出，构建期解析不可靠。回退时，以客户端实际运行过并记录下来的版本为准。
- 清单和签名放在同一个签名信封里：`{ schema: 1, payload: <清单 JSON 的 base64>, signatures: [{ keyId, algorithm, signature }] }`。渠道地址覆盖时是一次原子写入。客户端先验签名，通过后才解析 payload。

**签名**（算法由安卓插件决定，已读插件源码确认）

- `@capawesome/capacitor-live-update` 8.8.2 在安卓上用 `Signature.getInstance("SHA256withRSA")` 对下载下来的 zip 原始字节验签。公钥是 X.509 SubjectPublicKeyInfo 格式的 PEM（`-----BEGIN PUBLIC KEY-----`），签名是 base64。配置了 `publicKey` 之后，签名就是必填项，插件也不再单独校验 checksum。
- 所以统一用 RSA 3072 + SHA-256 + PKCS#1 v1.5。Node 端 `crypto.sign("sha256", bytes, privateKey)` 默认就是这种填充方式。必须写互通测试：用 Node 签名，再用和插件相同的算法（Java 或 openssl）验证；还要在真机或模拟器上做一次端到端验证。
- 桌面壳内置一个**公钥列表**，便于轮换密钥。安卓插件只能配一把公钥，换钥要发新 APK（`capacitor.config.ts` 是指纹输入，runtimeVersion 会随之改变）。
- 新增脚本：
  - `scripts/hot-update/generate-keys.mjs`：由用户在本地执行，私钥只写到本地文件，并提示用户离线备份两份；
  - `scripts/hot-update/sign.mjs`：从 Secret `NOWEN_HOT_UPDATE_PRIVATE_KEY` 读取私钥签名，不打印私钥；
  - `scripts/hot-update/verify.mjs`：用入库的公钥校验产物，CI 自检和本地复核共用。

**托管**（全部用现有的免费渠道）

- zip 和签名信封作为 GitHub Release 资产上传，再由 `sync-r2-hot-update.yml` 复制到 `https://download.nowen.cn/hot/<tag>/`。
- 另外在 R2 写一个固定的渠道地址 `https://download.nowen.cn/hot/stable/<target>/<runtimeVersion>.json`，内容就是签名信封，每次发版覆盖，而且只向前移动。客户端先读它，读不到再读 `https://github.com/cropflre/nowen-note/releases/latest/download/nowen-hot-<target>-<runtimeVersion>.json`。
- 请求里不得带用户标识、服务器地址、token 等信息。

**出问题时**

- 以尽快发修复版"往前滚"为主。
- 清单里的 `revokedBundleIds`：客户端发现当前生效的包被撤回后，下次启动退回上一个可用版本或内置版本，同时遵守 3.7 的数据库规则。

### 3.4 客户端通用规则

- 检查时机：启动后约 30 秒检查一次，之后每 6 小时一次；安卓从后台回到前台时也检查；离线时不检查。
- 以下条件全部满足才接受新包：
  - 清单签名有效；
  - target 一致；
  - runtimeVersion 完全相等；
  - version 高于当前生效的版本；
  - sequence 大于见过的最大值；
  - bundleId 既不在本机的屏蔽列表里，也不在 `revokedBundleIds` 里。
- 安卓只在非计费网络下自动下载（用 `@capacitor/network` 判断）。用户手动点"检查更新"时不受这个限制。
- 生效时机：下载、校验完成后，下次冷启动生效；同时提供"重启以更新"按钮，不强制立即重启。切换前必须先让编辑器保存、把 Outbox 和同步队列写入磁盘（复用 `preparing-install` 的思路）。
- 版本展示：设置或关于页里同时显示"应用版本（当前生效的包）""安装包版本（壳）"和 runtimeVersion。日志和问题反馈里都要带上这三项。
- 与整包更新的配合：
  - 当前 runtime 的最新热更新版本不低于最新正式版时，不再提示整包更新；
  - 否则说明新版本改了壳，走现有的整包流程；
  - electron-updater 比较的是 `app.getVersion()`，也就是壳版本，热更新以后会误报"有新版本"，必须修正。
- `UpdateNotifier.tsx`：
  - 安卓和桌面的软提示改成"立即检查热更新"；
  - 安卓硬提示改为比较壳版本（`@capacitor/app` 的 `App.getInfo().version`，或插件的 `getVersionName()`），不再用 `__APP_VERSION__`。
- 设置的"使用偏好"里加一个"自动下载更新"开关，默认打开。

### 3.5 安卓实现

- 依赖：安装 `@capawesome/capacitor-live-update` 并固定精确版本（当前是 8.8.2，MIT 协议）。按官方文档完成安卓集成，然后执行 `npx cap sync android`。iOS 工程同步时也会带上这个插件：iOS 上不下载、不切换包，但要确保 iOS 构建能通过。
- `capacitor.config.ts` 里的插件配置：`readyTimeout: 10000`、`autoDeleteBundles: true`、`autoBlockRolledBackBundles: true`、`autoUpdateStrategy: "none"`、`publicKey: <入库公钥 PEM>`。公钥只维护一个入库文件，构建时分别注入 Capacitor 配置和 JS 代码，并用测试保证两处一致。
- 代码放在 `frontend/src/lib/hotUpdate/`。清单解析、验签、接受条件判断、回退目标选择这些纯逻辑写成纯函数，并配单测。流程如下：
  1. 依次请求固定的渠道地址，取回签名信封，用 WebCrypto（RSASSA-PKCS1-v1_5 / SHA-256）验签；
  2. 按 3.4 的条件判断是否接受；
  3. 调用 `LiveUpdate.downloadBundle({ url, bundleId, signature: zipSignature, artifactType: "zip" })`，再调用 `setNextBundle({ bundleId })`；
  4. 提示"重启以更新"。用户确认后先落盘，再调用 `LiveUpdate.reload()`；用户不确认，就在下次冷启动时生效。
- `ready()` 的调用时机：应用界面渲染完成、并且本地数据库成功打开之后，不依赖登录。`ready()` 返回 `rollback: true` 时，提示"更新失败，已恢复到安装包版本"，并记录这次事件。
- 下载必须走插件的 `downloadBundle`。不要用 CapacitorHttp 自己下载二进制文件，仓库里已经踩过它处理二进制的坑。

### 3.6 桌面实现

代码放在 `electron/hot-update/` 下，用 CommonJS，风格与现有的 `electron/*.js` 保持一致。

**加载器 `loader.js`**（属于壳，永远不热更新）。在 `main-bootstrap.js` 里、`require('./main.js')` 之前调用：

- 状态文件 `<userData>/hot-update/state.json` 记录 `{ active, pending, lastGood, blocked, bootAttempts, maxSequence }`。写入时先写临时文件再 rename，保证原子性。
- 选择顺序：pending → active → 内置版本。选中热更新包时，重新校验清单签名和包内全部文件的 sha256，不通过就当作损坏处理。把这项校验的实测耗时写进汇报。
- 每次用候选包启动时 `bootAttempts` 加一；超过 2 次还没收到"就绪"信号，就屏蔽这个包，退回 lastGood 或内置版本。
- 加载热更新包里的 main.js 之前，要让它能解析 app.asar 里的 node_modules（例如把 `path.join(app.getAppPath(), "node_modules")` 加进全局模块搜索路径），并把热更新包的根目录告诉主进程代码（例如通过环境变量或模块级变量）。`process.resourcesPath` 仍然指向安装目录。
- 如果热更新包的 main.js 在 require 阶段就抛异常：屏蔽这个包，执行 `app.relaunch()` 后 `app.exit()`。不要在同一个进程里再 require 另一份 main.js。

**主进程改造**

- 逐个检查 `electron/*.js` 里 `__dirname`、`process.resourcesPath`、`app.getAppPath()` 的用法，分清哪些是热更新资源，哪些是壳资源：
  - 前端目录、后端入口、`backend/templates`、preload → 当前生效的包；
  - 图标、clipper native host、`backend/node_modules` → 安装目录。
- 启动后端子进程时设置 `NODE_PATH=<resources>/backend/node_modules`（后端是 CommonJS，NODE_PATH 对它有效），`FRONTEND_DIST` 指向当前生效的包。核对后端对 templates 等相对路径的解析是否正确。
- 核对 `security.js` 的 file:// 规则在热更新包路径下仍然成立（只允许当前入口自身重载），不要放宽成允许任意 file://。
- `main-bootstrap.js` 里用正则识别后端子进程（匹配 `backend/dist/index.js`），这个正则对热更新包里的路径也要继续生效。

**就绪信号**

- renderer 首屏挂载完成，并且本地后端 health 检查通过（remote 运行时只看 renderer），就发 IPC `hot-update:ready`，然后写入 `lastGood = active`、`bootAttempts = 0`。

**下载与安装**

- 主进程把包下载到 `<userData>/hot-update/tmp/`，然后：
  1. 校验 zip 的签名和 sha256；
  2. 解压到 `<userData>/hot-update/bundles/<bundleId>/`，并防范 zip slip：拒绝绝对路径、`..` 和符号链接；
  3. 逐个文件比对清单里的 sha256；
  4. 写入 pending。
- 旧包最多保留 3 个。
- 解压库：主进程目前没有可用的，需要往根 `dependencies` 里加一个零依赖、MIT 协议、仍在维护的库（例如 fflate），并说明理由。
- IPC 参照 `updater:*` 的命名，新增 `hot-update:status`、`hot-update:check`、`hot-update:apply`。renderer 不能传入 URL、路径或公钥。
- 界面：在 `DesktopUpdateCenterCore.tsx` 里展示热更新的状态，包括可用、下载中、待重启、已回退和失败原因。现有的整包流程保留不动。
- 以下情况不启用热更新：未打包的开发态（除非设置了测试用环境变量、指向本地测试服务器），以及微软商店版。

### 3.7 数据库迁移与回退（属于数据一致性范围，必须登记到矩阵）

1. 任何回退都不能让低 schema 的代码去写高 schema 的数据库。依赖并保留现有的两道守卫：后端的 `DatabaseUpgradeRequiredError`，以及安卓 `nativeDatabase.ts` 对 `user_version` 的检查。不得削弱它们。
2. 选择回退目标时，跳过支持的 schema 低于当前数据库版本的包。每次成功启动后，记录该包实际支持的 schema 版本。
3. 桌面在应用一个会升级 schema 的热更新包之前，先做与 `backupDatabaseBeforeUpdate()` 相同的备份。把这个函数抽成共享函数，不要复制粘贴。安卓如果有可复用的备份机制就复用；没有的话，在矩阵里登记为已知风险并汇报，不要自己发明破坏性流程。
4. 如果唯一能用的只剩内置版本，而它的 schema 又低于数据库（后端抛出 `DATABASE_UPGRADE_REQUIRED`，或者安卓报"原生数据库版本高于当前支持版本"），就显示保护页，提供"重新获取最新热更新"和"下载最新安装包"两个选项。这时不写库、不清数据、不自动从备份恢复。这个保护页必须包含在第一个带热更新能力的整包里。
5. 切换包之前，等编辑器保存完、Outbox 写入磁盘。

### 3.8 发版流水线

- 在 `release-build.yml` 里，用同一次构建的产物生成热更新包。签名步骤只在正式发版时注入 Secret，平时的 CI 用测试密钥。
- 构建正式安装包时，把 runtimeVersion 和公钥嵌进壳里（见 3.2、3.5）。
- `release-publish.yml` 把 zip 和签名信封上传到 GitHub Release，再调用新的 `sync-r2-hot-update.yml`，复制到 R2 并前移渠道地址。
- 新增构建目标 `hot`（`scripts/lib/release-cloud-contract.mjs`），发版中心的勾选界面同步加上。原有的安装包资产清单和校验脚本只管安装包，不需要改。

### 3.9 文档

- 新增 `docs/architecture/hot-update.md`，写清楚以下内容：
  - 信任模型和 runtimeVersion 规则；
  - 发版步骤，以及撤回和前滚的做法；
  - 密钥轮换，以及私钥丢失时怎么办；
  - 常见问题，例如为什么 macOS 整包仍然要手动下载。
- 更新 `docs/CODE_SIGNING.md`：加一节"热更新（项目自有 RSA 签名）"，说明它不改变整包的签名政策。
- 在发版说明模板里加一项：本版能通过热更新送达，还是需要安装新安装包。

## 4. 分阶段交付与验收

每个阶段都要运行相关的单测、类型检查和 `node scripts/data-consistency-contract.mjs --verify`。汇报内容包括：改了哪些文件、关键取舍、测试命令和原样输出、哪些没验证、需要用户做什么。

**阶段 1：发版流水线（不改变客户端行为）**

- 范围：3.2、3.3、3.8 涉及的脚本、测试和 workflow 改动。workflow 用测试密钥 dry-run。
- 验收：
  - 指纹的稳定性和敏感性测试通过；
  - 签名互通测试通过；
  - 篡改过的 zip、篡改过的清单、错误的公钥、更小的 sequence 都会被拒绝；
  - 同一个输入打包两次，sha256 相同。

**阶段 2：安卓**

- 范围：3.4、3.5，以及 3.7 的安卓部分。
- 测试环境：模拟器或真机。在电脑上起一个本地 HTTP 服务，托管测试用的清单和包，模拟器通过 10.0.2.2 访问。只有测试构建允许修改更新地址。
- 验收：
  1. 装好 v1 APK 后，发布一个 v1.0.1 热更新包：应用自动下载，重启后生效；登录态、服务器地址、本地笔记、Outbox 全都还在；
  2. 篡改过的包、签名错误的包、runtime 不匹配的包、版本更低的包：全部被拒绝，应用照常使用；
  3. 故意做一个坏包（白屏、不调用 `ready()`）：约 10 秒后回退到内置版本，并屏蔽这个包；
  4. 热更新包升级了本地 schema 后又被强制回退：出现保护页，数据无损；
  5. 抓包确认没有任何请求发往 capawesome、capgo 等第三方域名。

**阶段 3：桌面**

- 范围：3.4、3.6，以及 3.7 的桌面部分。
- 测试环境：打包后的应用，userData 隔离。macOS 至少在本机实测；Windows、Linux 至少各通过一次 CI 或手工验证。
- 验收：
  1. 装好壳 v1 后应用一个热更新包，让前端文案、后端 `/api/version`、主进程日志三处都发生变化：重启后全部生效；
  2. 坏前端（不发就绪信号）、坏主进程（require 时抛错）、坏后端（一启动就退出）：都能自动回退，并屏蔽对应的包；
  3. 应用会升级 schema 的热更新包之前，生成了 `backups-pre-update` 备份；发生回退时出现保护页，旧代码不会写入新库；
  4. 微软商店版和开发态不启用热更新；
  5. 热更新以后，整包检查不再误报有新版本。

**阶段 4：收尾**

- 完成 `UpdateNotifier` 改造、设置开关、文档、发版说明模板。
- 准备"第一个带热更新能力的整包"：所有用户需要先安装一次，之后才能收到热更新。是否发版、何时发版，由用户决定和执行。

## 5. 已知环境坑

- 终端实际是 zsh：通配符要加引号；变量后面紧跟冒号时，要写成 `${VAR}:`。
- vitest：机器不在东八区时，有 3 个时区用例固定失败。用 `TZ=Asia/Shanghai` 运行可以全部通过，这不是回归。
- 后端测试：
  - better-sqlite3 是按 Electron ABI 编译的，要用 Electron 当 Node 运行（`ELECTRON_RUN_AS_NODE=1`）；
  - TMPDIR 要设成真实存在的短路径；
  - tsx 不做类型检查，要另外跑 tsc；
  - lint 基线本来就是红的，只看新增的问题。
- `frontend/vite.config.ts` 把 20 多个组件替换成了 Runtime/Shell 壳组件，tsc 和 vitest 都看不到这层别名。给被替换的组件加 prop，可能在真实构建里悄悄丢失，所以改了 UI 要在真实页面上验证。
- `EditorPane`、`MarkdownEditorImpl`，以及 `index.css` 的注释里有大量 U+FFFD 乱码。只改完好的行，改完核对一遍。
- 用 Playwright 直接驱动产品的 `main.js` 时，renderer 可能卡死。renderer 部分可以用一个最小外壳加载 file:// 页面来验证；加载器和回退逻辑必须在打包后的应用里实测。
- 如果用 Claude Code 的 Edit/Write 工具：字符串末尾的空格可能被吞掉，`\u` 转义可能被解码成实际字符。改完扫一遍 diff。

## 6. 遇到这些情况先停下来问

- 发现热更新层里有和平台相关的文件；
- 需要改 `androidScheme`、改数据库迁移的语义，或者删除、覆盖任何用户数据；
- 需要用到付费服务或第三方托管；
- 指纹规则导致"每个版本都变"，或者"该变的时候没变"；
- 任何推送、合并、打 tag、发版、写 Secret 的操作。
