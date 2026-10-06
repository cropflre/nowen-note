# Encrypted Notes：内部 envelope v1

状态：M1 内部核心实现，M2 已接入实验性整篇文本编辑与密文持久化，见 [接入及验收记录](./encrypted-notes-m2.md)。跟踪 [Epic #796](https://github.com/cropflre/nowen-note/issues/796)，范围见 [Epic 设计](./encrypted-notes-epic.md)。本阶段不能宣称 #749 第 9 项完成。协议和参数为实验性内部格式，移动端实测前不冻结为对外格式。

## 密文格式

`frontend/src/lib/encryptedNotes/envelope.ts` 严格校验以下字段，拒绝未知字段、版本、算法、参数及非规范 base64。校验产生副本，调用方随后修改输入不影响异步操作。

```typescript
{
  version: 1,
  algorithm: "AES-256-GCM",
  objectId: "随机小写 UUID v4",
  kind: "note" | "block",
  originalFormat: "markdown" | "tiptap-json",
  kdf: {
    algorithm: "argon2id", version: 19,
    memoryKiB: 65536, iterations: 3, parallelism: 4,
    salt: "base64：16 字节随机盐"
  },
  wrappedKey: { iv: "base64：12 字节", ciphertext: "base64：48 字节" },
  payload: { iv: "base64：12 字节", ciphertext: "base64：正文密文及标签" }
}
```

随机 256 位正文密钥 DEK 加密正文；口令经 Argon2id 派生 32 字节 KEK，包装 DEK。AES-GCM 使用 128 位标签，`ciphertext` 末尾追加 16 字节标签，与 Web Crypto 返回格式一致。IV 每次随机生成，更新时避免复用当前正文 IV，包装与正文 IV 不同；历史碰撞风险由安全随机数控制，不维护历史 nonce 表。

正文最多 4 MiB UTF-8，可为空；口令为 1–1024 字节 UTF-8。保留空格、BOM 和 Unicode 形式，不 trim/normalize，拒绝不成对 UTF-16 代理项。M2 产品入口要求创建/新口令至少 6 个字符并二次确认；解锁保留核心已有格式兼容。核心只处理字符串，Tiptap JSON schema 由接入层验证。

AAD 是以下数组经 `JSON.stringify` 序列化后的 UTF-8，无 BOM 或额外空格：

```text
["nowen-encrypted-content",1,"AES-256-GCM","key",objectId,kind,originalFormat]
["nowen-encrypted-content",1,"AES-256-GCM","content",objectId,kind,originalFormat]
```

`key` 认证 DEK 包装，`content` 认证正文。调用方须提供可信文档上下文的 `expected` 身份，不能直接信任传入 envelope。身份替换、类型/格式更改及认证失败均拒绝。M2 API/数据库提供外层对象身份与原格式不可变校验、修订/CAS；核心与服务端不提供对离线数据库替换或合法历史密文回滚的密码学检测承诺。

## 操作、失败与生命周期

应用调用 `workerClient.ts` 的 `runEncryptedContentOperation`，不得在主线程直接调用 `crypto.ts`。操作为 `create`、`decrypt`、`update`、`change-passphrase`；后三种须提供原 envelope、口令和 expected 身份。

- 更新先认证原正文，再以同一 DEK 和新 IV 加密；原 envelope 不变，失败不返回替代密文。
- 改口令先认证包装和正文，以新盐、新 KEK 包装原 DEK，正文密文不变。旧备份仍用旧口令；不能撤销泄露的 DEK 或旧副本，需要另做完整 DEK 轮换。
- 错误口令/认证失败为 `unlock-failed`，格式错误为 `invalid`，能力/WASM/Worker 失败为 `unavailable`，取消为 `aborted`，并发为 `busy`。错误不含口令、正文或原生错误细节。
- 每次操作创建独立 Worker，一次只运行一个任务。成功、失败、取消或 30 秒超时均终止 Worker。无主线程、弱算法或服务端兜底，超时不降低参数。
- 生产 Web 要求安全上下文；Electron、Capacitor 和各端 CSP 仍须验证。WASM 执行环境应允许相应编译，不应放开任意脚本执行。

可控口令字节、派生密钥、DEK 和正文缓冲区尽力清零，AES CryptoKey 不可导出。JS 字符串、结构化克隆和引擎内存不能保证物理擦除；M2 锁定/切号时须释放正文、口令、编辑器、撤销栈和会话。核心不建立解锁会话，不读写本地存储、HTTP 或数据库。

## 依赖、参数与待验收范围

固定 `hash-wasm@4.12.0`（MIT），WASM 随包内嵌，无运行时 CDN。候选 profile 使用 RFC 9106 的 64 MiB、3 次、4 lanes；parallelism 为算法 lanes，不代表 4 个 Worker。只接受此完整 profile，拒绝任意内存/KDF 参数。

**M0 未完成：** 需在 Android/iOS 真机与目标 Web/Electron 版本测量耗时、峰值内存、挂起/取消及能力失败。桌面通过、移动视口或单次计时不能代替真机验收。正式参数若改变，发布前更新协议、向量和兼容策略，不静默降级。

## 可重复验收

在 `frontend` 运行：

```sh
npm run test:encrypted-notes
npx playwright install chromium
npm run test:encrypted-notes:browser
```

Vitest 覆盖独立向量、AES 互操作、Unicode/BOM、随机性、更新/改口令、篡改、身份替换、参数/长度上限与 Worker 生命周期。浏览器测试独立构建真实 Worker，在 CSP 下使用 Web Crypto 与 WASM 执行相同向量，覆盖 Worker 销毁、取消重试、认证失败、无 Worker 拒绝和核心不写本地存储。M2 新增编辑/密文持久化验收见接入记录。CI 为 `Encrypted Notes CI`。

本地验收（2026-10-01）：37 项 Vitest、6 项 Chromium 153 浏览器测试、应用及验收页 TypeScript 检查、应用生产构建通过。Electron 33.0.0 / Chromium 130.0.6723.44 以 sandbox、contextIsolation 开启且 nodeIntegration 关闭的窗口运行独立验收页，核心自检通过；五种操作总耗时约 105–206 ms。这验证了内核执行能力，不代表产品内持久化、安装包 CSP 或移动端已完成验收。新 CI 已配置，尚未在远端运行。

独立向量使用 Node 原生 Argon2 与 OpenSSL AES-GCM，不依赖被测 WASM：

```sh
# 仓库根目录，Node >= 24.7；固定公开样例，无真实笔记或用户口令
node scripts/generate-encrypted-notes-vector.mjs
git diff -- frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json
```

人工验收：运行 `npm run build:encrypted-notes-benchmark` 和 `npm run preview:encrypted-notes-benchmark`，访问 `http://127.0.0.1:5176/benchmarks/encrypted-notes.html`。只使用公开测试数据；计时包含 Worker 启动/KDF，不能视为峰值内存或纯 KDF 基准。

M2 整篇加密接入及未闭环验收见 [M2 记录](./encrypted-notes-m2.md)，覆盖独立文档类型、受控编辑器、对象身份绑定、SQLite/PostgreSQL、自动保存/Yjs/队列隔离、版本/同步/备份密文路径，以及搜索、AI、分享、插件和旧客户端写入阻断。M3 才能交付局部节点/围栏。附件、元数据、旧明文及口令丢失按 Epic 处理。当前没有数据转换入口。

## 规范

- [RFC 9106](https://www.rfc-editor.org/rfc/rfc9106)：Argon2id。
- [Web Crypto AES-GCM](https://www.w3.org/TR/webcrypto/#aes-gcm)：IV、AAD、标签与密文布局。
- [hash-wasm](https://github.com/Daninet/hash-wasm)：实现与 API。
- [Node 原生 Argon2](https://nodejs.org/api/crypto.html#cryptoargon2syncalgorithm-parameters)：独立向量。
