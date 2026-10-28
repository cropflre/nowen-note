# GitHub 内汇总桌面产物与发布校验

macOS 包一直由 GitHub Actions 构建。新的发布流程把桌面 CI 产物的汇总上传、完整远端更新校验也放到 GitHub，避免大文件经过维护者的 WSL 下载、上传、再下载。

## 直接使用 GitHub 打桌面包

直接运行 `bash scripts/release.sh`，选择第五项“一键全量发布”，桌面包默认交由 GitHub Actions 构建、上传和校验，无需额外参数。Windows Full/Lite、macOS 双架构和 Linux x64 都会收集；Android、Docker、FPK 和 Clipper 沿用原流程。

`--desktop-build github` 跳过本地 PC/Lite 工具链检查、编译、输出目录清理和安装包上传，复用推送本次 Tag 时触发的 `release.yml` 构建。其他入口默认仍为 `--desktop-build local`。第五项如需本地打包，可运行 `bash scripts/release.sh --desktop-build local` 后选择 5。

```sh
# 交互填写新版本号；Windows Full/Lite、macOS 双架构、Linux x64 全部交给 Actions
bash scripts/release.sh --target pc,lite --desktop-build github --draft

# 只收集 Linux x64 AppImage + deb + latest-linux.yml
bash scripts/release.sh --target linux-app --desktop-build github --draft

# 只收集 Windows（现有 CI 产物固定包含 Full/Lite 两套）
bash scripts/release.sh --target pc --pc-platform win --desktop-build github --draft
```

GitHub 模式的 `pc` 默认选择 `win,mac,linux`，也可用 `--pc-platform` 缩小收集范围；Tag workflow 仍构建整个 matrix。现有完整性校验要求同时提供 Windows 和 Linux 时也包含 macOS，因此 `win,linux` 组合会提前报错，需改为 `win,mac,linux`。macOS 固定 x64/arm64，Linux 仅 x64；需要 Linux arm64 或自定义 macOS 架构时使用本地模式。`lite` 对应现有 Windows Full/Lite 成套 CI 产物，不提供 macOS/Linux Lite。

没有本地安装包时也会先创建空 Draft，随后在 GitHub 内汇总产物。本地只轮询任务、读取资产清单和小型回执。指定 `--draft` 保留草稿，省略时沿用校验通过后转正式的行为；CI 失败或回执不符会阻止转正式，不替换已发布版本的桌面资产。

Android、Docker、FPK/UPK 和 Clipper 仍走原有本地流程；与 Docker 组合时，原有 `--atomic` 不涵盖之后异步执行的 GitHub 构建，CI 失败也不会回滚已推送的 Docker 镜像。此选项需要 GitHub Release，不能搭配 `--no-github-release` 或 `--build-only`。

## 流程与职责

1. 维护者继续运行 `bash scripts/release.sh`，原有 target、版本、Docker/NAS/Android 和 `--draft` 选项不变。脚本上传需要的本地产物并创建 Draft；GitHub 桌面构建模式支持没有本地产物的空 Draft。
2. Tag push 的 `release.yml` matrix 构建 Windows Full/Lite、macOS x64/arm64 和 Linux。默认手动 `debug` 模式仍不上传 Release。
3. 本地脚本在同一 Tag 上 dispatch `release-assets` 模式，绑定 Tag Commit、源构建 Run ID 和随机请求 UUID；此模式不重新构建。汇总任务只有 `contents: write` 和 `actions: read`，构建任务保持只读权限。
4. GitHub Runner 核对源构建的仓库、Tag、Commit、工作流及对应平台 Job 成功状态，按选择下载 `nowen-note-mac`、`nowen-note-win-direct` 和 `nowen-note-linux`。复用现有元数据/SHA-512/大小/blockmap 校验，只上传本版本允许的文件名，并检查每个上传文件的 GitHub SHA-256 与大小。只允许替换 Draft 中的桌面候选资产。
5. Runner 运行现有 `verify-release-update-assets.mjs remote`，大文件校验在 GitHub 网络内完成。成功后生成小型 Actions artifact 回执，绑定请求、Tag/SHA、两个 Run ID、重试次数与完整 Release 资产清单。
6. 本地每 30 秒显示汇总任务状态及 Actions 链接。仅下载小于 1 MiB 的回执，检查任务成功、来源与资产 ID/名称/大小/digest/更新时间仍一致；通过后才将 Draft 转为正式。`--draft` 保留 Draft，不打印正式“发布成功”。

