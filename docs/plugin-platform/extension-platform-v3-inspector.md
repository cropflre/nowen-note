# V3 Phase 3A：资源检查器

2026-10-18，基于 `release/v1.5.3` 的 `3b7579f0`，在独立分支 `codex/extension-v3-inspector` 开发。首期为选中资源的只读元数据检查器；不代表整个 Phase 3 已完成。

## 启用和使用

设置服务端环境变量 `NOWEN_EXTENSION_V3_INSPECTORS=1` 并重启。缺省关闭；V3 Core、App Pages 及旧版显式关闭覆盖继续生效。不修改宿主版本和数据库版本，不新增数据库迁移。

管理员通过现有插件管理安装并授权检查器。用户在笔记工具栏、任务详情或附件详情点击“插件检查器”，再选择已安装的检查器。插件按用户操作加载，不在后台自动运行。窗口支持键盘关闭、主题变化及窄屏。Web 与同源 DesktopFull 使用同一链路；原生客户端不展示入口，ElectronLite 不属于支持范围。

## Manifest

继续使用 `apiVersion: 3` 和 `.nowen-plugin`：

```json
{
  "inspectors": [{
    "id": "metadata",
    "title": "Resource Inspector",
    "pageId": "home",
    "resourceTypes": ["note", "task", "attachment"]
  }]
}
```

该片段放在 `contributes` 中。每插件最多 8 个检查器，ID 唯一，`pageId` 必须引用本插件真实页面。资源类型不可重复；Manifest 必须声明相应 `notes:read`、`tasks:read`、`attachments:read` 权限。页面平台、资源 SHA-256、安装签名和授权仍沿用原合同。

`GET /api/plugins/inspectors?platform=web&resourceType=note&workspaceId=personal` 返回兼容、启用、权限完整的检查器及其 `inspectorId`；最多 32 个。会话创建沿用 `POST /api/plugins/apps/:pluginId/:pageId/session`，由宿主额外提交：

```json
{
  "platform": "web",
  "workspaceId": "personal",
  "inspector": { "id": "metadata", "resource": { "type": "note", "id": "selected-note-id" } }
}
```

服务端校验声明、资源读取权限和工作区后，将资源身份不可变地绑定到会话。UI 消息不能替换资源 ID 或作用域。客户端提交选择不构成授权，资源 ACL 始终以服务端为准。

## Bridge 和 Broker

检查器会话只允许两种方法：

- `context.get()`：取得既有主题/平台/工作区上下文，以及 `selection: {type,id}`。
- `inspector.getResource()`：读取该会话绑定资源的最新已保存元数据；参数必须为空对象。

首期不会向检查器开放列表枚举、业务写入、插件存储、网络或导航方法。普通应用会话不能调用 `inspector.getResource`。检查器页若从应用目录单独打开，没有 selection，应显示使用说明。

Broker 源合同版本为 6，增加 API V3 / sandbox-js 的 `notes.inspect`、`tasks.inspect`、`attachments.inspect`，沿用对应读权限。V1/V2 不支持这些新增方法。源合同更新后生成后端合同、SDK、Mock 和文档；UI 只能通过无参数的选择适配器访问这些方法。

| 资源 | 返回范围 |
| --- | --- |
| 笔记 | ID、标题、格式、版本、时间、已保存纯文本字符数 |
| 任务 | ID、标题、状态、优先级、到期日期和时间戳 |
| 附件 | ID、文件名、MIME、大小、创建时间、可读所属笔记 ID |

不返回正文、任务描述、附件路径、字节、下载 URL、账号标识或凭据。加密笔记及其附件不开放检查；回收站资源拒绝访问。附件同时检查附件作用域/所有者、所属笔记作用域及 ACL；工作区 viewer 可读取当前空间内有权限的资源。

## 生命周期和边界

复用已验证的 iframe 文档票据、CSP、MessageChannel、随机 nonce、消息限额和 SSE 回收。检查器每次调用及生命周期检查都重新验证资源状态与 ACL；删除资源、移出工作区、撤权或关闭功能后，旧会话拒绝调用。选择变更时前端卸载旧 frame、关闭通道并请求服务端回收；迟到的注册查询不会重新打开旧资源。

本地尚未保存的编辑不在此只读 API 范围内，插件可手动刷新已保存元数据。首期没有 EXIF/文件字节、正文分析、Previewer、后台服务或 AI 审批实现。不新增离线写入或 Sync V2 实体。iframe 自身导航首次请求和 CPU/内存硬隔离的既有缺口仍存在，见[应用运行边界](./extension-platform-v3-app-runtime.md)。

## 示例和验证

[Resource Inspector](../../examples/plugins/resource-inspector/README.md) 可用既有 CLI 独立打包安装，无需修改核心业务页面。对接其他检查器只需实现相同 Manifest 与 Bridge 合同。

本地验证使用临时数据库和目录，未触碰用户数据。验收记录见 [Phase 3A 本地验收](../qa/v1.5.3/extension-v3-inspector.md)。远端 CI、Electron 成品、Docker/NAS 和真实移动设备须另行验证。
