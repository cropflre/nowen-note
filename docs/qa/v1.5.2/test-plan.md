# 第二轮质量复核计划与完成边界

原则：不改业务代码，不改原失败断言，不合并/发布；隔离数据；每条判断绑定 SHA 和证据。执行范围是用户列出的十项复核，优先处理现有失败，不重新铺开数千用例。

| 用户任务 | 本轮执行与验证 | 交付 |
| --- | --- | --- |
| 1 确认最新 HEAD 和适用性 | 开始/结束 ls-remote；fetch；独立固定检出；aa49→99db 差异 | baseline-and-evidence.md / baseline.json |
| 2 删除风险 | direct harness + 真实 hardened bundle 登录/JWT HTTP；正文/历史/附件/树/outbox/重开/恢复；调用方兼容分析 | bugs.md BUG-02 / boundary-audit.json / http-bundle-proof.json |
| 3 Windows Plugin Studio | 原测试复跑；lstat、两种 symlink、junction、硬链接、ZIP import/export、受控 check/open 插桩 | bugs.md BUG-06；没有把未证实历史原因定为环境 |
| 4 前端14失败 | 9 原文件独立复跑，4 旧称偶发文件三轮；生产 i18n 对照；登录地址探针 | frontend-failure-review.md；crypto 历史具体用例名保留 UNKNOWN |
| 5 后端5非PASS三环境 | 原文件22/22、正常bundle真实HTTP；读取正式包依赖规则 | test-results.md 三环境表；正式安装包 NOT_TESTED |
| 6 i18n/错误码 | 合并资源渲染8/8纠偏；临时db捕获NOTNULL/PRIMARYKEY | BUG-01 撤销线上误诊；BUG-03 原异常类型已确认 |
| 7 E2E | 四层证据审计；实际下载并解包ZIP；既有导出8/8 | e2e-evidence-audit.md；UI/再导入/AI 缺口保留 |
| 8 Android | 初始ADB为空，收尾PJZ110连接；只读查询正式包1.5.1；核查模拟器证据边界；编写27项最终真机步骤 | android-acceptance-matrix.md，全部 NOT_TESTED；未证明/执行同SHA最终包 |
| 9 统计矛盾 | 重算2+6+6；区分文件/用例/Bug/轮次/覆盖率；拒绝全功能100% | test-results.md / test-results.json |
| 10 报告归档 | 旧目录未找到，重新建立全部报告；原附件及本轮原始证据保留、SHA256清单 | README.md / evidence-manifest.json |

可复跑入口（传入固定 SHA 干净检出与新的 evidence 输出目录，避免覆盖原始结果）：

```powershell
node docs/qa/v1.5.2/scripts/run-review.mjs <checkout> frontend <evidence>
node docs/qa/v1.5.2/scripts/launch-electron.mjs <electron.exe> docs/qa/v1.5.2/scripts/run-review.mjs <checkout> backend <evidence>
node docs/qa/v1.5.2/scripts/launch-electron.mjs <electron.exe> --import <tsx/dist/loader.mjs> docs/qa/v1.5.2/scripts/audit-boundaries.mjs <checkout> <boundary.json>
node docs/qa/v1.5.2/scripts/launch-electron.mjs <electron.exe> --import <tsx/dist/loader.mjs> docs/qa/v1.5.2/scripts/http-bundle-proof.mjs <checkout> <boundary.json> <http.json>
```

先在 `<checkout>/backend` 构建 `node build.bundle.mjs` 才运行 bundle proof。后端需正确 SQLite ABI；launcher 会转换 Windows --import 为 file URL，并等待 GUI executable 子进程结束，避免 PowerShell 提前返回造成错误完成判断。run-review 的 backend 复用仓库逐文件隔离和 120s 超时；`QA_BACKEND_FILES` 可限定重跑文件。

prepare-i18n-proof / prepare-address-proof 只向独立检出写 `.qa-` 测试和配置，不修改业务源码。用 `.qa-i18n.config.ts` / `.qa-address.config.ts` 分别运行 Vitest。额外初始化/观察的结果不能覆盖原失败结果。

原套件仍失败，本轮复核完成不等于修复完成。已具备执行能力的项目已执行；需要正式包/真机/Linux/外部模型/原历史日志的工作明确列为缺口，不假通过。
