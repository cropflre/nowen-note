# Extension Platform V1.1 — Community Ready

V1.1 的 Node Action 是 **Trusted Plugin Runtime**。子进程隔离负责崩溃、超时和内存边界，不阻止插件直接使用 Node 文件系统或网络；安装第三方插件等同于信任其代码。

## 生命周期

安装和升级都先进入 quarantine。管理员确认权限后，Nowen 启动 Worker、导入入口、执行 `activate()`，并核对 Manifest Action 与运行时 Action；Preflight 全部通过后才标记 enabled。

每个版本独立保存在 `plugin_versions`。升级保留 previous version，新权限会清除旧授权。一键回滚只切换代码版本，不回滚插件 Storage。

## 执行语义

重启时 queued 记录标记为 failed，running 标记为 interrupted，错误码均为 `HOST_RESTARTED`，不会自动重放非幂等动作。插件可调用 `nowen.progress()`；queued 取消会立即写入数据库。

## 开发工具

```bash
npm create nowen-plugin
npx nowen-plugin validate
npx nowen-plugin build
npx nowen-plugin doctor
npx nowen-plugin pack
```

`pack` 同时生成 `.nowen-plugin` 与 `.sha256`。
