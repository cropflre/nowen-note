# Nowen Extension Platform V1

V1 只支持服务端 Action 插件。Web、Desktop、Mobile、MCP 和 AI 都调用同一组服务端 Action API；移动端不会加载本地 Node 插件。

## 五分钟开始

```bash
npm create nowen-plugin
cd my-plugin
npm install
npm run dev
npm run pack
```

`npm run pack` 生成 `.nowen-plugin` 文件。管理员在“设置 → 插件”选择该文件，阅读第三方代码警告和权限说明后安装。新插件先进入 `quarantined`，管理员确认权限后才能启用。

插件默认导出：

```ts
import { definePlugin } from "@nowen/plugin-sdk";

export default definePlugin({
  actions: {
    summarize: async ({ input, nowen }) => {
      const note = await nowen.notes.get({ noteId: input.noteId });
      return { text: note.contentText };
    },
  },
});
```

插件不会收到数据库句柄、JWT、密码或同步凭证。`nowen.*` 调用通过 IPC 返回后端，由 Plugin Permission、用户权限、Workspace Role 和资源 ACL 共同裁决。

## 安全边界

- `.nowen-plugin` 是 ZIP，但禁止路径穿越、符号链接、`node_modules`、安装脚本、native addon 和可执行文件。
- 单包不超过 20MB，解压后不超过 50MB、500 个文件；输入 256KB、输出 1MB。
- 每个插件一个子进程，单插件串行、全局最多两个执行；交互 Action 默认 10 秒，后台 Action 最多 30 秒。超时会终止 Worker。
- Community 插件仍是受信任代码模型。子进程提供故障隔离，不是安全沙箱；插件理论上仍可使用 Node 内置模块。只安装可信来源。
- 完整备份只包含 `plugins/installed`。恢复后所有插件进入 quarantine，授权清零；`plugins/runtime`、`plugins-dev`、执行日志不进入备份。

参见 [Manifest V1](./manifest-v1.md)、[权限与 Host API](./permissions.md) 和 [社区贡献指南](./community.md)。

V1.1 增加版本升级/回滚、Preflight、进度与重启恢复、强类型 SDK/CLI、连接配置和开放 Registry。参见 [Community Ready V1.1](./community-ready-v1.1.md) 与 [Registry V1](./registry-v1.md)。

V1.2 增加持久事件账本、工作流、时区调度、签名 Webhook、重试/幂等/死信、自动化中心与 MCP 工具。参见 [Event & Automation V1.2](./automation-v1.2.md)。

V2 增加 Publisher/Registry 双重签名、QuickJS/WASM 沙箱、不可变多版本更新、安全公告、企业策略、声明式 UI/Automation 模板和独立 Marketplace 服务。参见 [Extension Platform V2](./extension-platform-v2.md)、[GitHub Static Registry V2](./github-static-registry.md) 与 [GitHub Actions 发布模板](./plugin-publish-action.yml)。
