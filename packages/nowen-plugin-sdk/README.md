# @nowen/plugin-sdk

Nowen Extension Platform V2 的强类型 SDK，同时兼容 V1。插件只导出 `definePlugin({ actions })`；数据访问必须通过执行上下文中的 `nowen` Host API，不会得到数据库句柄、连接密钥或登录 Token。SDK 提供资源类型、执行上下文、标准错误码、`nowen.progress()` 和 `nowen.runtime.capabilities()`。

```ts
import { definePlugin } from "@nowen/plugin-sdk";

export default definePlugin({
  actions: {
    hello: async ({ input }) => ({ text: `Hello ${input.name ?? "Nowen"}` }),
  },
});
```
