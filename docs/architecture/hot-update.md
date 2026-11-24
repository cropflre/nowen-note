# 热更新

> 状态（2026-11-23）：
> - 阶段 1「发版流水线」已完成：打包、签名、校验、发布到 GitHub Release 和 R2 渠道。
> - 阶段 2「安卓客户端」已完成，并在模拟器上做了端到端验收，记录见下文。
> - 阶段 3「桌面客户端」已完成，在开发构建和打包后的 macOS 应用上做了真实 Electron 验收，记录见下文；Windows、Linux 安装包还没有实测。
> - 阶段 4「收尾」已完成：发布说明的「更新方式」由脚本生成，桌面候选构建会核对安装包里的锚点。第一个带热更新能力的整包还没有发出，步骤见「第一个带热更新能力的整包」。
>
> 完整任务书见 [AI 开发提示词](../superpowers/specs/2026-11-22-hot-update-dev-prompt.md)。

## 目标与信任模型

- 大多数版本只改前端、后端和主进程 JS。这些版本以热更新包的形式送到已安装的客户端，不用重装。
- 全程免费、自托管：GitHub Release + `download.nowen.cn`（R2）。不依赖任何热更新云服务。
- 信任来自**项目自己的 RSA 密钥**，不是 Apple Developer ID 或 Windows Authenticode。整包的签名政策（见 [CODE_SIGNING.md](../CODE_SIGNING.md)）不变：
  - 私钥只放在 GitHub Secret `NOWEN_HOT_UPDATE_PRIVATE_KEY`，以及维护者的离线备份里；
  - 公钥提交在 `hot-update/public-keys.json`，以后会编进安装包；
  - 客户端只信任编进安装包的公钥，下载地址也写死在客户端里。

## 产物

每个版本最多四个文件，作为 GitHub Release 资产发布：

| 文件 | 内容 |
| --- | --- |
| `nowen-hot-android-<version>.zip` | `frontend/dist` 的内容，zip 根目录就是 `index.html` |
| `nowen-hot-desktop-<version>.zip` | `electron/`（不含 `main-bootstrap.js`、`electron/hot-update/`、打包配置、测试）、`frontend/dist/`、`backend/dist/`、`backend/templates/`、`backend/package.json`；Windows / macOS / Linux 共用 |
| `nowen-hot-<target>-<runtimeVersion>.json` | 签名信封，两端各一份 |

zip 是确定性的：条目按路径排序、时间戳固定、不写目录条目。同一个提交打两次，逐字节相同。

签名信封：

```json
{ "schema": 1, "payload": "<清单 JSON 的 base64>", "signatures": [{ "keyId": "<16 位>", "algorithm": "RSA-SHA256-PKCS1v15", "signature": "<base64>" }] }
```

清单和签名放在同一个文件里。R2 渠道地址被覆盖时是一次原子写入，客户端不会读到"新清单 + 旧签名"。

清单字段（只接受这些字段；严格校验见 `scripts/hot-update/lib/manifest.mjs`）：

| 字段 | 说明 |
| --- | --- |
| `schema`、`target`、`channel` | `1`、`android` / `desktop`、`stable` |
| `version` | 应用版本，与 Tag 一致 |
| `runtimeVersion` | 这个包要求的壳指纹，客户端必须**完全相等**才接受 |
| `bundleId` | `<version>-<zip sha256 前 8 位>` |
| `sequence` | 提交时间（秒）。客户端拒绝比见过的最大值更小的清单，防止重放旧清单导致降级 |
| `commit`、`createdAt` | 源码提交及其时间 |
| `size`、`sha256` | zip 的大小和摘要 |
| `zipSignature` | 对 zip 原始字节的签名，安卓插件按 `SHA256withRSA` 校验 |
| `urls` | R2 地址在前，GitHub 地址在后；只允许 `download.nowen.cn` 和 `github.com` 的 https 地址 |
| `files` | 仅桌面：zip 内每个文件的 sha256，加载器启动时用它复核 |
| `revokedBundleIds` | 已撤回的包，来自 `hot-update/config.json` |

