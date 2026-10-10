# Extension Ecosystem V2 RC1 设计规格

## 目标

在不继续扩展插件功能面的前提下，完成 Extension Ecosystem V2 的全部 P0 与 P1 生产收口，使未知社区插件不能绕过 Runtime、网络、权限和供应链边界，并使插件更新、回滚、Registry、Marketplace、遥测与离线行为具备明确且可恢复的生产语义。

## 范围与约束

- 仅实现已确认的 P0 与 P1：Runtime Security、Network Sandbox、Policy、Host API Contract、更新原子性、Rollback/Probation、Registry Trust Root、防降级、Security Advisory、Registry 生产化、对象存储/CDN/镜像、Telemetry、Marketplace Offline、V1/V2 兼容。
- 不增加新的 Host API、UI Extension、商业插件、支付或更复杂 Workflow。
- 不编写或执行测试用例。完成后只进行 TypeScript 编译、构建、配置/schema 校验和启动级检查。
- 外部 S3/CDN/OAuth/DDoS 服务不在本地仓库内实际部署；仓库提供完整适配层、配置校验、失败语义和部署入口，不声称外部资源已上线。
- 保持 API V1 `node-action` 兼容；Marketplace Community V2 只允许 `sandbox-js`。

## 总体实施策略

采用安全门禁分阶段落地。每个阶段形成独立边界，后续阶段只能消费前一阶段公开合同，避免在 RC 阶段继续扩大功能面。

```text
Untrusted Package
      │
      ▼
Manifest / Policy / Trust Verification
      │
      ▼
Sandbox Supervisor ── Child Process ── QuickJS Runtime
      │                         │
      │ structured IPC         │ no Node bridge
      ▼                         ▼
Host API Contract ─────── Permission / ACL / Budgets
      │
      ├── Canonical Business Commands
      └── Secure External Fetch

Registry Metadata
      │
      ▼
Embedded Trust Root → Rotation → Sequence / Expiry → Advisory
      │
      ▼
Atomic Stage → Preflight → Probation → Stable / Rollback
```

## P0 设计

### 1. Runtime Security

社区 Sandbox 不再与主后端共享故障域。新增 Sandbox Supervisor 与独立子进程协议：主进程负责权限、Host API 和生命周期，子进程只负责 QuickJS 执行。每次执行使用唯一 execution ID，IPC 只允许声明过的消息类型，未知消息和超限消息立即终止子进程。

执行预算包括：64MB QuickJS heap、512KB stack、deadline interrupt、1,000 次 Host Call、输入/输出字节上限、单次 Host Call 参数/结果上限、进度消息上限和待处理 Promise/Host Call 上限。取消、超时、子进程退出、QuickJS/WASM 异常均映射为稳定错误码；主后端只回收该执行，不退出。

Sandbox 全局对象采用白名单初始化。`process`、`require`、`module`、`Buffer`、`fetch`、`WebSocket`、`XMLHttpRequest` 和 Node 模块不通过任何桥暴露。`eval`、`Function` 和插件内部动态计算仍受同一 QuickJS 预算约束；动态模块加载不提供 loader，因此不能访问外部模块。

### 2. Network Sandbox

`external.fetch` 统一进入 Secure External Fetch，不直接调用全局 `fetch`。请求只允许 Manifest 白名单中的 HTTPS host，禁止 URL userinfo、非标准端口（除非白名单明确声明）、无效 IDN、裸私网地址和可疑编码。

每次请求和每个重定向跳点都重新执行：URL 规范化、host 白名单匹配、CNAME/A/AAAA 解析、完整保留地址判断。覆盖 IPv4 私网、loopback、link-local、CGNAT、benchmark/documentation/multicast/reserved 地址，IPv6 loopback、ULA、link-local、multicast、documentation，以及 IPv4-mapped IPv6。

连接使用校验后的地址集合并固定本次连接解析结果，避免校验后再次 DNS 解析造成 rebinding。自动重定向关闭，最多允许有限跳数；每跳重新校验。响应正文按流读取并受字节预算约束，超时或超限立即中止。

### 3. Policy 与 Runtime 语义

默认策略保持 Official、Verified、Community 可安装，但 Marketplace Community V2 强制 `sandbox-js`。`node-action` 仅允许 API V1 兼容、Official/Verified 策略许可，或手动可信安装时经过显式二次确认；Registry Community 永远不能通过全局 `allowNodeRuntime` 绕过该限制。

