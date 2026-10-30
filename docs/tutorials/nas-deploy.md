# NAS 部署教程

> 在群晖、绿联、飞牛、威联通、极空间等 NAS 上部署 nowen-note。

---

## 群晖 Synology

### Docker 套件方式

1. 打开 Container Manager
2. 从 Docker Hub 拉取镜像或导入 docker-compose.yml
3. 配置端口 3001:3001
4. 映射存储 `/volume1/docker/nowen-note/data:/app/data`
5. 启动

### SSH 方式

```bash
mkdir -p /volume1/docker/nowen-note/data
cd /volume1/docker/nowen-note
# 放入 docker-compose.yml
docker-compose up -d
```

---

## 绿联 UGOS

1. Docker 应用 → 创建项目 → 使用 docker-compose.yml
2. 映射数据目录
3. 启动

---

## 飞牛 fnOS

### .fpk 一键安装（推荐）

1. 从 [Releases](https://github.com/cropflre/nowen-note/releases) 下载 .fpk
2. 应用中心 → 设置 → 手动安装应用 → 选择文件
3. 桌面出现图标，浏览器打开 `http://<飞牛IP>:3001`

> 💡 当前 .fpk 仅支持 x86_64 飞牛设备。

---

## 威联通 QNAP

Container Station → Docker Compose → 配置启动

---

## 极空间

Docker 功能 → 导入 docker-compose.yml → 配置启动

---

## 通用注意事项

- **端口冲突**：修改映射端口
- **HTTPS**：已有 NAS 反代或 Lucky 时复用其证书与域名入口；Docker 新部署可使用配套 Caddy 模板。配置与检查步骤见 [HTTPS 部署](../https-deployment.md)。
- **数据安全**：确保映射到持久存储
- **备份**：使用 NAS 自带快照功能

---

## 下一步

- [Docker 一键部署](./docker-deploy.md)
- [数据备份与迁移](./backup-migrate.md)

---

> 本教程基于 nowen-note v1.1.18 编写。
