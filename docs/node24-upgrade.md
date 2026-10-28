# Node 24 升级说明

项目开发、源码部署、CLI / MCP、移动端构建和 GitHub Actions 统一使用 **Node.js 24.22.1 或更新的 24.x LTS 版本**。`.nvmrc` 和 CI 固定为 24.22.1；各包的 `engines.node` 为 `>=24.22.1 <25`。

该版本包含 [2026 年 10 月 Node.js 安全更新](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)。桌面端使用 **Electron 43.8.4**，其[内置 Node 为 24.22.1](https://releases.electronjs.org/release/v43.8.4)。仅更新开发电脑的 Node 不会替换已有桌面安装包的运行时。

## 用户需要做什么

| 使用方式 | 更新方式与影响 |
| --- | --- |
| 浏览器 | 无需安装 Node；服务端更新重启期间可能短暂断开连接。 |
| Docker / NAS | 新版本镜像发布后，按现有流程更新镜像并重建容器；保留原数据卷、端口和环境配置。宿主机无需安装 Node。 |
| Windows / macOS / Linux 桌面版 | 安装新版客户端，无需单独安装 Node。新版 macOS 安装包要求 macOS 12 或更高版本。 |
| Android / iOS | 用户设备无需安装 Node；Node 的变化发生在构建工具链和服务端。 |
| 源码部署、CLI / MCP | 升级 Node，重新安装依赖并重启进程 / MCP 客户端；配置中硬编码旧 Node 绝对路径的用户需要同步调整路径。 |

Electron 43 保留 macOS 12 支持，但[不再支持 macOS 11](https://www.electronjs.org/docs/latest/breaking-changes#removed-macos-11-support)。Full / Lite 安装包都声明最低 macOS 12；更新元数据使用 Darwin `21.0.0`，避免向 macOS 11 提供无法运行的更新。macOS 11 用户需要升级系统后再更新桌面版。

源码开发或独立运行 CLI / MCP 的 macOS 用户还需注意：官方 Node 24 二进制要求 **macOS 13.5 或更高版本**，与 Electron 桌面安装包的系统要求不同，见 [Node 24 平台要求](https://github.com/nodejs/node/blob/v24.22.1/BUILDING.md#platform-list)。

本次没有修改笔记、附件或同步的数据结构，也不要求用户清空数据。SQLite 驱动升级为 better-sqlite3 12.11.1，需要随目标运行时重建原生模块；不能把旧 `node_modules` 直接复制给新运行时。macOS 双架构构建会分别编译 SQLite，并准备和校验对应架构的向量扩展、图片和 FFmpeg 运行依赖。

## 源码与开发环境

在仓库根目录切换版本：

```bash
nvm install
nvm use
node --version
```

仅部署 Web 服务时，使用普通 Node 安装与构建依赖：

```bash
npm --prefix backend ci
npm --prefix frontend ci
npm run build:all
npm --prefix backend start
```

桌面开发 / 打包时：

```bash
npm ci
npm run install:all
npm run electron:build
```

Linux 桌面构建建议先设置 `NOWEN_LINUX_PORTABLE=1` 再执行上述安装 / 打包命令，以使用项目的 Docker 编译环境；Linux CI 默认启用该路径。

普通 Node 和 Electron 的原生模块 ABI 不同。切换为普通 Node 后端时，在 `backend/` 执行 `npm run rebuild:node`；切回桌面开发时，在根目录执行 `npm run rebuild:native`。不要通过删除笔记数据库解决 ABI 错误。

## Docker 与发布

生产镜像的各构建阶段统一使用 `node:24.22.1-alpine3.23`，继续提供 amd64 / arm64 构建入口。持久化位置仍为 `/app/data`。升级前按现有备份流程保存数据库和附件，更新时保留原挂载；本次不改变数据卷布局。

Linux 桌面原生模块仍执行 glibc 2.31 / GLIBCXX 3.4.28 兼容检查。编译环境使用 GCC 12，并静态链接 C++ 运行库；构建结果必须通过检查后才能打包。Android 的本地 Docker 构建也使用固定 Node 24 镜像；自定义 Android 镜像需自行提供相同的 Node 基线。

桌面 Node 下载器会校验官方 SHA-256，并按目标版本刷新缓存，避免已有的旧 Node 文件被直接复用。实际对外升级仍需重新构建并发布各平台产物；源码版本修改不等于旧安装包或已有容器已经更新。

本次本地验证与尚未覆盖的平台见 [验收记录](./qa/node24-upgrade-2026-10-28.md)。