策略拒绝返回稳定错误码和可审计原因。Restore 来源恢复为 quarantine，不继承 Node Runtime 信任和权限。

### 4. Host API Contract

建立唯一 `HOST_API_CONTRACT`，记录 method、版本、permission、runtime 可见性、参数预算和结果预算。Backend Broker 路由、Runtime Capabilities、Sandbox `nowen` bridge、Plugin SDK 类型和文档清单都从该合同派生或由构建脚本生成。

未在合同中的方法统一返回 `HOST_METHOD_NOT_FOUND`；Manifest 声明但合同不存在的 permission/capability 在安装阶段拒绝。`attachments:write` 在没有真实 write method 时不得作为可用能力暴露，避免 Manifest、SDK 与 Broker 不一致。

### 5. 原子更新与崩溃恢复

插件更新使用不可变版本目录和持久化操作日志：`downloaded → verified → staged → preflight → switching → probation → stable`。数据库不再只记录当前目录，而是记录 active version、previous stable version、operation ID 和状态。

下载和解压只写 staging；完成校验后将版本目录原子 rename 到不可变位置。切换使用数据库事务更新 active version。启动时恢复器读取操作日志：未完成 staging 可安全丢弃；目录已就绪但 DB 未切换则保留旧 active；DB 已切换但目录缺失则回退 previous stable。任意时刻至少有一个已验证版本可运行。

### 6. Probation / Rollback 状态机

使用枚举状态代替松散字段组合：`installed`、`preflight`、`probation`、`stable`、`rollback_pending`、`rolling_back`、`disabled`。状态转换集中在一个服务中，并在同一事务内维护 current、previous、probation remaining 和 rollback reason。

新版本通过 preflight 后进入固定 Action 次数的 probation。执行失败进入 `rollback_pending`，恢复器执行回滚并回到 previous stable；回滚失败进入 `disabled`，不能继续运行不一致版本。状态读取时发现非法组合将 fail closed 并交由恢复器处理。

### 7. Registry Trust Root 与轮换

Official Registry 根公钥以内置常量随客户端发布，不从 Registry 响应获取。根密钥记录 key ID、算法、有效期和状态。新根密钥必须由当前可信根签名，并满足生效窗口；客户端保存已接受的根链，撤销只允许签名后的前向变更。

自定义 Registry 继续使用管理员显式配置的 pinned public key，不自动继承 Official Root。

### 8. 防降级与元数据时效

Registry V2 签名文档增加 `sequence`、`generatedAt`、`expiresAt`。客户端按 Registry source 持久化 `highestSeenSequence` 和最后有效时间。sequence 下降、文档过期、生成时间超前异常或同 sequence 内容变化全部拒绝；离线时只能使用此前验证且未超过离线宽限窗口的缓存。

版本安装继续拒绝无授权 downgrade；显式 rollback 只允许本地保留且曾验证成功的版本。

### 9. Security Advisory

Advisory 由受信 Registry 签名并包含唯一 ID、sequence、发布时间、过期时间、严重级别、版本范围和 action。客户端按 sequence 防重放并保存处理记录。

- `critical` 且签名有效：自动禁用命中版本。
- `high`：警告并建议禁用，不自动禁用。
- `medium`：警告。
- `low`：信息提示。

签名无效、过期、sequence 回退或来源不可信的 Advisory 不产生状态变更。撤回必须由更高 sequence 的签名 Advisory 表达；Registry 离线时维持最后一个有效安全状态，不接受镜像提供的未验证降级。

## P1 设计

### 10. Registry Server 生产化

Registry 使用持久化数据库迁移，不依赖进程内状态。安全中间件覆盖：严格 CORS、安全响应头、请求体大小、全局/IP/账户/Publisher 分层限流、发布冷却与配额、OAuth state/PKCE、HttpOnly Secure SameSite Session、CSRF token、Session rotation 和撤销。

Publisher 发布执行 artifact 大小、版本不可变、签名、key 状态和静态扫描门禁。Review、Report、Advisory、Publisher 管理和管理员动作进入不可变审计日志。管理员敏感操作要求 TOTP 2FA。日志默认脱敏 token、cookie、secret 和 artifact 内容，并提供反向代理可信 IP 配置。DDoS 由部署层承担，应用暴露健康检查、限流响应和代理配置边界。

