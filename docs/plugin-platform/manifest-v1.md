# Manifest V1

```json
{
  "id": "com.example.ai-tools",
  "name": "AI Tools",
  "description": "AI 内容处理工具",
  "version": "1.0.0",
  "apiVersion": 1,
  "engines": { "nowen": ">=1.5.0 <2.0.0" },
  "runtime": "node-action",
  "main": "dist/index.mjs",
  "author": { "name": "example", "url": "https://example.com" },
  "permissions": ["notes:read", "external:fetch"],
  "permissionConfig": { "externalFetchHosts": ["api.openai.com"] },
  "actions": [
    {
      "id": "summarize",
      "name": "总结笔记",
      "execution": "interactive",
      "input": { "noteId": { "type": "string", "required": true } }
    }
  ]
}
```

`id`、Action id 和公开协议字段都是稳定契约。`main` 必须是包内已构建的 `.js` 或 `.mjs`，不能包含 `..`。V1 input 字段支持 `string`、`number`、`boolean`、`object`、`array`，未声明参数会被拒绝。

包根目录必须含 `manifest.json`，其余常见文件为 `dist/index.mjs`、`README.md`、`icon.png`。Nowen 不为插件执行 `npm install`。
