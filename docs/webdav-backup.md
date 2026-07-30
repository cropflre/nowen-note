# WebDAV 远程备份

Nowen Note 支持将已经生成完成的本地备份上传到 WebDAV。该能力面向容灾归档，不会把运行中的数据库直接放到 WebDAV，也不会改变现有的本地备份和恢复流程。

## 功能边界

当前 WebDAV 能力支持：

- 手动上传已有的 `.bak` 或 `.zip` 备份；
- 自动备份完成后，将新备份同步到 WebDAV；
- 自动创建配置的远端目录；
- 记录最近一次连接测试、上传时间、文件名和错误；
- 兼容使用 Basic Authentication 的标准 WebDAV 服务。

当前不属于此功能范围：

- 将 WebDAV 作为实时笔记同步后端；
- 将 WebDAV 作为附件在线存储后端；
- 让 Nowen Note 对外提供 WebDAV 服务端接口；
- 将 `nowen-note.db` 放在 WebDAV、davfs 或其他网络文件系统上直接运行；
- 自动删除或轮转 WebDAV 中的历史备份。

本地自动备份的保留策略仍然有效，但远端文件需要由 WebDAV 服务、OpenList/rclone 或管理员另行配置生命周期管理。

## 配置入口

使用系统管理员账号进入：

```text
设置 → 数据管理 → 系统 → 备份 / 灾备 → WebDAV 远程备份
```

填写以下内容：

- **WebDAV 地址**：服务提供的目录根地址，必须以 `http://` 或 `https://` 开头；
- **用户名**：WebDAV 用户名；
- **密码或应用密码**：推荐使用服务商提供的独立应用密码；
- **远端目录**：默认 `nowen-note/backups`；
- **自动上传**：启用后，每次自动备份成功都会尝试上传。

先点击“保存配置”，再点击“测试连接”。测试会执行：

1. `PROPFIND` 检查 WebDAV 根目录；
2. 使用 `MKCOL` 逐级创建缺失目录；
3. 再次 `PROPFIND` 验证目标目录可访问。

## 上传安全策略

Nowen Note 始终先在本地生成数据库一致性快照或完整 ZIP。只有本地备份成功后，才启动远端上传。

远端写入优先采用以下流程：

```text
本地完整备份
  → PUT 到远端临时文件
  → MOVE 原子替换正式文件
  → 清理临时文件
```

部分 WebDAV 服务不支持 `MOVE` 时，会回退为直接 `PUT` 正式文件。WebDAV 上传失败只会记录远端通道错误，不会删除本地备份，也不会把已经成功完成的本地自动备份判定为失败。

单次连接测试超时为 30 秒，单个备份上传最长等待 30 分钟。同一自动备份任务不会因为 WebDAV 不可用而跳过本地保留策略或邮件通知。

## 凭据加密

WebDAV 密码不会以明文写入数据库，也不会通过读取配置接口返回。服务端使用 AES-256-GCM 加密保存凭据。

生产环境建议在 `.env` 中设置独立密钥：

```bash
BACKUP_WEBDAV_ENCRYPTION_KEY=<使用 openssl rand -base64 48 生成>
```

密钥回退顺序为：

```text
BACKUP_WEBDAV_ENCRYPTION_KEY
→ JWT_SECRET
→ 持久化目录中的 .jwt_secret
```

多实例部署必须让所有实例使用同一加密密钥，否则其他实例无法解密已经保存的 WebDAV 凭据。修改或丢失密钥后，需要在设置中重新输入 WebDAV 密码。

## 网络安全

公网 WebDAV 必须使用 HTTPS。HTTP 仅适合完全可信、隔离的局域网测试环境，因为 Basic Authentication 只是编码，不提供传输加密。

不要在 WebDAV URL 中直接写入用户名和密码，例如：

```text
https://user:password@example.com/dav/
```

这种写法会被拒绝。用户名和密码必须分别填写在配置项中，避免出现在代理日志、浏览器历史或错误信息里。

## 常见服务

只要服务实现标准 WebDAV 方法并支持文件上传，通常可以使用，例如：

- Nextcloud / ownCloud；
- OpenList / AList 暴露的 WebDAV；
- 坚果云 WebDAV；
- 群晖、威联通或其他 NAS 提供的 WebDAV 服务。

不同服务商的根路径和应用密码规则不同，应以服务商控制台给出的 WebDAV 地址为准。

## 恢复数据

WebDAV 当前只负责保存备份文件。需要恢复时：

1. 从 WebDAV 下载 `.bak` 或 `.zip`；
2. 进入 Nowen Note 的备份页面；
3. 选择“导入外部备份”；
4. 导入成功后执行 dry-run 预检；
5. 确认数据和附件数量后再正式恢复。

完整 `.zip` 包包含数据库、附件、字体、插件和登录密钥；`.bak` 仅包含数据库快照。重要实例应优先使用完整备份。
