# Frontend lint 门禁

`frontend/eslint-baseline.json` 固定来自 `main` 提交 `fd17d980ff3c206c53d114594a84cd8c559d050a` 的 1395 条历史错误，而不是 PR #797 的候选代码。基线使用当前锁定的 ESLint 依赖；Android 编译目录、打包后的 Web assets 和 Capacitor 生成脚本不属于源码检查范围。

在 `frontend` 运行：

```sh
npm run lint:baseline
```

检查全量源码，以相对路径、规则、错误消息和出错源码行的 SHA-256 识别历史错误，并记录每种错误的出现次数。行号移动不产生误报；新文件、新的出错源码、相同错误的新增副本和解析失败会使门禁失败。warning 可通过完整 `npm run lint` 查看，不作为 error 基线。

`npm run lint` 保留完整诊断，仍会因尚未偿还的历史错误退出失败。基线门禁成功只表示没有新增 error，不表示历史债务已经清零。安全边界中有意使用控制字符正则的地方保留校验，并用逐行注释说明规则例外，不能删除安全校验来满足 lint。

基线不得从 release 分支或当前 HEAD 自动重建以掩盖新增问题。更新基线需要单独审查：核对来源提交、锁定依赖和 ESLint 配置，在隔离的来源提交上运行 ESLint JSON 报告，再使用 `scripts/frontend-lint-baseline.cjs` 导出的 `fingerprint` 生成计数。减少债务后可删除对应基线记录；新增允许项必须有清楚的来源证据。

CI 执行全量基线门禁、附件保存文件的严格 lint 和 `scripts/tests/frontend-lint-baseline.test.cjs`。Docker 插件产物另由 `Docker Plugin Artifacts CI` 构建并运行最终镜像，不由 frontend lint 结果代替。
