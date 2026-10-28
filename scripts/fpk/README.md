# 飞牛 fpk 应用包制作

把当前项目打包为飞牛 fnOS（fnnas）的 fpk 应用包，可在飞牛 NAS 应用中心手动安装。

## 前置条件

1. **fnpack 工具**：根目录放一份 fnpack 二进制即可，脚本会按当前操作系统/架构自动选择：
    - Windows: `fnpack-<ver>-windows-amd64`（.exe 也行）
    - Linux  : `fnpack-<ver>-linux-amd64`（必须 `chmod +x`）
    - macOS  : `fnpack-<ver>-darwin-amd64` / `fnpack-<ver>-darwin-arm64`
    - 也可以通过环境变量 `FNPACK_BIN=/abs/path/to/fnpack` 显式指定
    - 官方下载：<https://developer.fnnas.com/>
2. **Docker 镜像已发布到 Docker Hub**：飞牛不会现场构建，必须用预构建镜像。
3. **Node.js 24.22.1+（24.x LTS）**。

## 一、推荐：用 release.sh 一键发布

最省心的姿势——在仓库根目录跑：

```bash
./scripts/release.sh
# 选 5：🚀 一键全量发布（git tag + Docker 多架构 + exe + APK + .fpk + GitHub Releases）
# 或   选 7：仅打飞牛 .fpk
```

`release.sh` 会自动：

- 把镜像推到 Docker Hub（tag = `v<version>`）
- 调 `scripts/fpk/build-fpk.mjs`，并通过环境变量传入 `FPK_IMAGE_TAG=v<version>`，让 `compose.yaml` 里的镜像 tag **与 push 一致**（manifest 仍用纯 `<version>`，飞牛要求 X.Y.Z 形式）
- 把 `.fpk` 上传到 GitHub Releases

> 历史坑：早期 build-fpk.mjs 的 compose 里写的是裸版本号 `1.0.x`，但 release.sh push 的是 `v1.0.x`，导致飞牛 NAS 安装时拉镜像报 `manifest unknown / EOF`（错误信息有误导性）。已通过 `FPK_IMAGE_TAG` 修复。

## 二、手动发布镜像 + 手动打包

如果你不想走 `release.sh`，也可以手动：

```powershell
# Windows PowerShell：构建并推 Docker Hub
$VER = (Get-Content package.json | ConvertFrom-Json).version
docker build -t yourname/nowen-note:v$VER .
docker push  yourname/nowen-note:v$VER
docker tag   yourname/nowen-note:v$VER yourname/nowen-note:latest
docker push  yourname/nowen-note:latest
```

然后调 build-fpk.mjs：

```powershell
# Windows
$env:DOCKERHUB_REPO = "yourname/nowen-note"
$env:FPK_IMAGE_TAG  = "v$VER"   # 与 push 的 tag 对齐！否则飞牛装不上
node scripts/fpk/build-fpk.mjs
```

```bash
# Linux / macOS
DOCKERHUB_REPO=yourname/nowen-note \
FPK_IMAGE_TAG=v${VER} \
node scripts/fpk/build-fpk.mjs
```

成功后产物在 `dist-fpk/`，文件名形如 `nowen-note-1.0.31.fpk`。

### 环境变量参考

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DOCKERHUB_REPO` | ✅ | 例如 `yourname/nowen-note` |
| `FPK_VERSION` | | 写入 manifest 的版本号（飞牛要求 X.Y.Z），默认读 `package.json.version` |
| `FPK_IMAGE_TAG` | | compose.yaml 里镜像的 tag（可带 v 前缀），**默认与 FPK_VERSION 一致**。release.sh 会传 `v<version>` |
| `FNPACK_BIN` | | fnpack 可执行文件绝对路径，默认按平台/架构自动探测 |
| `FPK_OUT_DIR` | | 输出目录，默认 `dist-fpk` |

## 三、安装到飞牛 NAS

1. 把 `.fpk` 上传到飞牛 NAS 任意目录
2. 飞牛桌面打开「**应用中心**」
3. 右上角「设置」 → 「**手动安装应用**」
4. 选择刚才的 `.fpk` 文件，确认安装
5. 安装完成后桌面会出现「弄文笔记」图标，点击在浏览器中打开

## 四、目录结构

```
scripts/fpk/
├── build-fpk.mjs           # 一键打包脚本
├── README.md               # 本文档
└── template/               # fpk 项目模板
    ├── manifest            # 应用元信息（version 在打包时注入）
    ├── config/
    │   ├── privilege       # 权限：root 模式（docker compose 需要）
    │   └── resource        # 类型：docker-project
    ├── cmd/
    │   └── main            # 主控脚本（status 检测）
    └── app/
        ├── docker/
        │   └── docker-compose.yaml   # image: {{DOCKERHUB_REPO}}:{{IMAGE_TAG}}
        └── ui/
            ├── config      # 桌面入口配置（在浏览器打开）
            └── images/     # 桌面图标（打包时从 electron/icon.png 自动生成）
```

打包时根目录还会自动生成 `ICON.PNG`(64×64) 和 `ICON_256.PNG`(256×256)。

## 五、版本升级流程

1. 修改 `package.json` 的 `version`
2. 重新构建并 push 镜像（tag = `v<version>`）
3. 重新跑 `node scripts/fpk/build-fpk.mjs`（**记得传 `FPK_IMAGE_TAG=v<version>`**），得到新版 `.fpk`
4. 飞牛应用中心覆盖安装

数据卷由飞牛托管在 `${TRIM_PKGVAR}/data`，升级不会丢数据。

> 走 `release.sh` 选 5 / 选 7 时，FPK_IMAGE_TAG 会自动注入，不必手动设置。

## 六、关于 ARM 设备

飞牛 fnOS 当前**仅支持 x86_64** 第三方应用（manifest 的 `platform=x86`）。
ARM 飞牛设备等官方放开后再补 arm64 支持。

## 七、故障排查

| 现象 | 处理 |
|------|------|
| `fnpack 找不到` | 项目根目录放 `fnpack-<ver>-<os>-<arch>` 二进制，或设 `FNPACK_BIN`；Linux/macOS 记得 `chmod +x`。下载：<https://developer.fnnas.com/> |
| 安装时报 `manifest unknown` 或 `EOF` | compose 里 image tag 与 Docker Hub 实际 tag 不一致。确认打包时 `FPK_IMAGE_TAG` 和 `docker push` 的 tag 完全相同（推荐都用 `v<version>`） |
| 安装失败提示版本不兼容 | 飞牛系统版本低于模板要求，升级飞牛或调低 `manifest` 的 `os_min_version` |
| 装上图标但打不开 | 镜像没拉成功。SSH 进飞牛 `docker logs nowen-note` 看错误（多半是 Docker Hub 网络） |
| 端口冲突 | 飞牛会自动分配；要固定端口可在飞牛应用详情里改映射 |