清单里不放数据库版本。后端的 schema 版本由 2000 多行迁移代码在运行时算出，构建期解析不可靠。回退后能不能打开本机数据，由代码自己在启动时判断：安卓看 `user_version`，桌面看后端的启动检查（见两端的「数据保护」）。

## 壳指纹 runtimeVersion

格式是 `e<runtimeEpoch>-<16 位十六进制>`，由 `scripts/hot-update/lib/fingerprint.mjs` 从 **git 提交**（默认 HEAD）计算。所以同一提交在任何机器上算出的值都相同，与工作区是否有未提交的改动无关。

| 目标 | 计入的输入 |
| --- | --- |
| 安卓 | `frontend/android/` 下所有被跟踪的文件，排除：`assets/public`、`src/test`、`src/androidTest`、gradle wrapper、`.gitignore`，以及 `app/build.gradle` 里的 versionCode / versionName；`frontend/capacitor.config.ts`；`capacitor.settings.gradle` 列出的原生插件和 `@capacitor/android`、`@capacitor/core` 在 lockfile 里的版本；`hot-update/public-keys.json` |
| 桌面 | Electron 版本；根 `package.json` 生产依赖的解析版本（这些依赖打进 app.asar）；`backend/build.bundle.mjs` 的 external 名单及其版本；`electron/main-bootstrap.js`、`electron/hot-update/**`、clipper 宿主文件；`hot-update/public-keys.json` |

**有意不计入**：electron-builder 配置（`electron/builder*.js`、`build/`）。这些文件大多是构建期校验，计入会让很多版本白白失去热更新。如果打包结构的改动让新代码依赖了新的资源、extraResources 或 node_modules 过滤规则，**必须手动把 `hot-update/config.json` 里对应的 `runtimeEpoch` 加一**。

查看当前提交的指纹，以及参与计算的全部输入：

```bash
node scripts/hot-update/runtime-fingerprint.mjs --explain
```

## 一次性准备（维护者本人操作）

在**仓库之外**的目录生成密钥。脚本会拒绝写进任何 git 工作区：

```bash
node scripts/hot-update/generate-keys.mjs --private-key-out ~/nowen-hot-update-private.pem
```

把私钥存进 GitHub Secret：

```bash
gh secret set NOWEN_HOT_UPDATE_PRIVATE_KEY < ~/nowen-hot-update-private.pem
```

然后：

1. 把私钥离线备份两份。私钥丢了，已安装的客户端就再也收不到热更新，只能发新整包、换新钥。
2. 提交 `hot-update/public-keys.json`。注意：公钥列表本身是壳指纹的输入，加钥或换钥会改变两端的 runtimeVersion。

## 第一个带热更新能力的整包

只有装了带公钥安装包的用户才能收到热更新。公钥是打包时写进安装包的，所以顺序不能乱：

1. **生成密钥并提交公钥**：维护者本人操作，见上一节。提交后两端的壳指纹都会变。
2. **合入发版分支**：把 `feat/hot-update` 合入当前发版分支，跑 `npm run test:hot-update`、`npm run test:update-release`、`npm run test:microsoft-store`，以及前端和 `electron/__tests__` 的测试。
3. **候选构建，验证流水线**：在发版中心发起不发布的候选构建，目标包含 `pc`、`android`、`hot`。这是这些工作流第一次在 GitHub 上运行，任何一步失败都先修好：
   - plan 阶段的 Secret 和公钥检查通过；
   - 安卓 `android-stage` 和桌面的「Verify hot-update trust anchors」都通过，输出里有公钥 ID：安卓日志不是 `key none`，桌面摘要不是「没有公钥」；
   - `release-hot` 产物里有两端的 zip 和签名信封。
4. **正式发版**：这一版的「更新方式」会是「本版是第一个支持热更新的版本，需要下载安装一次」。
5. **发布后核对**：
   - GitHub Release 里有 `nowen-hot-android-<version>.zip`、`nowen-hot-desktop-<version>.zip` 和两份签名信封；
   - `https://download.nowen.cn/hot/stable/<target>/<runtimeVersion>.json` 能下载，内容与 Release 里的信封相同；
   - 装上这个整包，「设置 → 关于」显示壳版本号；手动检查热更新，提示「当前已是最新版本」。
