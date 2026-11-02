# GitHub Actions 构建与发版

本机只触发和查询任务。所有构建、签名、产物汇总、校验及渠道上传都在 GitHub Actions 执行。命令行和发布中心使用相同的 `release-build.yml` / `release-publish.yml` 参数契约。

这是一套新增实现；本地契约和模拟 GitHub 边界的浏览器测试通过，不等于真实全平台构建、签名、公证、安装升级或生产发布验收完成。

## 启用前

1. 提交并推送相关工作流和脚本，并将入口工作流登记到 GitHub 默认分支。工作流执行分支和目标源码必须是同一 `main` / `release/*` 分支 HEAD，禁止使用本机未提交代码。
2. 版本准备继续使用普通代码提交：root/backend 的 package.json、两份 lockfile 顶层及 `packages[""]`、Android versionName 一致，并按既有规则递增 Android versionCode。触发器不修改版本、提交或推送 Tag。
3. 配置下面所选目标需要的变量和 Secrets。签名只在 Runner 使用；本机仅需 GitHub CLI 登录，发布中心只需服务端 GitHub Token。
4. 先运行不发布的真实构建和产物验收。正式写入前另行配置渠道 Environment、审批保护和发布开关。本轮实现没有配置远端开关、Secrets 或审批规则。

## 构建

```sh
# 示例要求远端提交已经准备好 1.5.4 版本
bash scripts/release.sh --branch release/v1.5.4 --version 1.5.4 --target pc,android,docker --wait

# 仅预览触发请求（会查询远端 HEAD，不执行构建）
bash scripts/release.sh --branch release/v1.5.4 --version 1.5.4 --target pc --dry-run
```

`--target` 接受 `pc`（三平台桌面）、`windows`（Full/Lite 成套）、`macos`（x64/arm64）、`linux`（x64）、`android`（APK/AAB）、`ios`（IPA）、`store`（AppX）、`docker`（amd64/arm64）、`fpk`、`upk`、`clipper`（Chrome/Edge/Firefox）和 `all`。`lite` 映射为 Windows Full/Lite，`linux-app` 映射为 Linux。

NAS 目标自动包含 Docker：FPK 引用本次版本镜像；UPK 从同次构建的两架构 Docker 归档打包，不拉取另一个版本的线上镜像。Docker 构建不登录、不推送镜像。扩展保留自己的 package.json 版本，应用版本和源码由外层清单绑定。

`--sha` 可额外校验远端 HEAD，`--notes` 提供可选发布说明。`--request-id` 可指定 UUID；程序输出请求后会先持久化意图，再派发一次。网络响应丢失后用同一 UUID 查询，不会重复派发。CLI 记录位于 `${NOWEN_RELEASE_DATA:-~/.nowen-release-center}/cli`。`--wait` 仅跟踪远端，关闭本机不会取消构建。

发布中心启动方式仍为 `npm ci && npm run build && npm start`，地址 `http://127.0.0.1:4318`。在“新建发布”检查远端版本、确认目标后开始构建，页面提供远端任务、Job/Step、脱敏日志、取消请求和产物链接。网页先保存派发意图，服务重启后通过请求 UUID 查询 GitHub，不会自动补发未知请求。GitHub 明确拒绝触发时任务失败并释放互斥；未知结果保持互斥，须先人工核查。旧本地调试与正式候选数据仍可读取。

## 配置

| 位置 | 配置 | 用途 |
| --- | --- | --- |
| 仓库变量 | `NOWEN_OFFICIAL_REGISTRY_TRUST_ROOTS_JSON` | 所有正式构建复用既有 Official Registry 信任根校验；缺失时在预检阻断 |
| 仓库 Secrets | `NOWEN_ANDROID_KEYSTORE_B64`、`NOWEN_ANDROID_KEYSTORE_PASSWORD`、`NOWEN_ANDROID_KEY_ALIAS`、可选 `NOWEN_ANDROID_KEY_PASSWORD` | Android 发布签名；缺少必填项则预检阻断，签名文件结束后清理 |
| 仓库 Secrets | `IOS_CERTIFICATE_BASE64`、`IOS_CERTIFICATE_PASSWORD`、`IOS_PROVISIONING_PROFILE_BASE64`、`IOS_KEYCHAIN_PASSWORD` | iOS 签名和导出；构建不会上传 TestFlight |
| 仓库变量 | `NOWEN_RELEASE_MAC_SIGNING=1` | 在统一构建中启用 macOS 签名/公证；未启用时仍可构建测试包，但不能正式分发 |
| 仓库 Secrets | `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` | 复用 electron-builder / afterSign；两架构检查 Developer ID 签名与 stapler 公证票据，证据绑定包摘要 |
| 仓库变量 | `FNPACK_URL`、`FNPACK_SHA256` | 官方 fnpack Linux amd64 可执行文件的 HTTPS 下载地址与固定 SHA-256；缺失则 FPK 预检失败 |
| 服务进程环境 | `NOWEN_RELEASE_GITHUB_TOKEN` | 固定仓库 Contents 读、Actions 写；不传给构建器或浏览器 |
| 服务进程环境 | `NOWEN_RELEASE_CLOUD_PUBLISH=1` | 开放网页的正式发布触发；默认关闭 |
| 仓库变量 | `NOWEN_RELEASE_CLOUD_PUBLISH=1` | 允许发布工作流通过预检；默认关闭，关闭时明确失败，不伪装发布成功 |
| `release-docker` Environment Secrets | `DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN` | Docker Hub 推送 |
| `release-testflight` Environment Secrets | `APPSTORE_ISSUER_ID`、`APPSTORE_API_KEY_ID`、`APPSTORE_API_PRIVATE_KEY` | 上传本次已构建的 IPA |
| `release-github` Environment | 配置所需审批和分支保护 | GitHub 发布 Job 使用最小权限 GITHUB_TOKEN；不使用本机发布 PAT |

