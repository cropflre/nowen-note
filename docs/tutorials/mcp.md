# MCP Server 安装与使用教程

> 通过 Model Context Protocol（MCP），让 Claude Code、Cursor、VS Code 等 AI 客户端在授权范围内搜索、读取和维护你的 Nowen Note 笔记。

[返回教程中心](./README.md) · [English](./mcp.en.md) · [MCP 包说明](../../packages/nowen-mcp/README.md)

## 先看结论

- MCP 功能仍然受支持，服务端代码位于 `packages/nowen-mcp/`。
- 当前官方仓库提供的是**源码安装方式**，需要 Node.js 20+、Git 和 npm。
- 不要直接照抄 `/path/to/...`。客户端配置中的脚本路径必须替换为你电脑上的**绝对路径**。
- 如果 Nowen Note 部署在 NAS 或其他服务器，`NOWEN_URL` 应填写该设备能从当前电脑访问的地址，例如 `http://192.168.1.20:3001`，而不是 `localhost`。
- 推荐使用独立的 restricted Personal API Token，不要把管理员密码写进 MCP 配置。

## 5 分钟快速接入

### 1. 确认 Nowen Note 可以访问

先在运行 AI 客户端的电脑浏览器中打开：

```text
http://你的服务器IP:3001
```

示例：

```text
http://192.168.1.20:3001
```

本机部署才使用：

```text
http://localhost:3001
```

如果浏览器都打不开，请先处理 Docker 端口、NAS 防火墙、反向代理或局域网访问问题，MCP 无法绕过网络连接问题。

### 2. 安装 Node.js 20+ 和 Git

检查版本：

```bash
node --version
npm --version
git --version
```

`node --version` 应为 `v20` 或更高版本。

### 3. 下载并构建 MCP Server

#### Windows PowerShell

```powershell
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note\packages\nowen-mcp
npm install
npm run build
```

构建后应存在：

```text
nowen-note\packages\nowen-mcp\dist\scoped-entry.js
```

检查文件：

```powershell
Test-Path .\dist\scoped-entry.js
```

返回 `True` 才表示构建产物存在。

#### macOS / Linux / WSL

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note/packages/nowen-mcp
npm install
npm run build
```

检查文件：

```bash
test -f ./dist/scoped-entry.js && echo "MCP build OK"
```

> 安装只要求 `npm install` 和 `npm run build`。`npm test` 是开发验证步骤，不是用户安装的必要条件。

### 4. 创建 Personal API Token

进入 Nowen Note：

```text
设置 → 个人访问令牌 → 创建令牌
```

建议：

1. 为每个 AI 客户端创建独立 Token，例如“Claude Code”或“Cursor”。
2. 只开启实际需要的 scopes，例如 `notes:read`、`notes:write`。
3. 资源范围选择“限定笔记本”。
4. 每个笔记本设置“只读”或“读写”。
5. 按需开启“自动包含子笔记本”。
6. 设置合理过期时间，Token 泄露后立即撤销。

复制生成的 Token，例如：

```text
nkn_xxxxxxxxxxxxxxxxx
```

Token 通常只展示一次，请妥善保存。

### 5. 找到 MCP 脚本的绝对路径

#### Windows PowerShell

在 `packages/nowen-mcp` 目录执行：

```powershell
(Resolve-Path .\dist\scoped-entry.js).Path
```

示例结果：

```text
C:\Users\YourName\nowen-note\packages\nowen-mcp\dist\scoped-entry.js
```

写进 JSON 时，Windows 反斜杠需要写成双反斜杠：

```json
"C:\\Users\\YourName\\nowen-note\\packages\\nowen-mcp\\dist\\scoped-entry.js"
```

#### macOS / Linux / WSL

```bash
realpath ./dist/scoped-entry.js
```

示例结果：

```text
/home/yourname/nowen-note/packages/nowen-mcp/dist/scoped-entry.js
```

然后选择下面对应的客户端配置。

---

## Claude Code

Claude Code 可以直接通过命令添加 stdio MCP Server。

### macOS / Linux / WSL

```bash
claude mcp add nowen-note --scope user \
  --env NOWEN_URL=http://192.168.1.20:3001 \
  --env NOWEN_API_TOKEN=nkn_xxx \
  -- node /home/yourname/nowen-note/packages/nowen-mcp/dist/scoped-entry.js