6. **下一个版本**：壳没变时，「更新方式」会显示热更新送达。正式通知用户之前，先在一台设备上手动检查，确认能下载、重启后生效。

Tag 触发的 `release.yml` 只打安装包，不生成热更新包。这个整包和之后的版本都要走发版中心的云端流程。

## 每次发版

1. 在发版中心勾选构建目标「热更新包」（`hot`），或用 `--target ...,hot`。plan 阶段会检查 Secret 和入库公钥。
2. `release-build.yml` 的 `hot` job 依次执行：
   - 用与安装包相同的命令构建前后端；
   - `build-bundles.mjs` 打包；
   - `sign.mjs` 签名，私钥只在这一步出现；
   - `verify.mjs --check-runtime` 用入库公钥和源码指纹复核；
   - 上传为 `release-hot` 产物，进入不可变的产物清单。
3. `release-publish.yml` 把产物随其他资产一起上传到 GitHub Release，再调用 `sync-r2-hot-update.yml`：
   - 按 Tag 源码重新复核；
   - 把文件复制到 R2 的 `hot/<tag>/`，这是不可变目录：已存在的对象必须完全一致；
   - 用 `pointer.mjs decide` 判断后，覆盖渠道地址 `hot/stable/<target>/<runtimeVersion>.json`。渠道地址**只向前移动**：重跑旧版本的发布不会把它指回去。
4. 发布说明按[模板](../releases/github-release-template.md)写。其中「更新方式」用命令生成，`--since` 填上一个正式版的 Tag：

   ```bash
   node scripts/hot-update/update-mode.mjs --since v1.6.1
   ```

   壳没变时，它写「已经是 v1.6.1 的用户会在应用内自动收到本版」；壳变了，它列出原因，例如 `electron 43.8.4 → 44.0.0`。

构建时会核对安装包里的锚点：安卓在 `android-stage`，桌面在候选构建打包之后（`verify-desktop-anchors.mjs`）。和源码不一致就失败。没有公钥时核对照样通过，但会写明这批安装包不接受热更新。

客户端轮询以下两个地址：

```
https://download.nowen.cn/hot/stable/<target>/<runtimeVersion>.json     # 优先
https://github.com/cropflre/nowen-note/releases/latest/download/nowen-hot-<target>-<runtimeVersion>.json   # 备用
```

改了壳的版本，旧客户端在这两个地址都找不到自己 runtime 的新清单，会继续走现有的整包更新提示。

## 出问题时

- 首选尽快发修复版"往前滚"。
- 要撤回某个包，把它的 bundleId 加进 `hot-update/config.json` 的 `revokedBundleIds`，然后随下一个版本发布。客户端看到当前生效的包被撤回，会退回上一个可用版本或安装包自带的版本（阶段 2、3 实现）。
- 换钥、私钥丢失或泄露：见下一节。

## 密钥轮换与私钥丢失

安装包只信任打包时写进去的那一把公钥（公钥列表的第一把）。公钥列表又是两端壳指纹的输入，所以换钥一定伴随一次整包更新：旧安装包在渠道地址上找不到自己壳指纹的新清单，会走整包更新提示，不会出现验签失败。

**计划内换钥：**

1. 在仓库之外生成新密钥。`generate-keys.mjs` 会把新公钥追加到列表末尾，要手动把它移到第一位，因为签名只认第一把。旧公钥可以同时删掉。
2. 用新私钥更新 Secret `NOWEN_HOT_UPDATE_PRIVATE_KEY`，再离线备份两份。
3. 随一个整包版本发布。这一版的「更新方式」会显示两端都需要新安装包，原因是「热更新签名公钥有变化」。
4. 新版本发出后，旧私钥就没有用了：旧安装包的壳指纹不同，收不到之后的任何清单。

**私钥丢失**（还在用，但再也签不出新包）：已安装的客户端只信任旧公钥，从此收不到热更新，但整包更新提示照常，数据不受影响。按计划内换钥发一个整包，用户装上后热更新恢复。

**私钥泄露：**

