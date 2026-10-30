# 基线与证据可信度

本轮目标是远端 `release/v1.5.2`，开始及收尾 `git ls-remote` 均得到 `99dbdef9fa160ccce0f66aa0489dc964a28bc6cd`。GitHub 上的 [aa49e2fb 提交](https://github.com/cropflre/nowen-note/commit/aa49e2fbac85d2d4477275b6a44bec6f336db2b9) 也能访问。

主工作区位于 `C:/Users/cropf/Desktop/UGits/nowen-note`，HEAD 是 `bf1052992d5b2a8f11cfe4ad82bd054bf72e7b6e`，是目标的祖先，并非比远端新的候选版本。开始已有六个跟踪文件修改和四个未跟踪测试文件，均未纳入本轮检出或修改。报告仅新增在主工作区的 `docs/qa/v1.5.2/`，未提交到 GitHub。

实际复测检出：`C:/Users/cropf/.codex/worktrees/release-152-qa-review/nowen-note`，detached HEAD 固定为目标完整 SHA。受测跟踪文件没有修改；临时测试配置/诊断文件均以 `.qa-` 命名，验证后清理。初次创建因目标对象未获取而失败，fetch 后创建成功；没有 reset、stash、覆盖现有业务改动。

`aa49e2fb → 99dbdef9` 只改了自动化 CI、eventPublisher、runtime、workflowRunner 和对应测试共五个文件。前端源码相同只证明代码文本未变，不能证明历史执行环境、依赖、负载、测试初始化相同。本轮已在新 SHA 重跑 `automation-platform`，4/4 通过。旧 337/342、3608/3622 仍只能标为**附件报告宣称，原日志不可独立核验**，不得改标签为本轮全量通过。

环境：Windows；系统 Node v20.20.2 / ABI 115；后端使用仓库 Electron 的 Node v20.18.0 / ABI 130。现有 better-sqlite3 为 ABI 130，系统 Node 创建数据库会报 ABI 不匹配，不能用该错误证明业务缺陷。

隔离检出通过 junction 复用现有依赖，没有执行 npm install、重编译共享原生模块或改锁文件。按目标 lock 与安装快照核对：已安装包无版本差异；后端 50、前端 63 个未安装 lock 条目均带 optional 标记，非 optional 缺项为 0，详见 `baseline.json`。这不是一份从零 npm ci 安装的证明。FFmpeg 二进制存在、可执行，版本 6.1.1，其 SHA256 为 `04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00`。

数据库、附件和链接攻击样本全部位于新建的 `nowen-release152-audit-*` 临时目录。直接 Hono harness 只测试路由/服务和模拟 `X-User-Id`；之后又运行真正的 hardened 生产 bundle，在隔离库上通过实际登录、JWT、HTTP 请求补证公开入口。未使用用户私人笔记。

本轮没有正式 Windows 安装包、Docker 运行环境或浏览器 E2E 原始产物。初始 ADB 没有设备；收尾时 PJZ110 已连接，只读查询显示正式包 versionName=1.5.1，另有 syncacceptance/acceptance821 包。没有安装或运行能证明来自当前 SHA 的候选包，因此 Android 最终包验收为 NOT_TESTED，不再以无设备作为 BLOCKED 理由。版本清单和状态变化见 `android-device-state.json` 及相关日志。仓库已有 Android 2026-10-11 记录属于明确 SHA/APK 的 API 35 模拟器和 Native Bridge 验证，不能改写成当前 SHA 正式 APK 的完整真机/编辑器验收。

信任顺序：本轮可复跑脚本与原始结果 → 固定 SHA 源码及 Git 差异 → 有明确边界的仓库历史验收记录 → 附件中的历史报告转述。不存在的旧日志不补造。
