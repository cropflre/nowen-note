# 一键发版严格预检实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在一键发版开始前验证所需登录状态，并在外部发布前确认远端分支未变化，避免产生半发布状态。

**架构：** `scripts/release.sh` 增加只读预检函数，按实际目标检查 Git、Docker 与 GitHub CLI。构建完成后、Docker 推送和 tag 创建前复用 Git 远端基线校验；发现远端变化立即退出。静态 Node 测试固定这些关键调用顺序。

**技术栈：** Bash、Node.js 内置 test runner、Git、Docker CLI、GitHub CLI。

---

### 任务 1：预检回归测试

**文件：**
- 修改：`scripts/release-linux-app.test.mjs`
- 测试：`scripts/release-linux-app.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
test("release.sh performs strict authentication and final remote checks", () => {
  assert.match(source, /preflight_release_environment\(\)/);
  assert.match(source, /docker info/);
  assert.match(source, /gh auth status/);
  assert.match(source, /verify_release_remote_baseline\(\)/);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test scripts/release-linux-app.test.mjs`

预期：FAIL，缺少预检函数。

- [ ] **步骤 3：实现最少预检代码**

在 `release.sh` 添加函数：记录发布开始时的 `origin/<branch>` SHA，检查 Git dry-run 推送、Docker 认证配置及 `gh auth status`/`GH_TOKEN`；在发布动作前 fetch 后对比 SHA。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test scripts/release-linux-app.test.mjs`

预期：PASS。

### 任务 2：发布前接线与验证

**文件：**
- 修改：`scripts/release.sh`
- 测试：`scripts/release-linux-app.test.mjs`

- [ ] **步骤 1：把预检接入发布模式**

在版本与发布计划确认后、构建前调用 `preflight_release_environment`，且仅在实际会推送的目标上检查对应凭证。

- [ ] **步骤 2：把远端基线复核接入外部动作前**

在统一 Docker 推送与 Git tag 区段前调用 `verify_release_remote_baseline`，并在不含 Docker 的发布中同样在 tag 前调用。

- [ ] **步骤 3：运行完整回归验证**

运行：`node --test scripts/release-linux-app.test.mjs && bash -n scripts/release.sh`

预期：全部通过。