- 拿到私钥的人能签出客户端会接受的包。不过客户端只从安装包里写死的两个地址下载（`download.nowen.cn` 和本仓库的 GitHub Release），对方还得能写这两个地方。
- 已经装上的旧安装包无法吊销旧公钥，换钥只能保护之后装上新整包的用户。所以发现泄露后要立即做两件事：
  - 按计划内换钥发整包；
  - 检查 R2 和 GitHub 的写权限和访问记录，确认渠道地址和 Release 资产没被替换。
- 防范靠保管：私钥只放在 GitHub Secret 和两份离线备份里，不进任何仓库、日志或产物。

## 本地命令

| 命令 | 作用 |
| --- | --- |
| `npm run test:hot-update` | 全部热更新测试。临时 git 仓库加临时密钥，覆盖篡改、降级、多余文件、壳变化、openssl 交叉验签 |
| `node scripts/hot-update/build-bundles.mjs --out <dir>` | 用已构建好的 `frontend/dist`、`backend/dist` 打包，生成清单草稿 |
| `NOWEN_HOT_UPDATE_PRIVATE_KEY=... node scripts/hot-update/sign.mjs --dir <dir>` | 签名。私钥只从环境变量读取 |
| `node scripts/hot-update/verify.mjs --dir <dir> --version X.Y.Z [--commit SHA] [--check-runtime]` | 复核 |
| `node scripts/hot-update/pointer.mjs key --file <清单>` | 算出清单对应的 R2 渠道地址 |
| `node scripts/hot-update/pointer.mjs decide --next <新清单> --current <现有文件>` | 判断渠道地址是否应该前移 |
| `node scripts/hot-update/runtime-fingerprint.mjs [--revision <Tag 或提交>] [--explain]` | 某个提交两端的壳指纹，以及参与计算的输入 |
| `node scripts/hot-update/update-mode.mjs --since <上一个正式版 Tag> [--ref <提交>] [--json]` | 发布说明的「更新方式」：本版能否通过热更新送达；壳变了的话列出原因 |
| `node scripts/hot-update/verify-desktop-anchors.mjs [--dist dist-electron]` | 核对打包好的桌面应用里的锚点与源码提交一致 |

## 安卓客户端（阶段 2）

**信任锚点在安装包里。** `npx cap sync android` 执行 `capacitor.config.ts` 时，会做三件事：

- 从 git 提交算出安卓壳指纹；
- 取 `hot-update/public-keys.json` 的**第一把**公钥；
- 把两者写进 APK 自带的 `assets/capacitor.config.json`（已被 gitignore）。

热更新包只替换网页目录，改不到这里。前端通过原生插件 `NowenHotUpdateRuntime` 读取这些值，不信任网页包自带的副本。`@capawesome/capacitor-live-update` 也用同一把公钥，按 `SHA256withRSA` 校验 zip。发版流水线的 `android-stage` 会解开 APK 复核这两个值和源码一致。签名必须使用列表第一把公钥（`sign.mjs` 强制检查），因为安卓插件只能配置一把。

**流程**（`frontend/src/lib/hotUpdate/`）：

1. 启动后约 30 秒检查一次，之后每 6 小时一次；回到前台时，距上次检查超过 1 小时也会检查。自动下载只在 Wi-Fi 下进行，「关于 → 应用更新」里可以关掉；手动检查不受这些限制。
2. 先请求 R2 渠道地址，失败再请求 GitHub。两个都返回 404，表示这个安装包暂无热更新。请求带按小时变化的 `t` 参数，避开缓存。
3. 用安装包里的公钥验签，再判断：壳指纹完全相等、版本更高、序号不小于见过的最大值、没有被撤回或屏蔽。满足才交给插件下载。插件验签失败就换下一个地址，全部失败时报错。
4. 下载完成后设为下次启动的版本，底部提示「立即重启」；不点的话，下次冷启动生效。
5. 每次启动，等真实界面出现、本地库正常打开后调用 `ready()`。新包 **45 秒**内没有确认，插件会退回安装包自带的版本并屏蔽这个包；进程中途被杀，也会在下次启动时回退。超时不用 10 秒，是因为应用自己把 12 秒才算作慢启动，低端机再加上首次数据库迁移，容易被误判成坏包。

