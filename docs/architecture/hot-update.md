# 热更新

> 状态（2026-11-22）：阶段 1「发版流水线」已完成——打包、签名、校验、发布到 GitHub Release 和 R2 渠道。
> 客户端还不会读取热更新：安卓见阶段 2，桌面见阶段 3。完整任务书见
> [AI 开发提示词](../superpowers/specs/2026-11-22-hot-update-dev-prompt.md)。

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
- 换钥：在公钥列表里新增一把，先发一版同时携带新旧两把公钥的整包，再切换 Secret。安卓插件只能配置一把公钥，所以安卓换钥必须发新 APK。

## 本地命令

| 命令 | 作用 |
| --- | --- |
| `npm run test:hot-update` | 全部热更新测试。临时 git 仓库加临时密钥，覆盖篡改、降级、多余文件、壳变化、openssl 交叉验签 |
| `node scripts/hot-update/build-bundles.mjs --out <dir>` | 用已构建好的 `frontend/dist`、`backend/dist` 打包，生成清单草稿 |
| `NOWEN_HOT_UPDATE_PRIVATE_KEY=... node scripts/hot-update/sign.mjs --dir <dir>` | 签名。私钥只从环境变量读取 |
| `node scripts/hot-update/verify.mjs --dir <dir> --version X.Y.Z [--commit SHA] [--check-runtime]` | 复核 |
| `node scripts/hot-update/pointer.mjs key --file <清单>` | 算出清单对应的 R2 渠道地址 |
| `node scripts/hot-update/pointer.mjs decide --next <新清单> --current <现有文件>` | 判断渠道地址是否应该前移 |

## 留给阶段 2、3 的注意事项

- 渠道地址上传时带 `Cache-Control: no-cache`，客户端请求时最好再加一个按小时变化的查询参数，避免 CDN 缓存旧清单。
- 安卓和桌面前端的 IndexedDB 如果在新包里升级了版本号，回退到旧包后 `indexedDB.open` 会报 VersionError。回退保护除了 SQLite，也要覆盖 IndexedDB。
- 桌面回退目标不能比数据库的 schema 旧：每次成功启动后，记录该包实际支持的 schema 版本。
- 安卓只信任 `capacitor.config.ts` 里配置的一把公钥。JS 校验清单用的公钥要和它出自同一个入库文件。
