# AI Migration Hub — 发布前隔离验收

日期：2026-10-29。分支 `codex/ai-migration-hub-v160`，产品源码基线 `a254635ab`。接续 [P0](ai-migration-hub-2026-10-29.md)、[P1](ai-migration-hub-phase1-2026-10-29.md)、[P2](ai-migration-hub-phase2-2026-10-29.md)。本轮新增可复用验收脚本、真实历史升级用例和证据，没有改动生产业务源码、用户数据库或已有客户端配置。

## 当前结论

| 门禁 | 本轮实际结果 | 仍未覆盖 |
|---|---|---|
| 真实 AI 宿主基础接入 | Claude Code CLI 2.1.187：生成配置、11 个迁移工具发现、能力调用在 stdio 和受保护 HTTP 均成功；无网关凭据返回 401 | 本地合成模型/Nowen API；不代表真实模型、文件迁移、Claude Desktop 或其他宿主 |
| 真实历史数据升级 | **2/2 通过，0 跳过**；实际 P0/P1 源码建库，再由当前无源码 bundle / tsc hardened 产物恢复 | macOS/Electron ABI 148，不是正式安装升级包 |
| Linux 完整服务与代理续传 | **通过**；512MiB/2 CPU、当前 tsc hardened 后端，经真实 HTTP 反向代理完成 104MiB 附件包、丢失 ACK 和两次 SIGKILL 恢复 | 复用 Linux glibc 运行时，不是新 Alpine 镜像；无 TLS/实体 NAS 网络；触及内存限制 |
| 真实对象服务 HTTP/磁盘 | S3rver 3.7.1：**5 通过、1 明确跳过**；8MiB/hash/Range、事务失败、取消、原 Token 撤回与补偿 | 该 daemon 不计算 SigV4 数学签名；不是 MinIO、云 S3/R2 验收 |
| 发布 | 所有测试均使用隔离合成资料，未推送、合并、签名或发布 | 仓库 app/backend 版本仍为 1.5.3；正式 v1.6.0 版本同步、CI、安装包和设备门禁未完成 |

以上证据分别关闭了基础连接、恢复和协议行为的部分缺口，**尚不满足正式 v1.6.0 发布验收**。不能把一个通过项目替代其余设备、来源格式、真实服务和用户库的验收。

## Claude Code 宿主

真实安装的 CLI 读取页面生成的配置，实际启动 Nowen launcher 或连接受保护网关，发现 11 个迁移工具，并把 `nowen_migration_capabilities` 的结果送回宿主。模型端仅为 loopback 合成 Anthropic 协议服务，两个 transport 各产生 3 次 Nowen GET，0 业务写入、0 真实模型调用。

macOS OS sandbox 只允许回环出站，并拒绝真实 `~/.claude`、`~/.claude.json` 和 `~/.codex`；临时配置、凭据与会话结束后清理。没有创建 Codex chat/thread 或修改原配置。Codex 在拒读现有配置的隔离条件下无法完成 bootstrap。WorkBuddy/Qoder 已在独立 profile 下实际启动并放入合成 MCP 配置，但分别因隔离协议初始化超时、没有可用 renderer 而未完成握手；不能据此推断登录要求或产品不兼容。豆包仅记录安装版本。

步骤、限制与复测命令见 [客户端记录](migration-hub-release-2026-10-29/client-acceptance.md)、[CLI 摘要](migration-hub-release-2026-10-29/client-claude.json)、[桌面启动探测](migration-hub-release-2026-10-29/client-desktop-probe.json) 和 [版本清单](migration-hub-release-2026-10-29/client-inventory.json)。

## 实际 P0/P1 数据升级

`migration-release-upgrade.test.ts` 用 `git archive` 读取实际历史提交，在临时目录运行历史源码创建持久化数据库及来源文件，再用当前无 `backend/src` 的产物启动：

- P0 `fb93d4932` / schema 142：提交 5/30 条后历史进程退出；当前 bundle 升到 schema 145 并恢复至 30/30，原 27 个待确认 Outbox 的 mutationId、payload、baseVersion 完整保留。
- P1 `3c486e395` / schema 145：保留已确认的 4MiB 分块；当前 tsc `index.hardened.js` 查询相同偏移，只补尾块。扫描后仍为 0 导入，PAT 审批 403，登录会话审批后笔记与 PDF 完成；原 5 个 Outbox 保留。
- 原笔记 ID、正文、版本不变；已成功 ID 保留；旧未审批任务没有自动写入；两类入口再次重启均无重复。

结果见 [upgrade.json](migration-hub-release-2026-10-29/upgrade.json) 与 [升级步骤](migration-hub-release-2026-10-29/upgrade.md)。新用例加入 DCC-003，矩阵为 12 个不变量 / 244 个引用。CI 运行此门禁需要完整历史中的 P0/P1 对象和当前 backend bundle；缺历史时用例明确 skip，不能据默认绿灯宣称已完成升级验收。