macOS 先汇总；即使 Windows Job 失败，已成功的 Mac 资产可以保留在 Draft，但完整校验失败时仍不能正式发布。补充 NAS 等资产到已发布版本时，只进行远端复核，不重传或替换其桌面资产。

## 启用与故障处理

- 需要先将本次脚本和 `release.yml` 一起纳入后续版本的 Tag，并同步默认分支的 workflow dispatch 定义。本地 GitHub 登录需要目标仓库的 Actions 写权限以 dispatch；CI 使用短期 `GITHUB_TOKEN`，不新增长期 Token。
- 这不会改造已存在的旧 Tag，也不会改变已经运行的发布进程。旧版 Tag 中没有 `release-assets` 模式，不能仅更新本地脚本就对旧版自动使用新流程。
- 本地等待上限继续使用 `NOWEN_RELEASE_CI_ARTIFACT_TIMEOUT_SECONDS`，默认 10800 秒。失败或超时不转正式；网络断开不会取消已经派发的 GitHub 汇总任务。
- 汇总/远端校验失败时，可以在 Actions 中只重试汇总任务，或执行 `gh run rerun <汇总Run-ID> --failed`，不需要重新编译 macOS。若本地进程已退出，重试成功只生成新回执，不会自动正式发布；仍需核对新回执和当前资产后再完成发布。
- 只改网络位置，不改变签名、公证或设备验收状态；Release Center Phase 2B 的独立凭据、审批门禁和默认关闭的写开关保持原有边界。

## 本地验证

```sh
npm run test:update-release
node --test scripts/tests/windows-direct-release.test.cjs
bash -n scripts/release.sh
bash -n scripts/release-legacy.sh
```

回归使用隔离的 GitHub/产物夹具，覆盖错误来源、损坏元数据、失败 Job、上传摘要不符、验证期间资产变化、过期回执、`--draft` 和发布顺序。真实 GitHub dispatch、上传及正式发布需在代码推送后另行验证，不以本地测试替代。

## English

Run `bash scripts/release.sh` and choose menu option 5 to use GitHub desktop packaging automatically. An explicit `--desktop-build local` overrides this default. Other entry points retain local builds by default.

Use `--desktop-build github` to skip local PC/Lite builds, toolchain checks, output cleanup and installer uploads. Local builds remain the default. In GitHub mode, `pc` collects Windows Full/Lite, both macOS architectures and Linux x64 by default; `--pc-platform` narrows collection and `linux-app` selects Linux only. Windows plus Linux requires macOS as well under the existing completeness check. The tag workflow still builds its full matrix. The script can create an empty Draft before collecting CI artifacts. Linux arm64 and custom macOS architectures require local mode. Android, Docker, NAS and Clipper retain their local paths; the existing atomic option does not roll back Docker pushes if a later asynchronous GitHub build fails. Include these scripts and the workflow in a future tag and register the dispatch inputs on the default branch before use.

macOS was already built by GitHub Actions. The release guard now dispatches a separate `release-assets` mode in the same tag's workflow. GitHub downloads the existing same-commit desktop artifacts, validates them, uploads only to Draft, checks uploaded SHA-256 values and runs the existing full remote updater verifier. The local publisher only polls progress and downloads a small request/run/attempt-bound receipt, then compares the current asset inventory before publishing. Debug builds retain read-only permissions, and `--draft` never publishes. Successful Mac assets remain in Draft if Windows fails. Published supplemental releases are verified without replacing their desktop assets. The change must be included in a future tag and registered on the default branch; existing tags and running releases are unchanged. Local fixture tests do not establish live Actions or release success.

GitHub references: [workflow dispatch and tag refs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch), [workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).
