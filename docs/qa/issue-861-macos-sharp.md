# Issue #861：macOS Intel 启动失败

## 证据与修复

- 用户报告版本 1.5.2，截图原始错误为 `Could not load the "sharp" module using the darwin-x64 runtime`。后端退出后，Electron 才报 30000ms 启动超时。
- 发布工作流在宿主安装依赖后，仅切换 `better-sqlite3` 架构。`sharp` 的 optional dependencies 没有随目标切换；分享横幅的静态导入又把图片依赖故障放大成启动故障。已发布 DMG 尚未完成包内核查，不能把具体漏包情况视为已确认。
- `rebuild:native` 为 macOS 准备安装中 sharp 所声明的精确版本的 `@img/sharp-darwin-{arch}`、`@img/sharp-libvips-darwin-{arch}`。临时目录隔离安装，只复制这两个包，不改 package/lockfile、不重算后端依赖树、不覆盖 SQLite 或另一架构包。旧 npm 的架构限制只在临时安装中通过 `--force` 放开；不执行安装脚本。
- Full/Store 共用的 builder 在打包前与 `afterPack` 检查实际资源中的依赖版本、二进制存在性及 Mach-O CPU 类型。Lite 不带后端，不需要该检查。正式构建与 Release Center 调试构建加入对应回归。
- 横幅在完成输入验证后才加载 sharp。图片上传仍需成功解码和重编码；加载失败会拒绝该请求，不会接受未处理图片。

## 本地验证（2026-10-17）

- `node --test scripts/tests/macos-sharp.test.cjs scripts/tests/rebuild-native.test.cjs scripts/tests/update-builder-config.test.cjs scripts/tests/linux-desktop-packaging.test.cjs scripts/tests/microsoft-store-config.test.cjs`：27 项通过，覆盖双架构、缺失库、伪装架构、版本不符、下载失败、隔离安装、实际 app 资源门禁、缺失 sharp 时模块加载及原有打包配置。
- `npm run build:backend`：通过。
- `ELECTRON_RUN_AS_NODE=1 ../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --import tsx --import ./tests/setup-db-isolation.ts --test tests/settings-share-banner.test.ts`（backend 目录）：6 项通过，含真实图片裁切、权限、删除/关闭、透明背景、损坏/超限输入及保存原子性。普通 Node 首次运行因本机 SQLite 为 Electron ABI 130、Node 需要 ABI 137 而失败；随后使用匹配运行时完成回归，未重建或覆盖 SQLite。
- 真实依赖准备：在 ARM Mac 上调用 `prepareMacSharp(backendDir, "x64")`，成功隔离下载两个 x64 包，并验证版本与 Mach-O 架构；原有 ARM 包仍通过校验。`file` 确认 x64 `.node` 与 libvips `.dylib` 都是 x86_64。
- 完整产物启动 smoke：复制 backend/dist 到临时目录，链接依赖并将 sharp 替换成加载即抛错的夹具，以 Electron-as-Node 启动。仅使用临时数据库和数据目录；观察到 sharp 降级日志，`/api/health` 返回 200、`status: ok`。结束后关闭进程并删除临时数据。

## 尚未验收

尚未构建新的双架构 DMG，也未在 Intel 真机安装、启动及处理图片。未推送、未运行远程 CI、未发布修复版本，不能据此宣称用户问题已在发布版解决。后续需分别检查 x64/arm64 安装包的启动、横幅处理、缩略图和 HEIF 预览，并保留现有用户数据。
