# Nowen Release Center · Phase 2B 完整发布闭环模拟验收

日期：2026-10-17  
开发分支：`codex/release-center-phase2b-lifecycle-20261017`  
目标：`release/v1.5.3`  
PR：[ #863 ](https://github.com/cropflre/nowen-note/pull/863)  
GitHub Actions：[ Release Center CI #39038677240 ](https://github.com/cropflre/nowen-note/actions/runs/39038677240)

## 实施内容

新增 `tools/release-center/tests/publication-lifecycle.test.ts`，扩展独立的 `formal-safety` CI。

所有 GitHub 方法在测试子类中**本地覆盖**；没有实际 GitHub Release、Tag、Draft、Upload、Publish API 写入，没有使用 GitHub 正式发布 Token、Store、Docker、NAS 或 iOS 凭据。

构造三平台真实 ZIP 结构，内部仅为明显不能安装的固定文本夹具：

| 平台 | 文件 | 检查 |
| --- | --- | --- |
| Windows Full / Lite | 8 | setup / portable / blockmap、latest.yml 与 latest-lite.yml 分离，大小、SHA-512、逐文件 SHA-256 |
| macOS Intel / Apple Silicon | 5 | 两架构 DMG / ZIP，latest-mac.yml、更新摘要、大小和 SHA-256 |
| Linux x64 | 3 | AppImage / deb、latest-linux.yml、嵌入 blockmap 字段、摘要与大小 |

直接调用生产使用的 `verifyArchive` 和正式目录校验代码，而不是将任意测试布尔值伪装成产物校验成功。

## 安全回归

1. 成功路径：固定 Tag + Commit / 通过关键检查的源 Run → 校验全部 3 个 archive / 16 个文件 → 创建唯一 Draft → 上传 16 个文件 → 核实远端摘要后审批 → 再次确认正式发布；断言 Draft POST 与 Publish PATCH 各一次。
2. Draft 请求已生效、网络响应丢失：留下持久化写入意图，重启后通过 GET 对账恢复，不再发送 POST。
3. 产物上传已生效、网络响应丢失：使用远端文件 digest 对账，不重复上传同名文件。
4. Publish 请求已生效、网络响应丢失：重启后通过 GET 核实正式状态，不重复 PATCH。
5. 审批完成后远端任一资产 SHA 被篡改：拒绝发布，PATCH 次数为零，Draft 保留。
6. 同一套工具既有安全门禁仍检查身份、同源请求、幂等、互斥、取消、非法数据、来源混淆、超时、未知结果只读对账。

## 2026-10-17 CI 实测

- 独立 `formal-safety` Job：**23/23 通过，失败 0**。
- 控制台 `npm test`：**122/122 通过，失败 0**。
- TypeScript 检查和 Vite 生产构建：**通过**。
- Chromium 浏览器：**9/9 通过**，包含新增正式候选页面安全及窄屏暗色检查。
- 两个 CI Job `console-contracts` 与 `formal-safety`：**均 success**。以上均为 [Run #39038677240](https://github.com/cropflre/nowen-note/actions/runs/39038677240) 的真实执行结果。

## 浏览器竞态测试稳定性修复

复核过程中捕获一次已有渠道页面用例的偶发失败：断言依赖瞬时 `role=status` 加载提示，网络较快时提示会在断言执行前消失。改为 Playwright 在页面开始时明确拦截旧版本查询、阻塞旧响应，先切换并观察新版本，再释放旧响应并等待其返回，确保旧结果不会覆盖新选择。最新 CI 该项与其余 8 项 Chromium 测试全部通过。

## 不可冒充的验收边界

本轮证明的是**隔离 GitHub API 夹具条件下的流程和文件校验行为**，不等于生产 GitHub API、权限、签名/公证、真实应用安装、商店审核通过，也没有验证并发外部发布者或真实 GitHub Actions artifact 的端到端正确性。

**继续保持** `NOWEN_RELEASE_DRAFTS=0` / `NOWEN_RELEASE_PUBLISH=0`，不得把本轮通过视为开启正式写权限的充分依据。正式平台联调前，需要准备与生产隔离的测试仓库、单独临时凭据、完整签名检查、失败回滚操作手册及维护者明确确认；不得使用生产版本 Tag 做联调。

## 下一阶段

1. 在受控测试仓库进行一次真实 GitHub API 的 Draft / 资产上传 / 摘要复核 / 发布 / 断网恢复验证。
2. 补齐正式打包工作流，不依赖现有 Tag push / iOS TestFlight 副作用。
3. 对 Windows/macOS/Linux 的签名、公证、安装/启动进行真机/虚拟机验收。
4. 保留独立的 Microsoft Store、Docker 和 NAS 分发审批、内容校验与回执，绝不复用 GitHub Release 审批自动授权其他平台。