## Linux 完整后端、代理和崩溃恢复

使用本地 Linux/arm64 Node 24.22.1 生产依赖镜像 `c1f30777991a`，挂载当前 `tsc` 编译树并从 `index.hardened.js` 启动；镜像没有源码兜底。根文件系统只读，网络关闭，仅容器内回环通信；数据使用独立临时 Docker volume，结束后删除。容器总内存 512MiB、无 swap、2 CPU；验收主进程 old-space 96MiB，后端 192MiB。

实际验证链路：

1. 通过前缀 `/nowen/api` 的 HTTP 反向代理创建受限 Token 的迁移任务；跨用户访问被拒绝。
2. 流式生成 100 篇 Markdown、13 个各 8MiB 的随机 PDF；ZIP 为 109,102,247 字节。每块 4MiB，仅按服务端确认偏移前进。
3. 代理故意在首块已经落盘后断开响应，重试同块没有追加重复数据；上传 8MiB 后 SIGKILL 后端，重启后偏移仍为 8MiB。
4. 补传和整文件校验完成后，预览仍为 0 导入；PAT 审批拒绝，真实登录会话确认后开始导入。
5. 已导入 5 篇时再次 SIGKILL，重启恢复到 100 篇，先前成功 ID 保留，0 重复。逐篇 HTTP 读取正文、检查数据库版本，并经 Sync V2 blob HTTP 下载全部 109,051,904 字节，核对 13 个附件的大小和 SHA-256。

本次总耗时 **13.20s**，396 次代理请求、1 次丢失 ACK、2 次进程崩溃重启。`memory.peak` 为 **512.23MiB**，`memory.events` 中 max 1284、oom/oom_kill 均为 0。该内核计数表明触及限制并发生回收压力；不能宣称 512MiB NAS 有充分余量或已通过长期稳定性验收。进程 SIGKILL 也不能替代实体设备断电与存储硬件验证。

原始摘要与环境见 [deployment.json](migration-hub-release-2026-10-29/deployment.json)，可复用场景见 [`accept-migration-deployment.ts`](../../backend/scripts/accept-migration-deployment.ts)。重现时先将当前 backend 编译到隔离目录并复制两个 plugin runner；把该 dist 和外部依赖模式打包的场景脚本挂载到含匹配 Linux 原生模块的容器。在独立 volume `/qa` 中执行：

```sh
TMPDIR=/qa node --max-old-space-size=96 deployment.cjs /app/backend/dist /qa
```

本次 Docker 参数为 `--memory 512m --memory-swap 512m --cpus 2 --network none --read-only --tmpfs /tmp:rw,size=67108864`；`/qa` 是本次独占的可写 volume。fixture 只在新建子目录中创建数据。此记录不是 Dockerfile 的 Alpine/musl 全新构建、正式镜像或真实反向代理 TLS 配置验收。

## 对象服务与待补签名门禁

真实 S3-compatible daemon 完成 40 次 HTTP 操作：9 PUT、9 HEAD、14 GET、8 DELETE，其中 8 次 Range。8MiB 附件完整回读与哈希一致；已 PUT 后的数据库失败、取消与原 PAT 撤回均用真实 DELETE 补偿未提交对象，已提交对象仍可读取且哈希不变。未知 access key 返回认证拒绝，预览失败而不写入笔记。

MinIO 两个镜像源被当前 daemon 拒绝，官方 Linux 二进制返回 410。替代的 S3rver 不计算 V4 密钥签名，错误 secret 负例明确 skip，不能将其归为产品通过。测试可在具备签名验证的隔离服务上运行该负例；没有修改 daemon 或签名算法来制造通过。

见 [storage.md](migration-hub-release-2026-10-29/storage.md)、[storage.json](migration-hub-release-2026-10-29/storage.json) 和 [opt-in runner](../../scripts/migration-object-storage-acceptance.mjs)。默认没有显式 endpoint 时 6 个用例全部 skip，避免访问现有对象存储；这不是自动供应外部服务的默认 CI 门禁。

## 仍需完成

1. 实际 WorkBuddy、Qoder/QoderWork、豆包、Codex 的特定版本接入；Claude 的真实模型、授权文件准备与完整迁移流程。
2. 实体 Android/华为、Electron 安装升级、真实 NAS/代理/TLS 与生产数据；内存长稳、磁盘耗尽和物理断电。
3. 正确验证 SigV4 的真实 MinIO/云 S3 服务；当前模拟服务证据不替代它。
4. 版本同步、正式候选安装包/Alpine 镜像、对应 commit 的 CI、签名和发布。当前源码版本仍为 1.5.3，不能将其标为正式 v1.6.0 产物。

本轮未改产品源码，因此沿用 P2 构建与源码 Lint 结果；新增 TypeScript 场景脚本单独检查通过，两个 `.mjs` runner 语法检查通过。历史升级和对象存储集成测试实际执行结果分别列明，不将跳过计为通过。全仓既有 96 项生成文件 Lint 问题仍未处理。
