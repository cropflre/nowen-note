# Migration Hub 历史数据库升级与产物入口验收

日期：2026-10-29。候选源码：`a254635abf70f4cbec61270f0cd907a6274da2d6`。实测环境：macOS 27.2.0 / arm64，Electron 43.8.4，Node v24.22.1，SQLite 原生 ABI 148。2 项通过，0 失败、0 跳过；机器可读结果见 [upgrade.json](upgrade.json)。

## 实际场景与结果

| 历史输入 | 当前入口 | 验证结果 |
|---|---|---|
| 实际 P0 `fb93d4932639c3967b883e416b1233b8b65198b0` 源码创建 schema 142 的磁盘数据库；30 篇已审批任务在提交 5 篇后进程退出；另有现存用户笔记与未审批预览 | 当前 `backend/dist/index.js` 单文件 bundle，复制到不含 `backend/src` 的隔离产物目录后启动 | 自动升级到 145 并恢复至 30/30；原 5 个目标笔记 ID 保留；原用户笔记 ID、标题、正文和 version=7 不变；原 27 个未确认 mutation 的 ID、payload 和 baseVersion 全部保留 |
| 实际 P1 `3c486e395f54101f7b4eb825f62d5f937776063f` 源码创建 schema 145 的磁盘数据库；ZIP 来源含 Markdown 与 4MiB+ PDF，OPEN 会话已确认首个 4MiB 分块后退出 | 当前源码隔离 `tsc` 编译树的 `index.hardened.js`（Docker 使用的入口形态），目录不含 `backend/src` | 查询原 OPEN 会话得到 offset=4,194,304，只发送尾块并完成全文件校验/扫描；扫描后仍为 0 导入；PAT 审批 403，真实测试登录会话审批后导入 1 篇与 PDF；原用户笔记及 5 个 Outbox mutation 完整保留 |

两场景再次停止/启动同一产物，任务仍为 COMPLETED，笔记数不增加。另一个历史 PREVIEW_READY 任务始终为 0 导入，PAT 无法将其批准。测试没有把文件已接收、扫描完毕或进程重启当作人工审批，也没有清空本地数据或 Outbox。适用 DCC-002/003/006/008 的持久化、恢复和审批边界。

旧状态由 `git archive` 导出的真实历史 `backend/src` 经独立进程运行产生，不是将当前 Schema 手动删列或只执行内存 DDL。依赖复用当前安装的兼容模块，未重建或更换用户依赖的 ABI。原进程在已提交记录之间退出，测试不声称模拟物理断电或存储损坏。

## 复测

```sh
cd backend
npm run build
ELECTRON_RUN_AS_NODE=1 ../node_modules/.bin/electron --import tsx --test --test-concurrency=1 tests/migration-release-upgrade.test.ts
```

测试自动创建并删除独立临时源码、数据库、上传分块和产物目录，不访问默认 `data/` 或生产数据库；HTTP 只使用随机本机测试端口与合成账户。历史 Snapshot、源 ZIP、Token 与会话只存在于测试临时目录，结果文件不包含凭据或正文。

需要本地保留上述 P0/P1 git 对象；CI 应完整获取这两个提交，缺少历史时测试会明确跳过，不能据此将升级门禁标为通过。bundle 场景要求先执行当前 backend build，避免使用遗留产物；tsc 场景自行编译到临时目录，不改仓库 `dist`。Linux/Docker 的原生依赖、真实 NAS、反向代理、签名安装包和物理设备由其他门禁独立验收；本记录仅证明 macOS 运行时中两种实际产物入口的上述行为。