```

### Windows PowerShell

```powershell
claude mcp add nowen-note --scope user `
  --env NOWEN_URL=http://192.168.1.20:3001 `
  --env NOWEN_API_TOKEN=nkn_xxx `
  -- node "C:\Users\YourName\nowen-note\packages\nowen-mcp\dist\scoped-entry.js"
```

确认配置：

```bash
claude mcp get nowen-note
claude mcp list
```

修改配置后重新启动 Claude Code 会话。

官方参考：[Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)

---

## Cursor

Cursor 支持项目级和全局 MCP 配置：

- 项目级：项目目录下 `.cursor/mcp.json`
- 全局：`~/.cursor/mcp.json`

### macOS / Linux

```json
{
  "mcpServers": {
    "nowen-note": {
      "command": "node",
      "args": [
        "/home/yourname/nowen-note/packages/nowen-mcp/dist/scoped-entry.js"
      ],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

### Windows

```json
{
  "mcpServers": {
    "nowen-note": {
      "command": "node",
      "args": [
        "C:\\Users\\YourName\\nowen-note\\packages\\nowen-mcp\\dist\\scoped-entry.js"
      ],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

保存后完全退出并重新打开 Cursor，在 MCP 设置或 Available Tools 中确认 `nowen-note` 已启动。

官方参考：[Cursor MCP](https://docs.cursor.com/context/model-context-protocol)

---

## VS Code / GitHub Copilot

推荐使用命令面板：

```text
MCP: Add Server
```

也可以创建项目级配置：

```text
.vscode/mcp.json
```

VS Code 的顶层字段是 `servers`，不是 Cursor 的 `mcpServers`。

### macOS / Linux

```json
{
  "servers": {
    "nowen-note": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/home/yourname/nowen-note/packages/nowen-mcp/dist/scoped-entry.js"
      ],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

### Windows

```json
{
  "servers": {
    "nowen-note": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:\\Users\\YourName\\nowen-note\\packages\\nowen-mcp\\dist\\scoped-entry.js"
      ],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

保存后运行：

```text
MCP: List Servers
```

选择 `nowen-note`，执行 Start 或 Restart；出现问题时选择 Show Output 查看日志。

不要把真实 Token 提交到公开仓库。个人使用优先放在 VS Code 用户级 MCP 配置中，团队配置可使用输入变量或环境变量。

官方参考：[VS Code MCP Server](https://code.visualstudio.com/docs/agent-customization/mcp-servers)

---

## Claude Desktop 与其他通用客户端

支持本地 stdio MCP 的客户端通常使用以下结构：

```json
{
  "mcpServers": {
    "nowen-note": {
      "command": "node",
      "args": [
        "/absolute/path/to/nowen-note/packages/nowen-mcp/dist/scoped-entry.js"
      ],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

注意：

- 必须使用绝对路径。
- Windows JSON 路径中的 `\` 必须转义为 `\\`。
- 当前 Claude Desktop 更推荐通过 Settings → Extensions 安装 DXT 扩展；Nowen Note 目前仍以源码 stdio Server 为正式可用方式。使用 Claude Desktop 的本地开发者 MCP 配置时，请以客户端当前版本提供的入口为准。
- Claude.ai / Claude Desktop 的远程 Connector 不能直接连接这个本地 stdio 脚本；远程 MCP 需要单独的 HTTP 传输和认证实现。

官方参考：[Claude Desktop local MCP](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

---

## 验证是否安装成功

重启客户端后，先确认工具列表中出现以下任意工具：

```text
nowen_list_notebooks
nowen_list_notes
nowen_read_note
nowen_search
```

然后让 AI 执行只读测试：

```text
请使用 Nowen Note MCP 列出我有权限访问的笔记本，不要修改任何内容。
```

继续测试搜索：

```text
请使用 Nowen Note MCP 搜索“测试”，只返回标题和所属笔记本。
```

最后再测试写入权限：

```text
请在“测试”笔记本创建一篇标题为“MCP 连接测试”的 Markdown 笔记，正文写入当前日期。
```

如果只读成功而写入失败，通常是 Token scope、笔记本资源权限或 `MCP_ACCESS_MODE` 限制导致，这属于正常的安全拦截。

---

## 更新 MCP Server

进入仓库目录：

```bash
git pull
cd packages/nowen-mcp
npm install
npm run build
```

然后完全重启 MCP 客户端，或在客户端中 Restart Server / Reset Cached Tools。

如果仓库移动到新目录，客户端配置中的绝对路径也必须同步修改。

---

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `NOWEN_URL` | Nowen Note 服务地址 | `http://localhost:3001` |
| `NOWEN_API_TOKEN` | Personal API Token；配置后优先于用户名密码 | — |
| `NOWEN_USERNAME` | 兼容旧配置的登录用户名 | `admin` |
| `NOWEN_PASSWORD` | 兼容旧配置的登录密码 | `admin123` |
| `ALLOWED_NOTEBOOK_IDS` | MCP 实例侧笔记本白名单，逗号分隔；显式空值代表拒绝全部 | 未启用本地作用域 |
| `MCP_ACCESS_MODE` | `read-only` 或 `read-write` | `read-write` |
| `MCP_INCLUDE_DESCENDANTS` | 本地白名单是否包含全部子笔记本 | `false` |

认证优先级：

1. `NOWEN_API_TOKEN`
2. `NOWEN_USERNAME` + `NOWEN_PASSWORD`

新安装应优先使用 `NOWEN_API_TOKEN`。用户名密码只用于兼容旧配置，不建议继续用于长期自动化。

---

## 推荐安全配置：restricted Token

服务端最终权限为：

```text
用户 ACL ∩ Token scopes ∩ Token 笔记本资源授权
```

restricted Token 即使被绕过 MCP 直接调用 REST API，也不能访问未授权笔记本。历史 Token 默认保持 `unrestricted`，兼容升级前行为。

最简配置：

```json
{
  "mcpServers": {
    "nowen-note": {
      "command": "node",
      "args": ["/absolute/path/to/dist/scoped-entry.js"],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

还可以叠加 MCP 本地白名单作为第二道限制：

```json
{
  "mcpServers": {
    "nowen-note": {
      "command": "node",
      "args": ["/absolute/path/to/dist/scoped-entry.js"],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx",
        "ALLOWED_NOTEBOOK_IDS": "notebook-id-1,notebook-id-2",
        "MCP_ACCESS_MODE": "read-only",
        "MCP_INCLUDE_DESCENDANTS": "true"
      }
    }
  }
}
```

两层同时启用时，实际范围是服务端授权与本地白名单的交集。

详细设计参见：[MCP Token 笔记本资源授权](./mcp-token-resource-scope.md)。

---

## 可用工具

### 笔记本

| 工具 | 说明 |
|---|---|
| `nowen_list_notebooks` | 列出当前 Token 可以访问的笔记本 |
| `nowen_create_notebook` | 创建笔记本；restricted 模式下需拥有目标父笔记本写权限 |

### 笔记与搜索

| 工具 | 说明 |
|---|---|
| `nowen_list_notes` | 列出授权范围内的笔记 |
| `nowen_read_note` | 读取笔记，服务端根据 `noteId` 校验资源范围 |
| `nowen_create_note` | 在拥有写权限的笔记本创建笔记 |
| `nowen_update_note` | 更新授权范围内笔记 |
| `nowen_delete_note` | 删除授权范围内笔记 |
| `nowen_search` | 全文搜索，结果自动限定在授权范围内 |

### 附件与标签

| 工具 | 说明 |
|---|---|
| `nowen_upload_attachment` | restricted 模式必须绑定到有写权限的笔记 |
| `nowen_list_attachments` | 只返回授权笔记本中的附件 |
| `nowen_attach_to_note` | 将附件插入有写权限的 Markdown 笔记 |
| `nowen_list_tags` | restricted Token 只返回授权笔记关联的标签 |
| `nowen_manage_tags` | 只允许修改授权范围内笔记的标签关联 |

### AI 与知识库

| 工具 | 说明 |
|---|---|
| `nowen_ai_ask` | 按指定笔记本进行知识库问答 |
| `nowen_ai_process` | AI 处理调用方直接提供的文本 |
| `nowen_knowledge_stats` | 未限定到笔记本的全局统计在本地 scoped 模式下默认拒绝 |

restricted Token 调用知识库问答时必须指定笔记本：

```text
nowen_ai_ask({
  question: "总结该知识库的投资策略",
  notebookId: "investment-notebook-id",
  includeChildren: true
})
```

---

## 常见问题

### 客户端提示找不到 `node`

在客户端自身的终端环境检查：

```bash
node --version
```

如果终端可以运行但 GUI 客户端找不到，使用 Node 可执行文件的绝对路径作为 `command`，然后重启客户端。

Windows 查找路径：

```powershell
(Get-Command node).Source
```

macOS / Linux：

```bash
which node
```

### 提示找不到 `dist/scoped-entry.js`

重新构建：

```bash
cd packages/nowen-mcp
npm install
npm run build
```

确认配置使用的是绝对路径，并检查仓库是否被移动或删除。

### `NOWEN_URL` 连接失败

- MCP 与 Nowen Note 在同一台电脑：使用 `http://localhost:3001`。
- Nowen Note 在 NAS：使用 `http://NAS局域网IP:3001`。
- 使用 HTTPS 反向代理：填写完整公网地址，例如 `https://note.example.com`。
- 先在运行客户端的电脑浏览器中验证该地址。

### 返回 401 或 403

- 401：Token 错误、过期或已撤销。
- 403：Token scope、用户 ACL、笔记本资源授权或本地 MCP 白名单拒绝了请求。
- 不要为了绕过 403 改用管理员密码；应修正最小权限配置。

### 所有笔记本请求都被拒绝

检查：

1. restricted Token 是否至少授权了一个笔记本；
2. 是否误配置了空的 `ALLOWED_NOTEBOOK_IDS`；
3. Token 是否拥有 `notes:read` 等必要 scope；
4. 当前用户本身是否拥有该笔记本权限。

restricted Token 和显式空白名单都采用 fail-closed 设计。

### 读操作成功但写操作被拒绝

需要同时满足：

- 用户本人对该笔记本具有写权限；
- Token 包含写 scope，例如 `notes:write`；
- Token 对该笔记本设置为“读写”；
- 本地 MCP 未设置 `MCP_ACCESS_MODE=read-only`。

### 子笔记本没有显示

服务端 Token 授权中开启“自动包含子笔记本”。如果还使用本地白名单，同时设置：

```env
MCP_INCLUDE_DESCENDANTS=true
```

### 工具没有出现

1. 重新运行 `npm run build`；
2. 完全退出并重启客户端；
3. 在客户端中 Restart Server；
4. VS Code 可执行 `MCP: Reset Cached Tools`；
5. 查看 MCP 日志中的脚本路径、Node、网络和认证错误。

### 运行脚本后终端没有输出

直接执行：

```bash
node /absolute/path/to/dist/scoped-entry.js
```

stdio MCP Server 正常情况下会等待客户端输入，可能没有任何提示并保持运行。这说明脚本至少能够启动；按 `Ctrl+C` 退出即可。

---

## 安全说明

- 本地 MCP Server 与普通本地程序一样，以当前用户权限运行，只从官方仓库获取代码。
- Token 会出现在客户端配置中，不要把包含 Token 的 `.cursor/mcp.json`、`.vscode/mcp.json` 或其他配置提交到公开仓库。
- 优先使用只读 Token 验证连接，再按需要增加写权限。
- 每个 Agent 使用独立 Token，方便撤销和审计。
- 对外网开放 Nowen Note 时配置 HTTPS、强密码、备份和最小 CORS 范围。

## 下一步

- [MCP Token 笔记本资源授权](./mcp-token-resource-scope.md)
- [OpenAPI 接入指南](./api.md)
- [SDK 使用教程](./sdk.md)
- [CLI 使用教程](./cli.md)
