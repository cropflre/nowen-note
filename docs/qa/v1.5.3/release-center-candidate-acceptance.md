# Release Center · P0 真实三平台候选构建验收

日期：2026-10-19。修复及验收 PR：[ #872 ](https://github.com/cropflre/nowen-note/pull/872)，目标分支 `release/v1.5.3`。

## 结论与固定来源

**通过本轮真实候选构建、来源与摘要核对、包内容静态验收。** 不代表安装启动、签名、公证或生产正式发布通过。

- 应用源码 SHA：`6283de3791a4e02975a37b6c72b1f63c35d7a7e1`，版本 `1.5.3`。
- 请求 UUID：`ea064266-0713-4795-8489-1c2811ad8810`。
- [Candidate Run #39188437154](https://github.com/cropflre/nowen-note/actions/runs/39188437154)，attempt **1**，5 个 Job 全部 `success`。
- 控制工作流来自 `main`，SHA 为 `ab2e2941b9c922e86a7c2a1a873f5400f787761d`；Actions `head_sha` 指向控制工作流，不能替代候选应用源码 SHA。实际 checkout 与各平台独立证据均绑定上述应用源码。
- 6 个 artifacts、20 个文件全部下载核对。构建包和独立证据分别保存；Actions 保留期 7 天，准确到期时间见证据清单。
- 此验收文档及证据在构建完成后追加，不改变本次已验收的应用源码 SHA。

## 实际产物复核

| 平台 | 文件数 | 实际检查与结果 |
| --- | ---: | --- |
| Windows x64 Full / Lite | 8 | setup、portable、blockmap、独立 latest / latest-lite 元数据；archive SHA-256、逐文件 SHA-256 / 大小、更新 SHA-512 全部一致。解析两个 setup 内的应用及 package.json：版本均为 1.5.3；Full 的 Electron、SQLite、sharp、libvips、FFmpeg 均为 x64；SQLite ABI 为 130；Lite 的 nowenLiteOnly=true，且没有 backend 资源 |
| macOS Intel / Apple Silicon | 9 | 两架构 DMG / ZIP、4 个 blockmap、latest-mac.yml；全部摘要与来源一致。ZIP 内 Electron、SQLite、sharp、libvips、FFmpeg 均匹配目标架构，SQLite ABI 为 130；两个 DMG 均通过 hdiutil verify，并只读挂载核对上述二进制摘要与对应 ZIP 完全相同，随后卸载 |
| Linux x64 | 3 | AppImage / deb / latest-linux.yml 的全部摘要与来源一致。deb 内后端版本为 1.5.3，SQLite、sharp、libvips 为 ELF64 x64，SQLite ABI 为 130；确认 SQLite 主路径硬链接指向已检查的真实二进制。CI 完成桌面元数据、8 种尺寸图标及原生兼容性检查 |

每个 archive 均对照 GitHub API 的 `digest` 及 `size_in_bytes`，随后重新调用 `verifyFormalDirectory` 检查安装包集合、更新元数据与逐文件摘要，并与单独下载的 `candidate-evidence.json` 比较。来源核对包含 repository、SHA、version、requestId、runId、runAttempt 和 platform。证据中的 `purpose=candidate-build-only`，`releaseEligible`、`signed`、`approved` 均为 false。

完整记录：

- [运行、Job、artifact digest 及到期时间](release-center-candidate-20261019-evidence/manifest.json)
- [Windows 独立证据及复核](release-center-candidate-20261019-evidence/windows.json)
- [macOS 独立证据、原生架构及 DMG 比对](release-center-candidate-20261019-evidence/macos.json)
- [Linux 独立证据及原生包复核](release-center-candidate-20261019-evidence/linux.json)

未执行 Windows / Linux 安装启动，未启动 macOS 应用，未单独解包 portable 或 AppImage 的内部应用；这些文件已完成来源、完整性和更新元数据检查，应用内容复核使用同平台的 setup / deb。DMG 检查为只读挂载，未执行安装或应用启动。

## 本轮修复与回归

1. Android versionName 原为 1.5.2，与 root/backend 1.5.3 不一致，Candidate contracts 会直接拒绝。同步为 1.5.3，并按现有规则将 versionCode 从 10508 递增到 10509；版本一致性测试增加 Android 断言，修复前已复现失败。
2. Windows/macOS 连续两次 npm ci 遇到 ECONNRESET。将 root/backend/frontend 锁文件中的 616 个镜像 tarball URL 规范为官方 registry；逐字段比较确认版本、integrity、依赖图及其他字段未变化，并增加锁文件来源回归。新提交的三平台 npm ci 均通过。
3. sharp 打包夹具只有伪造的原生头，没有 JS 入口，宿主架构真实加载检查会失败。补全明确标注为 fixture 的入口，并新增加载失败拒绝用例；没有关闭生产检查。
4. [旧 Run #39187727685](https://github.com/cropflre/nowen-note/actions/runs/39187727685) 虽然全部成功，实际 Intel ZIP 中的 FFmpeg 却为 arm64，故拒绝将该候选计为验收通过。现在复用锁定的 ffmpeg-static 安装器，在隔离目录下载目标架构文件，通过 Mach-O 检查后再替换，失败保留原文件；打包前与实际 app Resources 打包后均检查 FFmpeg 架构。新门禁已确认拒绝旧包中的实际错误文件，新候选两种架构均正确。参见[旧候选拒绝证据](release-center-candidate-20261019-evidence/rejected-prior-candidate.json)。

回归结果：

- 发布契约：本地与 Candidate contracts **62/62**。
- Microsoft Store 隔离契约：本地与 Candidate contracts **13/13**。
- macOS / native 构建契约：本地与 macOS Job **14/14**，覆盖双架构切换、失败保留、夹具加载失败和 afterPack 拒绝错误架构。
- Linux 桌面契约：CI **10/10**；实际 deb 桌面元数据及图标检查通过。
- 本地 root `npm ci --ignore-scripts --no-audit --no-fund` 成功；未重建原工作区的原生依赖。

## 通用 CI 与剩余验收

候选构建成功不等于仓库全部 CI 通过。源码提交仍有以下未解决门禁：

- [Repository CI frontend](https://github.com/cropflre/nowen-note/actions/runs/39188431646)：lint 相对既有基线报告 19 条错误，涉及本次未修改的前端源码与测试文件。
- [Appearance release gate](https://github.com/cropflre/nowen-note/actions/runs/39188431784)：MarkdownPreview.interactions.test.tsx 的 react-i18next mock 缺少 initReactI18next。本次未修改相关前端源码、测试或 lint 文件；锁文件只改下载地址，未改依赖版本。

本 PR 不涉及业务数据写入、同步、迁移、删除或账号切换，DCC 行为验收不适用。原工作区的 packages/nowen-mcp/package-lock.json 修改保持不变。

仍未完成：

- 在隔离 GitHub 测试仓库进行真实 Draft、资产上传、审批、Publish、断网对账与恢复演练。
- 建立已验收候选进入正式审批链的来源、签名及晋升门禁。
- Windows / macOS / Linux 的真实安装、启动、升级、恢复，以及 macOS 签名、公证和 Windows 签名验收。
- Microsoft Store、Docker Hub、NAS 的实际分发、回执及失败恢复。
- 合并本 PR，以及解决上述通用 CI 门禁。

本轮未创建版本 Tag、Draft 或 Release，未上传 Store / Docker / NAS，未启用正式发布写开关。候选仍不具备生产发布资格。
