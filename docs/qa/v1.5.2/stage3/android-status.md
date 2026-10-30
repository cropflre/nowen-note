# Android 设备验收状态

设备 PJZ110 / Android 15，串号 3B1F5GE5MS12B4GT。独立 debug package `com.nowen.note.qa152` / `1.5.2-qa.98d1ddf5`，无操作正式 App 私人笔记或清资料。最新证据 `evidence/device-release-r2/android-native.json`；实际 Native SQLite、生产 API Bridge 与 MobileSyncEngine，隔离 loopback fixture server 和新测试身份。服务器使用真实登录 token 库，但不是完整生产 JWT middleware；测试界面不是 EditorPane。

| 原矩阵项目 | 本阶段证据 | 完整门禁 |
| --- | --- | --- |
| A01/A02/A03/A04 | 两种正文离线创建/修改、立即 API 读取、force-stop 后持久读取；root/folder Native 创建 | PARTIAL：真机编辑器复杂格式及 UI 仍需执行 |
| B01/B02/B05 | 实机↔HTTP fixture 30 轮，内容和当前收据确认；upload/download 延迟分位数有记录 | PARTIAL：Web/Electron 两个真实客户端和 GUI 未代验 |
| B03/B04 | 丢通知轮询与重连；本地编辑收据及状态检查 | PARTIAL：迟到/丢 ACK、新编辑在途未完整注入 |
| C01/C02 | 知识树移动冲突和 keep-local Native conflict service | PARTIAL：正文双方可读、keep-remote、ConflictCenter GUI 未验 |
| C03/C04/C05 | 本轮没有完整永久删除冲突、提交后 ACK 前强杀、首次快照强杀 | NOT_EXECUTED；Sync delete 独立入口 P1 OPEN |
| D01/D02 | 离线嵌套文件夹、新笔记、移动排序、mutationId 重启保留；文件夹子树软删恢复，子正文保留 | PARTIAL：其他端同时编辑子树、GUI 仍缺 |
| D03/D04/D05/D06 | 不用源测试或 HTTP ZIP 回读代验设备 ACL 和附件 | NOT_EXECUTED 完整真机矩阵 |
| E01/E02/E03/E04 | 移除 adb reverse 确认离线；重连自动推送 | PARTIAL / NOT_EXECUTED：WAN、移动网络、在途切身份和完整三端长期后台仍缺 |
| F01/F02/F03 | QA APK 构建、独立安装并升级 QA 包；浏览器窄视口有单独记录 | NOT_EXECUTED：原正式包升级、真机键盘/旋转/上下文、AI 实际写回 |

额外负例：调用真实 Bridge 的永久删除活动笔记，返回 NOTE_NOT_TRASHED；正文、收据及 Outbox 比较不变，随后离线/重启/同步全部通过。

首次最终 APK 测试复用了同一 Native 账号，却换成新空服务器库，收到 2 个冲突并停止，记录于 `device-release/`；旧 Native 数据和 Outbox 保留。重跑新 fixture identity 后通过全部现有 driver，不将第一次失败抹除或将真实冲突冒充 ACK。

这里的 PARTIAL 没有填充成原 27 项全部 PASS。正式候选、设备环境、账号/服务器身份、录屏或 UI 断言、正文摘要、附件 hashes、版本/ACK 与日志必须在完整矩阵中分别补齐。
