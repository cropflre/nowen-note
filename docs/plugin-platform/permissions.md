# 权限与 Host API

V1 权限：

- `notes:read/write`
- `notebooks:read/write`
- `tags:read/write`
- `tasks:read/write`
- `attachments:read/write`
- `diary:read/write`
- `mindmaps:read/write`
- `plugin-storage:read/write`
- `external:fetch`
- `secrets:use`

V1 绝不提供 `database:*`、`filesystem:*`、`process:*`、`shell:*`、`sync:*`、`credentials:*` 或系统设置写权限。

授权结果始终是“插件权限 + 当前用户权限 + Workspace Role + Resource ACL”的交集。比如插件得到 `notes:write`，当前用户对 Restricted Note 只有 read，插件仍不能写。

`external.fetch` 仅允许 Manifest 白名单内的 HTTPS Host，阻止本机/私有网地址和自动重定向。连接密钥由 AES-256-GCM 加密存放，Broker 请求时注入；插件只引用连接名，不接触真实密钥。
