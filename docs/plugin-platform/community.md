# 社区插件贡献指南

提交前请确保：

1. 包内只有已构建 ESM、Manifest、文档和静态资源。
2. 权限最小化；网络域名必须逐个声明。
3. 日志不包含正文、Token、Cookie、Authorization、密码或 Secret。
4. Action 在 30 秒内完成；长流程拆成可重试的小步骤。
5. 对输入做业务层校验，错误信息不泄露敏感数据。
6. 用 `examples/plugins/hello-nowen` 验证最小包，再运行 `npm run pack`。

信任标记分为 Official、Verified 和 Community。Verified 只是审核标记，不会把 Node 子进程变成安全沙箱。

## Registry 提交

开发者发布 GitHub Release（或其他稳定 HTTPS 下载），用 `npx nowen-plugin pack` 生成插件包与 SHA256，然后向 Registry 仓库提交单个插件条目。Registry CI 应下载包并执行 checksum、Manifest、权限、Nowen 版本、源码仓库、License 和 Package Validator 检查。

Developer 等级只用于本地目录，不能从远程 Registry 声明。