**数据保护（DCC-013）。** 本地库的 `user_version` 高于代码支持的版本时，`openNativeDatabase` 会抛出 `NativeDatabaseUpgradeRequiredError`。这种情况通常是新包升级了数据库后又被回退。启动时只显示保护页，不读写数据，只提供「获取最新版本」和「下载最新安装包」两个出口；保护页的重试允许重新下载曾被屏蔽的新包。本地库因为代码问题打不开时不调用 `ready()`，让插件回退。

**其他行为变化：**

- `UpdateNotifier` 在安卓上的"刷新"改为"检查更新"：原来的刷新只会重新加载安装包里同一份前端。
- 安卓的强制升级改为比较安装包版本（`App.getInfo()`），不再用 `__APP_VERSION__`。
- `frontend/android/app/build.gradle` 排除了插件依赖带来的重复文件 `META-INF/versions/9/OSGI-INF/MANIFEST.MF`，否则打包失败。

**隐私。** 插件的每次下载请求都会带 `X-Capawesome-Device-Id` 请求头，值是安装时本地随机生成并保存的 UUID，与账号和设备硬件无关，没有配置项可以关闭。它只发给我们自己的下载源（download.nowen.cn、GitHub）。插件不会连接 Capawesome Cloud：我们不调用 `sync` 等云端接口，也不配置 `appId`；设备上抓包确认过。要彻底去掉这个请求头，需要给插件打补丁，目前没有这样做。

**本机测试包**（只用于设备验收）：

```bash
VITE_HOT_UPDATE_TEST_CHANNEL=http://10.0.2.2:8787 npx vite build --mode hotupdate-test
```

```bash
NOWEN_HOT_UPDATE_TEST_PUBLIC_KEYS_FILE=<临时公钥列表> npx cap sync android
```

测试模式下：

- 渠道地址和允许的下载来源换成测试服务；
- 前端在 `window.__nowenHotUpdateTest` 暴露调度器，方便验收脚本操作；
- 正式构建里，这两段代码在编译期被裁掉（已验证）。

CI 里设置测试公钥变量会直接失败。

### 设备验收记录（2026-11-22，模拟器 API 36，arm64）

测试密钥和测试服务都是临时的。

| 场景 | 结果 |
| --- | --- |
| 1. 安装 1.6.0 后发布 1.6.1 | 启动 30 秒后在 Wi-Fi 下自动拉取清单，插件验签后下载；冷启动后运行 1.6.1。localStorage 里的标记和服务器地址、WebView 来源 `https://localhost`、本地笔记都保持不变 |
| 2. 坏清单 | zip 被篡改：插件报 `Signature verification failed.`，被拒绝。其他钥签名：「没有安装包信任的签名」。壳不同：「新版本需要安装新的安装包」。版本不更高：「当前已是最新版本」。序号回退：「已忽略」。全程停留在 1.6.1，正常运行 |
| 3. 签名合法但白屏的 1.6.3 | 冷启动后正好 45 秒回退到安装包自带的版本，日志出现 `Bundle blocked`；再次检查时提示「上次更新启动失败，已跳过这个版本」；本地笔记不变 |
| 4. 本地库被升到 14（代码支持到 13） | 冷启动只显示保护页、两个按钮，应用主界面没有渲染；拉出数据库只读检查，`user_version` 仍是 14，数据和之前一致 |
| 5. 设备内 `tcpdump -i any` 抓完整流程 | App 只连了测试服务器（清单 1 次、zip 1 次），没有 capawesome、capgo 等第三方域名；另有安卓系统自动填充服务的流量，与 App 无关 |

没有覆盖的部分：

- 账号模式下的 Outbox：模拟器上没有服务器，演练使用的是「仅此设备」模式；
- 真机；
- 保护页「获取最新版本」在真实新包上的恢复流程，这一项只有单测覆盖。

## 桌面客户端（阶段 3）

**信任锚点在安装包里。** electron-builder 打包时（`electron/builder.base.config.js` 的 `extraMetadata`），从 git 提交算出桌面壳指纹，取 `hot-update/public-keys.json` 的第一把公钥，写进 app.asar 里 `package.json` 的 `nowenHotUpdate` 字段。热更新包放在用户数据目录，改不到 app.asar。以下情况不启用热更新，也不发任何请求：

