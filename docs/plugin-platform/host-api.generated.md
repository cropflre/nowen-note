<!-- 此文件由 scripts/generate-plugin-host-api.mjs 根据 packages/nowen-plugin-sdk/host-api-contract.json 生成，请勿手动修改。 -->
# Host API 合同

合同版本：1

固定预算：IPC 消息 2097152 字节，Host Call 参数 262144 字节，Host Call 结果 1048576 字节。

| 方法 | 起始 API | 权限 | Runtime | 参数上限（字节） | 结果上限（字节） |
| --- | --- | --- | --- | ---: | ---: |
| `attachments.get` | V1 | `attachments:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `attachments.list` | V1 | `attachments:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `diary.create` | V1 | `diary:write` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `diary.get` | V1 | `diary:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `diary.list` | V1 | `diary:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `external.fetch` | V1 | `external:fetch` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `mindmaps.create` | V1 | `mindmaps:write` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `mindmaps.get` | V1 | `mindmaps:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `mindmaps.list` | V1 | `mindmaps:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `mindmaps.update` | V1 | `mindmaps:write` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `notebooks.create` | V1 | `notebooks:write` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `notebooks.get` | V1 | `notebooks:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `notebooks.list` | V1 | `notebooks:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `notes.create` | V1 | `notes:write` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `notes.get` | V1 | `notes:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `notes.list` | V1 | `notes:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `notes.update` | V1 | `notes:write` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `runtime.capabilities` | V1 | 无 | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `storage.delete` | V1 | `plugin-storage:write` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `storage.get` | V1 | `plugin-storage:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `storage.set` | V1 | `plugin-storage:write` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `tags.addToNote` | V1 | `tags:write` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `tags.create` | V1 | `tags:write` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `tags.list` | V1 | `tags:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `tags.removeFromNote` | V1 | `tags:write` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `tasks.create` | V1 | `tasks:write` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `tasks.get` | V1 | `tasks:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `tasks.list` | V1 | `tasks:read` | `node-action`, `sandbox-js` | 262144 | 1048576 |
| `tasks.update` | V1 | `tasks:write` | `node-action`, `sandbox-js` | 262144 | 1048576 |

说明：`progress` 是运行时事件，不是 Broker Host Call。V2 不支持 `attachments:write`，`secrets:use` 仅用于 `external.fetch` 的 Connection 密钥注入。
