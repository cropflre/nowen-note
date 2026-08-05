# nowen-mcp

Nowen Note 的本地 stdio MCP Server，让支持 Model Context Protocol 的 AI 客户端在授权范围内搜索、读取和维护笔记。

> 完整用户教程：[中文安装指南](../../docs/tutorials/mcp.md) · [English guide](../../docs/tutorials/mcp.en.md)

## 要求

- Node.js 20+
- npm
- 一个可以从当前电脑访问的 Nowen Note 服务
- 推荐使用 restricted Personal API Token

## 从仓库安装

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note/packages/nowen-mcp
npm install
npm run build
```

构建产物：

```text
dist/scoped-entry.js
```

稳定启动器（客户端应配置这个文件）：

```text
bin/nowen-mcp.mjs
```

快速检查：

```bash
node ./bin/nowen-mcp.mjs
```

stdio Server 正常情况下会等待客户端输入并保持静默。没有立即退出或报错即说明脚本可以启动，按 `Ctrl+C` 结束。


## 启动诊断与运行日志

稳定启动器会在真正加载 `dist/scoped-entry.js` 之前检查 Node.js 版本、`NOWEN_URL` 和构建入口，并把结构化日志写入 **stderr**。stdout 仅用于 MCP stdio 协议，不会被普通日志污染。

常见错误会给出稳定错误码和解决建议：

- `ENTRY_NOT_FOUND`：执行 `npm install && npm run build`；
- `DEPENDENCY_NOT_FOUND`：依赖或构建产物不完整，重新安装并构建；
- `INVALID_NOWEN_URL`：修正服务地址；
- `uncaught_exception` / `unhandled_rejection`：日志包含完整 stack；
- `stdin_closed` / `shutdown_signal`：明确记录父进程关闭或信号退出。

调试长会话时可选开启心跳，默认关闭：

```text
NOWEN_MCP_HEARTBEAT_MS=300000
```

心跳只写 stderr，并包含 PID、运行时长和内存使用；允许范围为 10000～86400000 毫秒。
## 最小客户端配置

```json
{
  "mcpServers": {
    "nowen-note": {
      "command": "node",
      "args": [
        "/absolute/path/to/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs"
      ],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

必须替换：

- `args` 中的脚本绝对路径；
- `NOWEN_URL`；
- `NOWEN_API_TOKEN`。

Windows JSON 路径示例：

```json
"C:\\Users\\YourName\\nowen-note\\packages\\nowen-mcp\\dist\\scoped-entry.js"
```

VS Code 的 `.vscode/mcp.json` 使用顶层 `servers` 字段：

```json
{
  "servers": {
    "nowen-note": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs"
      ],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

## Claude Code

```bash
claude mcp add nowen-note --scope user \
  --env NOWEN_URL=http://192.168.1.20:3001 \
  --env NOWEN_API_TOKEN=nkn_xxx \
  -- node /absolute/path/to/bin/nowen-mcp.mjs
```

验证：

```bash
claude mcp get nowen-note
claude mcp list
```

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `NOWEN_URL` | Nowen Note 服务地址 | `http://localhost:3001` |
| `NOWEN_API_TOKEN` | Personal API Token | — |
| `NOWEN_USERNAME` | 旧版用户名认证 | `admin` |
| `NOWEN_PASSWORD` | 旧版密码认证 | `admin123` |
| `ALLOWED_NOTEBOOK_IDS` | MCP 本地笔记本白名单，逗号分隔 | 未启用 |
| `MCP_ACCESS_MODE` | `read-only` 或 `read-write` | `read-write` |
| `MCP_INCLUDE_DESCENDANTS` | 本地白名单是否包含子笔记本 | `false` |
| `NOWEN_MCP_HEARTBEAT_MS` | 可选 stderr 心跳间隔（毫秒），0/off 关闭 | `0` |

认证优先级：

1. `NOWEN_API_TOKEN`
2. `NOWEN_USERNAME` + `NOWEN_PASSWORD`

## 常用命令

```bash
npm run dev
npm run build
npm start
npm test
```

- `npm run dev`：监听源码并启动开发 Server。
- `npm run build`：编译到 `dist/`。
- `npm start`：运行已构建的 Server。
- `npm test`：构建并执行作用域策略测试。

## 更新

```bash
git pull
cd packages/nowen-mcp
npm install
npm run build
```

更新后重启 MCP 客户端或在客户端中 Restart Server。

## 安全建议

- 每个 AI 客户端使用独立 Token。
- 先用只读 Token 验证，再按需增加写权限。
- 不要把 Token 提交到 Git 仓库。
- `NOWEN_URL` 指向 NAS 时，先从客户端电脑浏览器验证地址可访问。
- 权限结果为：用户 ACL、Token scopes、Token 笔记本授权以及本地 MCP 白名单的交集。

## 发行说明

当前仓库保证的是源码构建方式。除非 Nowen Note 的 Release 或官方文档明确宣布 npm / DXT 包，避免假设 `npx nowen-mcp` 或一键 DXT 已经可用。