Windows GitHub Direct Full/Lite 沿用现有不要求第三方签名的策略。Store AppX 仍为独立提交包，平台上架由 Partner Center 处理。

iOS Runner 固定为 `macos-26`，使用 Node 24.22.1，并在依赖安装前检查 Xcode 26+，匹配 [Capacitor 8 工具链要求](https://capacitorjs.com/docs/updating/8-0)。

## 产物与恢复

构建完成后生成 `release-manifest`，记录仓库、源码 SHA、版本、请求 UUID、Run/attempt、目标以及逐文件大小与 SHA-256；桌面包还复核更新元数据 SHA-512。macOS 正式分发额外要求签名、公证证据与同批文件摘要匹配。Runner 原生依赖检查沿用现有构建链。

产物保留 **7 天**。失败构建保留已经上传的成功目标供排查，但不会生成完整成功凭据。重建请使用新请求 UUID 完整构建，不使用 Actions 的 Re-run 混合不同 attempt 产物；入口预检与最终汇总均拒绝非第一次 attempt。

网页重复点击返回同一任务，旧调试任务和新远端任务共享本机互斥。远端任务状态以 GitHub 为准：取消仅请求停止未完成的 Job，已上传或已发布的外部内容不会自动撤销。

## 发布已有构建

完成真实验收并单独授权启用发布配置后，可在成功构建卡片选择渠道并输入版本确认，也可使用：

```sh
bash scripts/release.sh --branch release/v1.5.4 \
  --publish-run 123456789 --attempt 1 --version 1.5.4 \
  --channels github,docker --confirm 1.5.4 --wait
```

发布入口只接受本仓库 `release-build.yml` 成功运行的准确 attempt。每个写入 Job 在自己的 Environment 保护通过后重新下载、校验原构建清单和全部文件，直接使用原产物，不重新编译。

- **GitHub**：创建指向源码 SHA 的轻量 Tag，准备带构建来源标记的 Draft，逐个上传并核对远端 digest 后发布。已有同名 Tag、Release 或资产内容不符时停止；不接管外部 Release、不覆盖资产。丢失响应后可通过新发布请求对账，已确认成功的写入不会重复。GitHub 直接分发不混入 AppX、IPA 或 Docker tar。
- **Docker**：验证本次两个归档的镜像 ID，先推送架构镜像，再用固定 digest 汇总 `vX.Y.Z`。已有版本内容不同则拒绝覆盖。版本镜像验证后更新 `latest`，按版本比较防止旧版本回退覆盖；Docker 发布 Job 跨版本串行执行。构建阶段不会提前发布镜像。NAS 的 GitHub 分发要求同时选择 Docker 渠道，Docker 成功后才发布对应 NAS 包。
- **TestFlight**：只上传已验证的 IPA，不重新 Archive。上传响应丢失或 Apple 尚在处理时，先在 App Store Connect 核对版本/Build Number，再决定重试；不自动重传未知结果。
- **Store / NAS 商店 / 扩展商店**：本轮提供构建和产物，不新增平台自动上架 API。各平台审核、回执和真机验收仍需单独完成。

新版脚本不再接受本地构建、版本改写或 Tag 推送参数。历史入口完整保存在 `scripts/release-local.sh`（仍调用 `release-legacy.sh`，需要兼容其数组用法的 Bash），仅用于历史回归/明确选择的维护操作。发布中心的新流程不调用它。

## English scope

All builds run in GitHub Actions; the CLI and local console only dispatch and follow runs. The unified build covers desktop, signed Android/iOS packages, Store AppX, two Docker architectures, NAS packages and browser extensions. Sources and committed versions are pinned. A manifest binds every artifact to its SHA, request, run/attempt, file sizes and hashes. Unsigned macOS builds are test candidates; publishing requires matching Developer ID and notarization evidence.

Publishing is a separate, explicitly confirmed workflow and defaults off in both the console and repository configuration. Environment-gated jobs reverify and upload the same built artifacts. GitHub writes reconcile by ownership and asset digests; versioned Docker images cannot overwrite different content. TestFlight processing, store submissions and device acceptance remain separate. No real remote build, release, secret configuration or publication authorization was performed during this implementation.
