# 热更新

> 状态（2026-11-22）：
> - 阶段 1「发版流水线」已完成：打包、签名、校验、发布到 GitHub Release 和 R2 渠道。
> - 阶段 2「安卓客户端」已完成，并在模拟器上做了端到端验收，记录见下文。
> - 桌面端见阶段 3。
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

清单里不放数据库版本。后端的 schema 版本由 2000 多行迁移代码在运行时算出，构建期解析不可靠。回退时，以客户端实际运行过、并记录下来的版本为准（阶段 3 实现）。

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

客户端轮询以下两个地址：

```
https://download.nowen.cn/hot/stable/<target>/<runtimeVersion>.json     # 优先
https://github.com/cropflre/nowen-note/releases/latest/download/nowen-hot-<target>-<runtimeVersion>.json   # 备用
```

改了壳的版本，旧客户端在这两个地址都找不到自己 runtime 的新清单，会继续走现有的整包更新提示。

## 出问题时

- 首选尽快发修复版"往前滚"。
- 要撤回某个包，把它的 bundleId 加进 `hot-update/config.json` 的 `revokedBundleIds`，然后随下一个版本发布。客户端看到当前生效的包被撤回，会退回上一个可用版本或安装包自带的版本（阶段 2、3 实现）。
- 换钥：把新公钥放到列表第一位，同时切换 Secret，随一个整包版本一起发布。签名只能用第一把公钥。公钥列表本身是壳指纹的输入，所以换钥后，旧安装包收不到新清单，会走整包更新，不会出现验签失败。

## 本地命令

| 命令 | 作用 |
| --- | --- |
| `npm run test:hot-update` | 全部热更新测试。临时 git 仓库加临时密钥，覆盖篡改、降级、多余文件、壳变化、openssl 交叉验签 |
| `node scripts/hot-update/build-bundles.mjs --out <dir>` | 用已构建好的 `frontend/dist`、`backend/dist` 打包，生成清单草稿 |
| `NOWEN_HOT_UPDATE_PRIVATE_KEY=... node scripts/hot-update/sign.mjs --dir <dir>` | 签名。私钥只从环境变量读取 |
| `node scripts/hot-update/verify.mjs --dir <dir> --version X.Y.Z [--commit SHA] [--check-runtime]` | 复核 |
| `node scripts/hot-update/pointer.mjs key --file <清单>` | 算出清单对应的 R2 渠道地址 |
| `node scripts/hot-update/pointer.mjs decide --next <新清单> --current <现有文件>` | 判断渠道地址是否应该前移 |

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

## 留给阶段 3 的注意事项

- 桌面回退目标不能比数据库的 schema 旧：每次成功启动后，记录该包实际支持的 schema 版本。
- 前端目前没有自己按版本号打开的 IndexedDB，暂无回退后报 VersionError 的风险。以后新增时，要把它纳入回退保护。
- 渠道地址上传时带 `Cache-Control: no-cache`，客户端请求也加了按小时变化的查询参数。桌面端照此处理。