- 未打包的开发构建；
- Microsoft Store 版；
- 公钥列表为空的安装包（`no-public-key`）。

**哪些属于壳，哪些随热更新替换：**

- 壳：Electron、`electron/main-bootstrap.js`、`electron/hot-update/`、app.asar 里的生产依赖（electron-updater）、`backend/node_modules`、打包结构；
- 热更新包：其余 `electron/*.js`（主进程和 preload）、`frontend/dist`、`backend/dist`、`backend/templates`、`backend/package.json`。

**启动时选包**（`electron/hot-update/runtime.js`）。状态在 `<userData>/hot-update/state.json`，包在同目录的 `bundles/<bundleId>/`。

1. 有待生效的新包：试运行它，最多连续两次；
2. 否则用已确认可用的包；
3. 否则用安装包自带的版本。

每次启动都会重新验签清单、核对壳指纹，并逐个比对包内文件的 sha256。实测 486 个文件、32 MB，耗时 27–73 毫秒。不通过就屏蔽这个包，退回上一级。装了新安装包（壳指纹变了）时，旧状态和旧包全部作废。

**运行热更新包时：**

- 主进程代码从包里加载，`process.resourcesPath` 仍指向安装目录。
  - 包里的文件要从安装包的 `node_modules`（在 app.asar 内）解析 electron-updater。加载器包装了 `Module._nodeModulePaths`，只对包内 `electron/` 下的文件，把这个目录加在最前面。
  - 改 `Module.globalPaths` 没有用：它只是 Node 启动时留的副本。
- 后端从包里启动，用 `NOWEN_APP_VERSION_OVERRIDE` 报告实际运行的版本。
  - 包内的 `backend/node_modules` 是加载器建的链接，指向安装目录的依赖。Windows 用目录联接，不需要管理员权限。AppImage 每次挂载的位置不同，所以每次启动都会核对、必要时重建。
  - 不用 `NODE_PATH`：后端里的 `import("sharp")`、`import("unpdf")` 等动态导入走 ESM 解析，不认 NODE_PATH。
  - 校验包时忽略这个链接。删包时先拆链接、再删目录，不会删到安装目录。
- 前端从包里的 `frontend/dist` 加载。

**就绪与回退：**

- 界面出现、启动页撤下后，渲染进程调用 `nowenDesktop.hotUpdate.ready()`。本地后端在开窗前已经通过健康检查。
- 试运行的包 **180 秒**内没有确认就绪：立即屏蔽，重启到上一个可用版本。桌面要先启动后端，第一次还可能迁移数据库，所以比安卓的 45 秒宽松。
- 主进程代码在加载阶段抛错：屏蔽并重启，不在同一个进程里再加载另一份。
- 进程中途退出（例如后端起不来）：下次启动时记一次失败；连续两次没完成就屏蔽。
- 远端服务连不上、本机数据库比代码新：属于环境原因，不计入试运行次数。
- 退回后界面提示一次，「关于」里显示原因。
- 热更新触发的所有重启都走 main.js 的 `relaunchApp()`：先停后端和托盘，再退出。直接 `app.exit` 会跳过 before-quit，旧后端会继续占着数据库。

**检查与下载：**

- 启动 30 秒后检查一次，之后每 6 小时一次；新包试运行期间不自动检查。
- 先请求 R2 渠道地址，失败再请求 GitHub。请求不走缓存，带按小时变化的 `t` 参数。
- 下载后校验 zip 的大小、摘要和签名。解压前、写盘后各逐个比对一次文件摘要，拒绝绝对路径、`..` 和清单以外的文件，然后标记为待生效。
- zip 由壳内置的读取器解开（只认流水线产出的确定性 zip），没有新增依赖。
- 磁盘上只保留正在运行、待生效、试运行中和已确认可用的包。

**界面：**

- 「设置 → 关于 → 更新偏好」显示：正在运行的版本（热更新或安装包自带）、安装包版本、壳版本号、当前状态，以及「自动下载热更新」开关；
- 新包下载好后，底部提示「立即重启」；
- 点重启时，先像整包安装那样让编辑器保存（`runEditorSafetyFlush`），等 1.8 秒再重启。

