# Docker 在线升级

Nowen Note 的 Docker 在线升级只面向官方 `docker-compose.yml` 部署。该能力默认关闭，主应用容器永远不会挂载 Docker Socket。

## 架构

- `nowen-note`：业务服务，只能通过内部 HTTP 调用更新代理，没有 Docker Engine 权限。
- `nowen-note-updater`：独立控制面，仅在 `updater` profile 启用时启动；唯一挂载 `/var/run/docker.sock` 的容器。
- 更新代理只识别同时具有以下标签的唯一容器：
  - `com.nowen-note.managed=true`
  - `com.nowen-note.role=app`
  - `com.nowen-note.project=nowen-note`
  - `com.nowen-note.instance=<实例标识>`
- 目标镜像仓库固定为 `cropflre/nowen-note`，API 不接受容器名、镜像仓库、挂载、环境变量、Shell 或 Docker Engine 参数。

## 启用

1. 在 `.env` 里生成并保存至少 32 字符的随机共享密钥：

   ```bash
   NOWEN_UPDATER_TOKEN=$(openssl rand -hex 32)
   echo "NOWEN_UPDATER_TOKEN=${NOWEN_UPDATER_TOKEN}" >> .env
   ```

2. 使用稳定版本 Tag 启动主服务与更新代理：

   ```bash
   NOWEN_IMAGE_TAG=v1.4.1 docker compose --profile updater up -d
   ```

3. 登录管理员账号，打开「设置 → 关于 → 版本信息」。Docker 在线升级区域会显示部署类型、镜像 Tag、Digest、更新代理和数据库 Schema 状态。

更新代理不发布宿主机端口，只加入 `nowen-update-internal` 内部网络。不要给 updater 配置反向代理或公网入口。

## 升级流程

1. 管理员密码二次验证，获取 5 分钟 sudo 授权。
2. 校验最新稳定 GitHub Release、当前版本、数据库 Schema、Docker 架构、受管标签、磁盘空间和目标镜像。目标镜像的版本标签与内置版本环境变量必须同时匹配目标版本，并具有官方仓库 Digest；旧镜像缓存或缺失元数据会阻止升级。
3. 在旧容器仍运行时拉取目标版本镜像；拉取失败不会产生停机。
4. 自动创建完整备份，并重新计算 SHA-256 校验文件。
5. 管理员输入精确目标版本并确认迁移风险。
6. 停止旧容器，将其改名并保留为回滚点；按原端口、卷、用户环境变量、网络、资源限制和重启策略，使用已校验的不可变 Digest 创建新容器。实际镜像 ID 必须匹配预检结果才允许启动。
7. 新容器必须通过 Docker HEALTHCHECK、`/api/health`、`/api/version` 与连续稳定观察窗口。实际版本必须等于目标版本，数据库 Schema 与程序 Schema 必须是有效数字且相等；信息缺失或任何一次检查失败均不能算升级成功，并会重置观察窗口。
8. 成功后删除旧容器；失败时先停止新容器并确认停止，再判断是否允许自动恢复旧容器。

## 回滚边界

当前版本没有发布级、可机器校验的数据库迁移兼容元数据，也没有离线读取失败容器数据库的能力，因此自动回滚采取保守策略：

- 新容器尚未尝试启动时，允许恢复旧容器。
- 尝试启动过新容器后（包括启动请求报错），只允许在新服务返回目标版本、数据库迁移已完成且 Schema 不高于升级前旧程序支持的版本时回滚。旧程序支持的 Schema 必须在停机前读取并记录，不能用备份的版本推测当前数据库状态。
- 新服务不可达、版本或 Schema 信息缺失、迁移未完成或数据库已超出旧程序支持范围时，停止新容器，保留新旧容器及当前数据，拒绝自动启动旧程序。新容器无法停止或移除时，也禁止启动旧容器，避免同时写同一数据库。
- 升级前完整备份始终保留。
- 自动回滚不会覆盖当前数据库，也不会把“旧镜像已恢复”描述为“数据已安全回滚”。
- 若发生不可逆迁移，需要管理员先停止业务容器，再使用升级前备份执行人工数据恢复。
- 若备份目录与数据目录位于同一物理卷，界面会明确告警；生产环境应把 `BACKUP_DIR` 挂载到独立物理卷。

## 手动恢复

查看更新代理任务：

```bash
docker compose --profile updater logs --tail=200 nowen-note-updater
docker ps -a --filter label=com.nowen-note.project=nowen-note
```

若自动回滚被拒绝或失败，会保留名为 `nowen-note-rollback-<任务前缀>` 的旧容器。先查看任务错误并确认所有相关容器已停止，备份当前完整数据目录；优先使用兼容当前数据库的新镜像恢复服务。只有确认旧程序兼容当前数据库，或已完成升级前完整备份恢复，才可恢复旧容器名称、网络并启动。恢复旧备份会回退其生成之后的数据，应先单独保留当前数据。不要直接重启旧容器，也不要修改 `schema_migrations` 的版本号绕过保护。

## 极空间等 NAS 面板手动升级

非托管 NAS 容器不经过上述更新代理，需在面板手动完成以下步骤：

1. 停止容器，备份原来映射到 `/app/data` 的完整目录，记录原挂载、端口与配置。
2. 拉取已发布的明确版本 `cropflre/nowen-note:v<版本号>`，核对镜像来源、架构和 Digest；仅重启旧容器不会换镜像。
3. 使用新镜像重建容器，保留原来的数据目录映射、端口与配置。
4. 启动后核对 `/api/version` 的 `appVersion`、`schemaVersion` 和 `codeSchemaVersion`，并确认笔记与附件正常，再确认升级完成。
5. 遇到“数据库版本高于当前程序支持”时，停止反复重启并改用兼容的新镜像；不要删除数据、降低数据库版本号或直接换回旧镜像。

## 本地源码构建

源码构建继续使用覆盖文件，不启用在线升级：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

`.fpk`、`.upk`、桌面端本地服务和其他非托管部署不会显示不可执行的“立即升级”按钮，而是展示对应的应用中心或手动升级指引。