### 11. Artifact Storage、CDN 与镜像

定义 ArtifactStore 接口，提供本地开发实现和 S3 兼容生产实现。生产上传采用临时对象、校验 digest 后提交到内容寻址 key；数据库只保存对象 key、SHA-256、签名、大小和 immutable 状态。

下载 URL 可通过 CDN base URL 生成。镜像只复制同一 artifact bytes 和已签名 metadata，不拥有新的信任身份；客户端无论使用哪个镜像都验证相同 SHA-256、Publisher Signature 和 Registry Metadata。镜像失败可切换，但不能降低 sequence 或签名要求。

### 12. Telemetry Privacy

Telemetry 默认采用匿名聚合且允许设置关闭。客户端只允许固定 schema：extension ID、version、platform、event type、error code 和时间桶。任意额外字段、Action input/output、Workflow payload、笔记/附件标识或文本、Secret 都在入队前拒绝。

队列设置容量、TTL、批大小和退避；关闭后停止采集并清空未上传队列。Registry 同样执行字段白名单和大小限制，不能信任客户端已经过滤。

### 13. Marketplace Offline

Marketplace 网络状态不得参与 Nowen 启动、编辑、已安装插件执行或 Automation 启动。Catalog 使用已签名缓存；Registry 不可用时 Marketplace 显示离线状态并读取仍在有效窗口内的缓存。

安装和更新在离线时明确失败，不改变当前插件状态。安全状态使用最后一次有效 Advisory；缓存过期时禁止新安装/更新，但不停止无命中有效 kill switch 的已安装插件。

### 14. V1 / V2 兼容

Runtime 选择形成显式矩阵：API V1 只走兼容 `node-action`；API V2 Community 只走 `sandbox-js`；API V2 Official/Verified Node 受策略控制；不兼容版本、撤销 key、命中 critical advisory 或合同版本不支持时 fail closed。

现有 V1 Manifest、权限记录和运行入口不迁移为 V2，也不被 V2 默认策略误禁用。新的 V2 数据字段均允许旧记录为空，并由读取层映射到 V1 兼容语义。

## 数据与迁移

新增单一后向兼容迁移，包含更新操作日志、正式生命周期状态、Registry sequence/root chain、Advisory 处理记录、审计日志、OAuth/Session、Artifact metadata 和 Telemetry consent。迁移只增加表或列，不删除 V1 数据；SQLite 与 PostgreSQL 使用同一逻辑约束。

迁移完成后由恢复器处理旧的 `probationVersion` 等字段并映射到新状态。映射无法证明一致时进入 quarantine/disabled，而不是猜测 active version。

## 错误处理与可观测性

所有安全拒绝使用稳定错误码，日志包含 execution/plugin/source/operation correlation，但不记录插件输入、Host API payload、Secret、token 或用户内容。Sandbox 子进程退出、网络拒绝、签名失败、sequence 回退、原子切换恢复和 rollback 都产生结构化安全事件。

Registry 健康检查区分数据库、对象存储和签名能力；Marketplace 调用失败不会被提升为核心服务不健康。

## 验收标准

- 未知社区 V2 插件只能在独立 Sandbox 故障域运行，资源攻击不会结束主后端进程。
- `external.fetch` 在 DNS、CNAME、重定向和地址表示变体下都不能访问本机、私网、link-local 或 metadata。
- Host API、SDK、Capabilities 和文档来自同一合同，不再出现声明但不可调用的能力。
- 任意更新中断后，恢复结果只能是旧稳定版、新验证版或安全禁用，不能出现 DB 与目录错配。
- Official Registry 信任起点来自客户端内置根，签名元数据不能降级或重放。
- Advisory 只有有效签名和合法 sequence 才能改变插件状态，并按严重级别执行动作。
- Registry 具备持久化、安全会话、发布门禁、限流、审计和管理员 2FA 边界。
- Artifact 可使用 S3 兼容存储、CDN 和镜像，且所有路径保持同一内容信任链。
- Telemetry 严格白名单且可关闭；Marketplace 离线不影响核心功能和已安装插件。
- V1 插件保持兼容，V2 插件按 runtime/trust/compatibility/advisory 明确分流。
- TypeScript 编译、构建、配置/schema 校验和启动级检查通过；不新增或运行测试用例。
