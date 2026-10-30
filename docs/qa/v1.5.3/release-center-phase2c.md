# NOWEN RELEASE CENTER · Phase 2C 独立桌面候选构建

日期：2026-10-17。开发目标分支 `release/v1.5.3`，PR [#864](https://github.com/cropflre/nowen-note/pull/864)。

## 为什么与正式发布分开

现有 `release.yml` 使用版本 Tag push 构建正式桌面资产；仓库的 iOS 工作流也会响应通用 Tag。这使得通过 Tag 测试桌面候选可能具有跨渠道的真实副作用。Phase 2C 改为另外一份仅 `workflow_dispatch` 的独立工作流，**绝不推 Tag、创建 Draft/Release、上传商店或触发 TestFlight**。

新构建的产物没有签名、没有公证、没有维护者审批，**不具备生产发布资格**，也不被现有 Phase 2B 的 Tag Run 导入器接管。不要使用调试构建、候选构建，替代带来源审批的正式包。

## 新增实现

| 模块 | 行为 |
| --- | --- |
| `.github/workflows/release-center-candidate.yml` | 只允许手动 dispatch；固定请求 UUID、完整 40 字符源码 SHA 和稳定版 X.Y.Z；只读仓库权限；串行同 ID 请求 |
| `validate` Job | 检查 UUID、SHA、版本格式；通过前不会 checkout 用户指定 SHA |
| `contracts` Job | checkout 固定 SHA，不持久化 Token；核对 Git HEAD、root/backend package 与 lockfile、Android versionName，运行旧发布/Store 隔离契约 |
| `build` Matrix | Windows Full+Lite、macOS x64/arm64、Linux x64；单平台失败不隐藏其他平台错误，全部使用 `--publish never`；不提供 Apple/签名或商店 secrets |
| `scripts/release-center-stage-candidate.mjs` | 从固定本地输出位置只提取目标平台的清单文件，验证非符号链接/大小、既有更新元数据、SHA-512 和文件 SHA-256；缺少任何必要文件立即失败 |
| Evidence | 各平台单独的 `candidate-evidence.json`，含运行 ID、attempt、UUID、源码 SHA、版本、文件哈希；`purpose=candidate-build-only`、`releaseEligible=false`、`signed=false` |
| 上传 | 候选包和证据以不同的 Actions artifacts 保存 7 天，不写 GitHub Release；不覆盖已有同名候选 staging |
| 页面 | 正式候选页提供该独立工作流的 GitHub Actions 导航与风险提示；不新增 API 派发或生产晋升 |

## 工作流使用前提

1. 先审核并将控制工作流文件注册至 GitHub 默认分支；候选 Commit 自身必须包含同版本 `release-center-stage-candidate.mjs`、构建和验证工具。
2. 源码版本文件必须全部匹配输入稳定版号（不能依赖工作流在 CI 内自动改版本）；不能使用正式发布 Tag 触发该测试。
3. 维护者在 Actions 页面输入随机 UUID、固定源码 SHA 和版本号，使用可信的工作流分支执行；工作流会从固定 SHA checkout 应用源码。
4. 下载候选包需比对分离的证据文件、Actions 产物 digest、固定来源 SHA 与 run/attempt。通过仅代表候选内容检查，不代表安装、签名或公证。

## 安全检查矩阵

- 工作流只有 `workflow_dispatch`，顶级权限仅 `contents:read`，没有 secrets、Shell 字段、任意 URL、Tag、Release、Docker/Store/NAS 或 TestFlight 操作。
- builder 每条命令均包含 `--publish never`，Windows 不能漏掉 Lite。
- Windows 必须有 Full+Lite 共 8 个必要文件，macOS 双架构至少 5 个，Linux 3 个；额外的合法 macOS blockmap 可包含在独立证据内。
- 无效 SHA/版本/UUID、缺少 Lite、更新元数据错链或 SHA 不一致不能生成成功候选；同路径再次执行禁止覆盖。
- 已发布的完整版本、Phase 2B 正式权限和渠道分发 API 完全不受本工作流影响。

## 验证记录与未完成项目

本阶段的本地夹具及 CI 测试 **不代替真实 Windows/macOS/Linux 候选构建验收**。测试只用标明不可安装的字符串模拟安装包，调用正式验证器检测文件、元数据和摘要；不能证明真实打包器生成的全部目标资产都通过验证。

尚未完成：
- 使用可信源码 SHA 手动 dispatch 的真实三平台 Actions 构建、产物下载和 SHA 交叉核对。
- 使用隔离测试仓库和独立凭据进行真实 GitHub Release Draft / 上传 / 发布 / 断网对账演练。当前还没有隔离仓库，不会写入 `cropflre/nowen-note` 的生产 Release。
- 真实 Windows/macOS/Linux 安装启动、Mac 签名/公证、Windows 安全提示与安装器签名的正式验收。
- 将经过上述验证的正式构建来源纳入 Phase 2B 的独立审批/发布链。在可信来源和签名门禁落实前，**保持正式发布开关关闭，不支持“候选直接晋升”**。

最终 GitHub CI 结果应以 PR #864 最新 Commit 上的实际 Run 为准。
