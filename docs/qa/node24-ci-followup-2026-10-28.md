# Node 24 CI 回归修复（2026-10-28）

基线为 `57241d40`。该提交的 17 个远端工作流最终有 15 个通过，失败项为 Encrypted Notes CI 和 Extension Platform V2.1。

## SQLite 加密防护

本机复现了旧 Native 触发器的两项失败：非法明文更新会从未受保护的 `json_extract` 返回 `malformed JSON`，未进入预期的 `INVALID_ENCRYPTED_NOTE` 拒绝路径。其他 `OR` 条件不能保证这些 JSON 读取不被执行。

- 服务端新增迁移 v139，仅修复已安装的笔记更新与历史记录触发器；保留转换、解密许可及原有规则，不重写已发布迁移。
- Native 更新根身份比较的 CASE 防护，并从 schema 12 升到 13，确保已有数据库重新安装触发器。CASE 的惰性求值依据见 [SQLite 表达式文档](https://www.sqlite.org/lang_expr.html#the_case_expression)。
- 新增真实 SQLite 文件重开测试：非法 JSON 和降级写入仍被拒绝，笔记、历史与 Outbox 保持原样；Native 迁移中途失败则回滚触发器和 schema 版本。
- 对应 DCC-008 / DCC-012，测试映射已更新。没有清空数据库或队列，也没有放宽密文验证。

本地通过：前后端完整构建、CI 存储夹具严格类型检查、280 项加密功能测试、25 项 Native 初始化与迁移测试。与失败 CI 对应的存储、转换、升级、同步、备份回归通过；其中关键的七组回归还在普通 Node 24 下通过，本机依赖随后恢复为 Electron ARM64 ABI。

## 扩展依赖安装

失败日志为 `ECONNRESET`，重跑后仍停在 SDK 的 `npm ci`。SDK 和 CLI 锁文件分别包含 1 个、93 个固定的腾讯镜像下载地址。

仅将这 94 个地址切换到 npm 官方 registry，版本和 integrity 不变。TypeScript 5.9.3 的官方元数据校验值与锁文件相同。本地 SDK / CLI 清洁安装、SDK 合约测试和 CLI 帮助入口检查通过。

## 发布边界

上述是隔离临时数据上的本地结果。服务端 v139 / Native schema 13 会推进数据库版本，旧版程序应按已有前向版本检查拒绝打开；需要回退时使用升级前备份。对应修复提交的远端 CI、签名安装包和真实设备升级仍需分别验收，不能以旧提交或本机结果替代。
