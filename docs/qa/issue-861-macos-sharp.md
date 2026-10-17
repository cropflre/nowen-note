# Issue #861：macOS Intel 启动失败

## 证据与修复

- 用户报告版本 1.5.2，截图原始错误为 `Could not load the "sharp" module using the darwin-x64 runtime`。后端退出后，Electron 才报 30000ms 启动超时。
- 发布工作流在宿主安装依赖后，仅切换 `better-sqlite3` 架构。`sharp` 的 optional dependencies 没有随目标切换；分享横幅的静态导入又把图片依赖故障放大成启动故障。已发布 DMG 尚未完成包内核查，不能把具体漏包情况视为已确认。
- `rebuild:native` 为 macOS 准备安装中 sharp 所声明的精确版本的 `@img/sharp-darwin-{arch}`、`@img/sharp-libvips-darwin-{arch}`。临时目录隔离安装，只复制这两个包，不改 package/lockfile、不重算后端依赖树、不覆盖 SQLite 或另一架构包。旧 npm 的架构限制只在临时安装中通过 `--force` 放开；不执行安装脚本。
- Full/Store 共用的 builder 在打包前与 `afterPack` 检查实际资源中的依赖版本、二进制存在性及 Mach-O CPU 类型。Lite 不带后端，不需要该检查。开发提交为正式构建与 Release Center 调试构建加入对应回归；1.5.2 热修复分支因 OAuth 缺少 workflow scope，保留原有工作流，通过既有入口构建，原生库门禁仍在 builder 中执行。
- 横幅在完成输入验证后才加载 sharp。图片上传仍需成功解码和重编码；加载失败会拒绝该请求，不会接受未处理图片。

## 本地验证（2026-10-17）

- `node --test scripts/tests/macos-sharp.test.cjs scripts/tests/rebuild-native.test.cjs scripts/tests/update-builder-config.test.cjs scripts/tests/linux-desktop-packaging.test.cjs scripts/tests/microsoft-store-config.test.cjs`：27 项通过，覆盖双架构、缺失库、伪装架构、版本不符、下载失败、隔离安装、实际 app 资源门禁、缺失 sharp 时模块加载及原有打包配置。
- `npm run build:backend`：通过。
- `ELECTRON_RUN_AS_NODE=1 ../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --import tsx --import ./tests/setup-db-isolation.ts --test tests/settings-share-banner.test.ts`（backend 目录）：6 项通过，含真实图片裁切、权限、删除/关闭、透明背景、损坏/超限输入及保存原子性。普通 Node 首次运行因本机 SQLite 为 Electron ABI 130、Node 需要 ABI 137 而失败；随后使用匹配运行时完成回归，未重建或覆盖 SQLite。
- 真实依赖准备：在 ARM Mac 上调用 `prepareMacSharp(backendDir, "x64")`，成功隔离下载两个 x64 包，并验证版本与 Mach-O 架构；原有 ARM 包仍通过校验。`file` 确认 x64 `.node` 与 libvips `.dylib` 都是 x86_64。
- 完整产物启动 smoke：复制 backend/dist 到临时目录，链接依赖并将 sharp 替换成加载即抛错的夹具，以 Electron-as-Node 启动。仅使用临时数据库和数据目录；观察到 sharp 降级日志，`/api/health` 返回 200、`status: ok`。结束后关闭进程并删除临时数据。

## GitHub 构建与 1.5.2 资产替换（2026-10-17）

- 热修复源码从原始 `v1.5.2`（`c6f4778c95775bb233209879d01dd0d5b3173fac`）仅带入 #861 修复，提交 `e6b7afa221222ef6c33fb65d20ac631403213437`，已推送 `codex/issue-861-macos-1.5.2`。原始标签保持不变。开发分支的完整本地提交为 `ae71c5db`，包含新增 CI 测试步骤；工作流变更未推送。
- [GitHub Actions run 38993996075](https://github.com/cropflre/nowen-note/actions/runs/38993996075)：契约检查与 macOS 双架构构建均成功。源码信任根与仓库发布变量一致；仓库无 macOS 签名凭据，继续采用未签名分发。
- Actions artifact `12086034774`，整包 SHA-256：`5ee7c297b894121fdb660d6f5e9d1632e706b15ce7be4bf5aa6b816bc2211efb`。下载后验证整包摘要、9 个文件各自的摘要，以及 `latest-mac.yml` 引用文件的 SHA-512/大小。
- 分别从两份 ZIP 解压应用，使用包内 Electron 33.0.0：SQLite 内存库查询成功，sharp 生成 PNG 并重新读取尺寸成功；完整后端以隔离的临时数据目录启动，`/api/health` 返回 200、`status: ok`、`version: 1.5.2`。x64 经 Rosetta 运行，arm64 原生运行。
- 分别只读挂载 DMG，比对 DMG 与 ZIP 中的后端 bundle、对应架构 sharp `.node` 与 libvips `.dylib`，SHA-256 均一致。
- 已替换 [v1.5.2 Release](https://github.com/cropflre/nowen-note/releases/tag/v1.5.2) 的 x64/arm64 DMG、ZIP、四份 blockmap 与 `latest-mac.yml`，共 9 个文件。新文件先暂存上传、核对服务端 SHA-256/大小后切换同名下载，最后清理旧文件。替换后远端摘要全部匹配，更新元数据下载内容与本地一致；其余 13 个资产的 ID 与摘要未变，资产总数仍为 22，无临时资产残留。发布说明已记录修复源码与构建链接。

## 尚未验收

未进行 Intel 真机及完整桌面 GUI 安装验收；Rosetta 包内启动测试不能替代真实硬件验收。缩略图、HEIF 预览和用户已有数据升级路径尚未做本轮实机复测。未修改用户数据。受影响用户需重新下载安装同版本的修复包。