**数据保护（DCC-013）：**

- 每个新包第一次启动前，用与整包安装相同的函数（`electron/db-backup.js`）把数据库三件套复制到 `backups-pre-update/<时间>/`，只保留最近 3 份。清单里没有 schema 版本，判断不了新包会不会升级数据库，所以每个新包都备份。
- 后端发现数据库比代码新时，在任何迁移或写入之前退出。Electron 直接运行 `index.js`，这时退出码是 1；Docker 的启动检查用 78。主进程按错误信息识别，不打开主界面，只弹保护对话框，有三个出口：
  - 「获取最新版本」：允许重新下载曾被屏蔽的新包；
  - 「下载最新安装包」；
  - 「退出」。
- 没有按包记录支持的 schema 版本（任务书 3.7.2）。后端的启动检查本身就是判断依据：旧代码永远不会写新库，能打开这份数据的只有更新的代码，保护对话框给的正是这条路。

**与整包更新的配合：**

- 正在运行的热更新版本不低于整包的新版本时，整包检查不再提示。electron-updater 比较的是壳版本，不处理会误报。
- 整包的政策不变：Windows、macOS 手动下载，Linux AppImage 用 electron-updater，Store 版由商店管理。

**本机验收：**

- 未打包时，设置 `NOWEN_HOT_UPDATE_TEST_ANCHORS` 指向一个 JSON 文件，字段是 `runtimeVersion`、`publicKey`、`keyId`、`channelOrigin`、`readyTimeoutMs`。正式包永远读 app.asar 里的锚点。
- 用包装入口先把 `userData` 和数据目录指到临时目录，再加载 `electron/main-bootstrap.js`。不要对真实数据目录运行。
- 产品每次启动都会向浏览器的 NativeMessagingHosts 目录写剪藏宿主清单。验收进程要用临时 `HOME`，否则会覆盖正式版的配置。

### 验收记录（2026-11-22，macOS 27.3 arm64，Electron 43.8.4）

测试密钥、测试渠道服务和数据目录都是临时的。

- 开发构建：用测试锚点，连续启动 14 次。
- 打包后的应用：用 electron-builder 打出 `--mac dir`，未签名。测试副本只改了 app.asar 里的入口、公钥和渠道地址，启动 6 次。

| 场景 | 结果 |
| --- | --- |
| 1. 停用 | 开发构建没有测试锚点：`development-build`。打包后公钥列表为空：`no-public-key`。两种都不请求渠道。app.asar 里的壳指纹与源码提交算出的一致 |
| 2. 安装包自带 1.6.0，发布 1.6.1 | 检查、下载、暂存后，底部出现「立即重启」；点击后先保存约 1.8 秒再重启。重启后试运行，前端标记、后端 `/api/version`、主进程日志三处都变成 1.6.1。第一次启动前生成了 `backups-pre-update` 备份（记录 1.6.0 → 1.6.1）。界面确认后成为可用版本，之后的启动不再试运行、不再备份 |
| 3. 依赖解析（打包后） | 包内主进程从 `app.asar/node_modules` 解析到 electron-updater。包内 `backend/node_modules` 指向 `Resources/backend/node_modules`。在包内后端目录里 `import()` sharp、better-sqlite3、quickjs-emscripten 都成功，没有链接的对照目录失败 |
| 4. 白屏的 1.6.2（不确认就绪） | 40 秒（测试用的超时）后屏蔽并重启，退回 1.6.1；界面提示一次「未能正常启动」 |
| 5. 主进程一加载就抛错的 1.6.3 | 开发构建和打包后都立即屏蔽并重启，退回 1.6.1 |
| 6. 后端一启动就退出的 1.6.4 | 两次启动都提示「启动失败」后退出；第三次启动屏蔽它，退回 1.6.1 |
| 7. 篡改已确认包里的一个文件 | 校验失败，屏蔽并退回安装包自带的版本 |
| 8. 数据库被升到 99999（代码支持到 147） | 安装包自带的版本和 1.6.5 试运行时，都只弹保护对话框，不打开主界面。「获取最新版本」下载了 1.6.5 并重启；「退出」直接退出。数据库文件逐字节不变；这次失败不计入 1.6.5 的试运行次数 |
| 9. 进程与外部影响 | 每次退出（包括热更新触发的重启）后都没有遗留后端进程；真实浏览器的剪藏宿主清单没有变 |

