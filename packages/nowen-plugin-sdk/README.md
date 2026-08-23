# @nowen/plugin-sdk

Nowen Extension Platform V1 的薄类型层。插件只导出 `definePlugin({ actions })`；数据访问必须通过执行上下文中的 `nowen` Host API，不会得到数据库句柄或登录 Token。

```ts
import { definePlugin } from "@nowen/plugin-sdk";

export default definePlugin({
  actions: {
    hello: async ({ input }) => ({ text: `Hello ${input.name ?? "Nowen"}` }),
  },
});
```
