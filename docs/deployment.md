# 部署指南

本文档汇总 nowen-note 各种环境下的安装与部署方式，包括本地开发、Docker、桌面端 / 移动端、以及主流 NAS 平台。

> 默认管理员账号：`admin` / `admin123`，首次登录后请立即修改密码。

## 目录

- [方式一：Windows 本地安装（开发 / 体验）](#方式一windows-本地安装开发--体验)
- [方式二：Docker 通用安装（推荐）](#方式二docker-通用安装推荐)
- [方式三：Electron 桌面客户端](#方式三electron-桌面客户端)
- [方式四：Android 移动端（Capacitor）](#方式四android-移动端capacitor)
- [方式五：群晖 Synology NAS](#方式五群晖-synology-nas-安装)
- [方式六：绿联 UGOS NAS](#方式六绿联-ugos-nas-安装)
- [方式七：飞牛 fnOS](#方式七飞牛-fnos-安装)
- [方式八：威联通 QNAP](#方式八威联通-qnap-安装)
- [方式九：极空间 NAS](#方式九极空间-nas-安装)
- [方式十：ARM64 开发板 / 国产 SoC](#方式十arm64-开发板--国产-soca311d--rk3566--oes--oect)
- [通用注意事项](#通用注意事项)

---

## 方式一：Windows 本地安装（开发 / 体验）

**环境要求：** Node.js 20+、Git

```bash
# 1. 克隆项目
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note

# 2. 安装所有依赖
npm run install:all

# 3. 启动后端（端口 3001）
npm run dev:backend

# 4. 新开一个终端，启动前端（端口 5173，自动代理 /api → 3001）
npm run dev:frontend
```

浏览器访问 `http://localhost:5173` 即可使用。

数据库文件位于 `backend/data/nowen-note.db`，备份此文件即可迁移数据。

---

## 方式二：Docker 通用安装（推荐）

适用于任何安装了 Docker 的 Linux / macOS / Windows 设备。

### 方法 A：docker-compose（推荐）

```bash
# 1. 克隆项目
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note

# 2. 一键构建并启动
docker-compose up -d
```

### 方法 B：纯 docker 命令（仅主应用）

```bash
# 1. 克隆并构建镜像
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
docker build -t nowen-note .

# 2. 创建数据目录并运行
mkdir -p /opt/nowen-note/data
docker run -d \
  --name nowen-note \
  --restart unless-stopped \
  -p 3001:3001 \
  -v /opt/nowen-note/data:/app/data \
  -e DB_PATH=/app/data/nowen-note.db \
  nowen-note
```

浏览器访问 `http://<你的IP>:3001` 即可使用。

**服务端口：**

| 端口 | 服务 | 说明 |
|------|------|------|
| `3001` | nowen-note | 主应用（前后端一体 + SQLite） |

**环境变量说明：**

| 变量名 | 默认值 | 说明 |
| ------ | ------ | ---- |
| `PORT` | `3001` | 服务监听端口 |
| `DB_PATH` | `/app/data/nowen-note.db` | 数据库文件路径 |
| `NODE_ENV` | `production` | 运行环境 |
| `OLLAMA_URL` | （未设置） | Ollama 服务地址（如需本地 AI 请自行部署 Ollama） |

---

## 方式三：Electron 桌面客户端

支持 Windows（NSIS 安装程序）、macOS（DMG）、Linux（AppImage）。

```bash
# 开发运行
npm run electron:dev

# 打包发布
npm run electron:build
```

打包产物输出到 `release/` 目录。桌面端自动 fork 后端进程，数据库存储在用户目录 `nowen-data/` 下。

---

## 方式四：Android 移动端（Capacitor）

基于 Capacitor 8 构建 Android 原生应用，连接远程服务器使用。

### 方法 A：使用预编译 APK（推荐）

直接从 [GitHub Releases](https://github.com/cropflre/nowen-note/releases) 下载最新的 APK 安装包，传输到手机安装即可。

### 方法 B：自行编译

```bash
# 1. 构建前端
npm run build:frontend

# 2. 同步到 Android 项目
npx cap sync android

# 3. 用 Android Studio 打开并构建
npx cap open android

# 或直接命令行打包 Release APK（需配置签名）
cd frontend/android
./gradlew assembleRelease
```

**签名配置：** 如需构建 Release 版本，请在 `frontend/android/` 目录下创建 `keystore.properties` 文件：

```properties
storePassword=你的密码
keyPassword=你的密码
keyAlias=你的别名
storeFile=你的keystore路径
```

移动端首次启动需配置服务器地址（IP:端口 或域名），通过 HTTP 连接到已部署的 nowen-note 后端。

**Android 图标：** 移动端 App 图标与桌面端 Electron 图标保持一致，统一由 `electron/icon.png` 生成；如需重新同步，运行 `npm run build:mobile-icons`。支持 Android 自适应图标（Adaptive Icon）。

---

## 方式五：群晖 Synology NAS 安装

**前提：** 已安装 Container Manager（DSM 7.2+）或 Docker 套件（DSM 7.0 / 7.1）。

**步骤：**

1. **上传镜像**
   - 在电脑上执行 `docker build -t nowen-note .` 构建镜像
   - 导出镜像：`docker save nowen-note -o nowen-note.tar`
   - 在群晖 Container Manager → 映像 → 导入 → 上传 `nowen-note.tar`

2. **创建容器**
   - 映像列表中选择 `nowen-note` → 启动
   - **端口设置**：本地端口 `3001` → 容器端口 `3001`
   - **存储空间**：新增文件夹映射
     - 本地路径：`/docker/nowen-note/data`
     - 容器路径：`/app/data`
   - **环境变量**（默认即可，无需修改）

3. **访问使用**
   - 浏览器访问 `http://<群晖IP>:3001`

> **提示：** 数据备份只需复制 `/docker/nowen-note/data/nowen-note.db` 文件。可使用群晖 Hyper Backup 定期备份该目录。也可通过 API `/api/backups` 进行在线备份管理。

---

## 方式六：绿联 UGOS NAS 安装

**前提：** 已开启 Docker 功能（绿联 UGOS Pro / UGOS）。

**步骤：**

1. **导入镜像**
   - 在电脑上构建并导出镜像（同群晖步骤）
   - 绿联 NAS → Docker → 镜像管理 → 本地导入 `nowen-note.tar`

2. **创建容器**
   - 选择 `nowen-note` 镜像 → 创建容器
   - **网络**：选择 bridge 模式
   - **端口映射**：主机 `3001` → 容器 `3001`
   - **存储映射**：
     - 主机路径：`/mnt/user/appdata/nowen-note/data`（或自定义路径，如绿联默认的 `共享文件夹/docker/nowen-note/data`）
     - 容器路径：**必须填 `/app/data`**（⚠️ 不是 `/data`，否则程序不会往挂载目录写入任何数据）
       > 💡 从近期版本起，镜像在 Dockerfile 中显式声明了 `VOLUME ["/app/data"]`，绿联面板的「容器目录」下拉框会**自动预填 `/app/data`**，无需手填。如果你用的是旧镜像看不到这个预填，请重新构建/拉取镜像即可。
   - **重启策略**：开机自启

3. **访问使用**
   - 浏览器访问 `http://<绿联NAS IP>:3001`

> **⚠️ 常见踩坑：容器目录填错导致 NAS 目录看不到任何文件**
>
> 绿联 Docker 面板的"存储空间"配置中，**容器目录必须填 `/app/data`**（与 Dockerfile 中的 `WORKDIR /app` + `mkdir -p /app/data` 一致）。如果填成 `/data`，程序会把数据库、JWT 密钥写到容器内部的 `/app/data`（该路径没有挂载出去，容器删掉就没了），导致 NAS 侧挂载目录"空空如也"——这**不是权限问题**，是路径问题。
>
> **验证方法**：容器启动几秒后进入绿联 Docker → 容器 → 终端，执行 `ls -la /app/data`，应能看到 `.jwt_secret`、`nowen-note.db`、`nowen-note.db-shm`、`nowen-note.db-wal` 四个文件；同时 NAS 文件管理器里挂载目录也应看到同样的文件。
>
> **备选方案**：如果你因特殊原因必须把容器目录保留为 `/data`，请额外在"环境变量"里配置 `NOWEN_DATA_DIR=/data` 和 `DB_PATH=/data/nowen-note.db`，两者缺一不可。

---

## 方式七：飞牛 fnOS 安装

飞牛 fnOS 有两种安装方式，**强烈推荐方式 A（.fpk 一键安装）**。

### A. .fpk 一键安装（推荐）

**步骤：**

1. **下载 .fpk**
   - 从 [GitHub Releases](https://github.com/cropflre/nowen-note/releases) 下载最新的 `nowen-note-<version>.fpk`

2. **手动安装**
   - 把 `.fpk` 文件上传到飞牛 NAS 任意目录
   - 飞牛桌面 → 「**应用中心**」 → 右上角「**设置**」 → 「**手动安装应用**」
   - 选中刚才上传的 `.fpk` 文件，确认安装

3. **使用**
   - 桌面出现「弄文笔记」图标，点击在浏览器中打开
   - 数据卷由飞牛自动管理在 `${TRIM_PKGVAR}/data`，升级覆盖安装不会丢数据

> 限制：当前仅支持 **x86_64** 飞牛设备。
> 自行打包：参见 [scripts/fpk/README.md](../scripts/fpk/README.md)。

### B. Docker 手动部署（兼容 ARM 设备）

**前提：** 飞牛 fnOS 已开启 Docker 功能。

**步骤：**

1. **导入镜像**
   - 在电脑上构建并导出镜像（同群晖步骤）
   - 飞牛 fnOS → Docker → 镜像 → 导入 `nowen-note.tar`

2. **创建容器**
   - 选择 `nowen-note` 镜像 → 创建容器
   - **端口映射**：主机 `3001` → 容器 `3001`
   - **卷映射**：
     - 主机路径：`/vol1/docker/nowen-note/data`（根据实际存储卷调整）
     - 容器路径：`/app/data`
   - **重启策略**：除非手动停止

3. **访问使用**
   - 浏览器访问 `http://<飞牛NAS IP>:3001`

---

## 方式八：威联通 QNAP 安装

**前提：** 已安装 Container Station（QTS 5.0+ / QuTS hero）。

**步骤：**

1. **导入镜像**
   - 在电脑上构建并导出镜像（同群晖步骤）
   - Container Station → 映像档 → 导入 → 选择 `nowen-note.tar`

2. **创建容器**
   - 选择 `nowen-note` 映像 → 创建
   - **网络设置**：NAT 模式，端口映射 `3001` → `3001`
   - **共享文件夹**：
     - 主机路径：`/share/Container/nowen-note/data`
     - 容器路径：`/app/data`
   - **其他**：勾选"自动重新启动"

3. **访问使用**
   - 浏览器访问 `http://<威联通IP>:3001`

> **提示：** QNAP 也支持 docker-compose，在 Container Station → 创建 → 使用 YAML 创建，粘贴本项目的 `docker-compose.yml` 内容即可。

---

## 方式九：极空间 NAS 安装

**前提：** 极空间 ZOS 已开启 Docker 功能（极空间 Z4S / Z4 Pro / Z2 Pro 等）。

**步骤：**

1. **导入镜像**
   - 在电脑上构建并导出镜像（同群晖步骤）
   - 极空间 → Docker → 镜像 → 本地镜像 → 导入 `nowen-note.tar`

2. **创建容器**
   - 选择 `nowen-note` 镜像 → 创建容器
   - **端口映射**：本地 `3001` → 容器 `3001`
   - **路径映射**：
     - 本地路径：选择一个文件夹（如 `极空间/docker/nowen-note/data`）
     - 容器路径：`/app/data`
   - **重启策略**：自动重启

3. **访问使用**
   - 浏览器访问 `http://<极空间IP>:3001`

---

## 方式十：ARM64 开发板 / 国产 SoC（A311D / RK3566 / OES / OECT）

适用于把 aarch64 的开发板当作家庭/小型团队的笔记服务器。典型设备：
Amlogic **A311D**（Cortex-A73+A53）、Rockchip **RK3566**（Cortex-A55），
搭配 OES Linux / Armbian / OpenKylin 等 Debian 系发行版。

**推荐流程（x86 开发机交叉构建 → 板子导入运行）：**

```bash
# 1. 在 x86 开发机上（一次性）注册 QEMU，使 buildx 能跨架构构建
docker run --privileged --rm tonistiigi/binfmt --install arm64

# 2. 构建 arm64 镜像并打成 tar
bash scripts/release.sh --build-only --arch arm64 --tar -y
# 产物：nowen-note-arm64.tar

# 3. 把 tar 文件传到板子（scp / U 盘都行），然后在板子上：
docker load -i nowen-note-arm64.tar
docker run -d \
  --name nowen-note \
  --restart unless-stopped \
  -p 3001:3001 \
  -v nowen-note-data:/app/data \
  cropflre/nowen-note:arm64
```

访问 `http://<板子 IP>:3001` 即可。

更多细节（多架构 manifest、推送到 registry、板子原生构建、常见坑）见
[deploy-arm64.md](./deploy-arm64.md)。

---

## 通用注意事项

- **数据持久化**：务必将容器内的 **`/app/data`** 目录映射到宿主机（⚠️ 注意是 `/app/data`，不是 `/data`，填错会导致 NAS 挂载目录看不到任何文件），否则容器删除后数据丢失。镜像已通过 `VOLUME ["/app/data"]` 声明数据卷，主流 NAS 面板（绿联 / 群晖 / 威联通 / 极空间 / 飞牛 等）创建容器时会**自动把 `/app/data` 填入容器目录**，避免手填出错
- **数据备份**：支持两种方式 — 直接备份 `nowen-note.db` 文件，或通过 API `/api/backups` 在线创建/下载备份
- **自动备份**：服务启动后自动开启每 24 小时数据库备份，保留最近 10 个自动备份
- **端口冲突**：如 3001 端口被占用，可修改主机端口映射（如 `8080:3001`）
- **安全建议**：首次登录后请立即修改默认密码；如需外网访问，建议搭配反向代理（Nginx / Caddy）并启用 HTTPS
- **Ollama**：如需本地 AI 推理，请自行部署 Ollama 服务并配置 `OLLAMA_URL` 环境变量