验收中发现、已经修复的问题：

- 改 `Module.globalPaths` 不影响解析，包内主进程找不到 electron-updater。改为包装 `_nodeModulePaths`。
- 后端的动态 `import()` 不认 NODE_PATH。改为包内依赖链接。
- 热更新触发的重启直接 `app.exit`，会遗留后端进程。改走 `relaunchApp()`。
- 在 Electron 里，数据库过新时后端的退出码是 1，不是 78，保护对话框没有出现。改为按错误信息识别，并等 stderr 读完。

顺带发现、与热更新无关、没有修改：打包后的桌面安装包里没有 `unpdf`（不在 `BACKEND_KEEP_PACKAGES` 白名单里）。安装包自带的后端和热更新包里的后端一样，PDF 附件都提取不了文本，失败被逐个附件的 try/catch 吞掉。

没有覆盖的部分：

- Windows、Linux 的真实安装包：目录联接、AppImage 挂载点、Windows 路径；
- 已签名、已公证的 macOS 安装包；
- 账号模式下的 Outbox 和多设备同步；
- 打包后的白屏、后端退出场景只在开发构建里跑过。这两段逻辑与是否打包无关。

## 常见问题

**为什么还要先装一次安装包？** 旧安装包里没有加载器和公钥，不会检查热更新。装上第一个带热更新能力的整包之后，大多数版本才能在应用内直接更新。

**哪些版本能热更新送达？** 只改前端、后端和主进程 JS 的版本可以。改了 Electron 版本、原生依赖、安卓原生代码、打包结构或公钥的版本，需要新安装包。每一版的发布说明会写明是哪一种。

**为什么 macOS 和 Windows 的整包更新还是要手动下载？**
- 整包更新替换的是整个应用。macOS 上应用内自动安装要求 Apple Developer ID 签名，项目没有购买；Windows 按现有政策同样走浏览器下载。
- 热更新只替换用户数据目录里的前端、后端和主进程 JS，不碰已安装的应用本身，所以不需要这些证书。

**会改动我的数据吗？**
- 新版本的后端可能升级数据库表结构。桌面端在每个新包第一次启动前，先把数据库备份到数据目录的 `backups-pre-update/`。
- 万一退回到旧版本，旧代码发现数据库比自己新，就不会读写它：安卓显示保护页，桌面弹出保护对话框，只提供获取最新版本、下载安装包等安全出口。

**新版本有问题怎么办？** 客户端会自动退回上一个可用的版本，并屏蔽这个包：
- 安卓：45 秒内界面没有正常出现就退回；
- 桌面：180 秒内没有就绪、主进程加载出错、或连续两次没能启动完成，都会退回。

退回后界面提示一次。维护者随后发修复版，或者撤回这个包。

**怎么知道自己在用热更新？** 「设置 → 关于」显示正在运行的版本（热更新或安装包自带）、安装包版本和壳版本号。反馈问题时请把这三项都填上；桌面端的日志开头也会记下它们。

**能关掉吗？** 「关于」里可以关掉自动下载，关掉后仍可手动检查。安卓只在 Wi-Fi 下自动下载。

**哪些版本没有热更新？** Microsoft Store 版（由商店更新）、iOS、开发构建。Docker 和 NAS 等服务端照常更新镜像或安装包，浏览器访问的界面随服务端一起更新。

**会连接第三方服务吗？** 不会。客户端只访问 `download.nowen.cn` 和本仓库的 GitHub Release。安卓插件的下载请求里带一个随机的安装 ID，见安卓一节的「隐私」。

## 后续注意事项

- 前端目前没有自己按版本号打开的 IndexedDB，暂无回退后报 VersionError 的风险。以后新增时，要把它纳入回退保护。
- 打包结构的改动不计入壳指纹。改了 extraResources、`backend/node_modules` 白名单或 asar 里的生产依赖，要把 `runtimeEpoch.desktop` 加一，否则旧壳会收到依赖新结构的包。
