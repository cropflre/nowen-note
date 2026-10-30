# v1.5.2 第二轮质量复核

> 后续修复与实际验收见 [第三阶段报告](stage3/README.md)，被测最终代码 `98d1ddf5`；当前仍 NO-GO。下文是第二轮 `99dbdef9` 的历史复核档案，保留原始失败与当时结论。

结论：**NO-GO · 正式发版**。可以继续内部测试和修复验证。

日期：2026-10-12（Asia/Shanghai）。被测源码：`99dbdef9fa160ccce0f66aa0489dc964a28bc6cd`。本轮不修改业务源码，不合并、不发布、不提交或推送。

- [发版门禁](release-readiness.md)
- [缺陷与建议](bugs.md)
- [真实执行结果](test-results.md) / [机器可读结果](test-results.json)
- [前端历史失败逐项复核](frontend-failure-review.md)
- [四层 E2E 证据审计](e2e-evidence-audit.md)
- [Android 真机验收矩阵](android-acceptance-matrix.md)
- [基线和证据可信度](baseline-and-evidence.md)
- [覆盖缺口](coverage-gap.md)
- [功能与风险追踪](feature-inventory.md)
- [计划](test-plan.md) / [用例](test-cases.md)
- [证据清单和 SHA256](evidence-manifest.json) / [复跑脚本](scripts/)

用户提供的五份文本按原字节保存在 `evidence/input-1.txt` 至 `input-5.txt`。这些是历史报告转述，**不是原始 Vitest、TAP、浏览器日志**。原报告宣称的 `docs/qa/v1.5.2/`、四份测试日志和 E2E JSON 在本地及被测 Git 树中均未找到，因此本目录是重新建立的独立复核档案，不能称为恢复了旧报告的全部证据。

所有 `*-setup-failure*.log/json` 是本轮诊断脚本调试失败，保留以便追溯；没有计入产品测试失败或通过数。脚本中的观察断言通过，例如成功观察到永久删除或外部文件读取，表示**缺陷行为得到复现**，不表示产品安全门禁通过。
