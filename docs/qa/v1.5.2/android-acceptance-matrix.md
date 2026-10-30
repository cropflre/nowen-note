# Android 最终候选真机验收矩阵

> 后续已执行独立 QA APK 的 Native/API Bridge 真机验收，见 [第三阶段状态映射](stage3/android-status.md)。下文 NOT_TESTED 是第二阶段记录；完整 GUI/跨端矩阵仍未全部通过。

状态：**本轮全部 NOT_TESTED，未执行当前正式候选 APK 真机验收**。初始 ADB 为空；收尾 PJZ110 已连接，只读查询正式包 versionName=1.5.1，另有历史验收包。没有安装或运行能证明来自目标 SHA 的候选包，不能再用无设备解释门禁。不得用后端、Vitest、构建、设备连接成功或历史模拟器 API Bridge 结果填 PASS。本轮仅执行设备/包名/版本只读查询，未访问私人笔记、启动/强杀或修改已安装 App。证据见 evidence/android-device-state.json。

已有证据应保留：`docs/test-results/sync-v2-android-2026-10-11.json` 与 native-tree 系列记录为 API 35 模拟器、`com.nowen.note.syncacceptance` 测试入口，限定源 SHA/APK。原记录自己明确没有完整 EditorPane、真实附件字节、生产 JWT 或真实 WAN 覆盖；一些后续新增保护更晚于其 APK。它们可以帮助设计复测，不是本矩阵执行结果。

前置条件：确定最终 SHA，构建正式候选 APK，记录 SHA256、package/version、系统/WebView、设备型号；准备 Web、Electron 两个独立客户端和隔离服务器，两套临时账号、测试库及附件目录。确认设备原有账号/队列不受影响；使用独立测试安装或受控测试账号，不清空真实资料。所有设备/服务端须能证明实际网络隔离状态。

每项保留录屏/步骤时间、客户端与服务端日志、数据库/队列快照、正文语义摘要和附件 SHA256；密码/JWT 不放日志。验证“本地已保存”“当前编辑云端已确认”“第二设备收到”三个不同状态。

| 编号 | 真实操作步骤 | 成功标准与必留证据 | 本轮 |
| --- | --- | --- | --- |
| A01 | 登录隔离账号，在根目录及普通文件夹新建 Markdown，关闭并重开 | 相同 noteId/父节点，正文可读，UI 无“笔记不存在” | NOT_TESTED |
| A02 | 新建富文本，含列表/表格/代码，关闭 App 再开 | 格式、正文、父链完整，记录 Native 库 | NOT_TESTED |
| A03 | 断网新建/编辑上述两种笔记后立即返回列表再打开 | 正文立即可读，本地保存与 pending 状态正确 | NOT_TESTED |
| A04 | 断网编辑后 force-stop/重启 | 已确认本地提交的正文和 mutationId 均保留；不能只验内存页面 | NOT_TESTED |
| B01 | Android 创建→Web/Electron 自动出现 | 三端同一身份、正文与树位置相同，服务端 version/ACK 证据 | NOT_TESTED |
| B02 | Web 编辑→Android→Electron；再反向操作 | 双向版本与正文一致，无重复实体 | NOT_TESTED |
| B03 | Android ACK 等待期间继续编辑 | 旧 ACK 不把新修改显示为确认，后续 baseVersion 接续 | NOT_TESTED |
| B04 | 自身 echo、丢通知、丢 ACK 后重连 | 不覆盖新草稿，不重复新建，最终出队和当前收据正确 | NOT_TESTED |
| B05 | 持续 30 轮双向编辑 | 无崩溃，记录每轮提交/ACK/回读与 P50/P95/P99 | NOT_TESTED |
| C01 | A/B 离线修改同一版本，按相反顺序联网 | 明确冲突，双方内容可读，不静默覆盖 | NOT_TESTED |
| C02 | 分别选择保留本地/远端，期间再编辑 | 正确版本基础，新编辑保留，冲突记录与队列一致 | NOT_TESTED |
| C03 | 一端永久删除，另一端持有离线正文 | 明确删除冲突/可另存；旧身份不能悄悄复活；导出保留稿 | NOT_TESTED |
| C04 | Push 收到服务端提交后、ACK 落盘前强杀 | 重试同 mutationId 幂等，重开不会损失正文或造重复 | NOT_TESTED |
| C05 | Snapshot/首次订阅途中断网/强杀再启动 | 恢复游标与 pending 先后正确，不误删本地新实体 | NOT_TESTED |
| D01 | 离线文件夹嵌套创建、移动、排序，重启再联网 | 稳定 parentId/顺序，依赖有序重放，不循环父链 | NOT_TESTED |
| D02 | 文件夹软删/恢复，其他端同时改子树 | 正文与删除批次保留，冲突可处理，无隐式复活 | NOT_TESTED |
| D03 | protected/shared/restricted 目录读写、撤权后重开 | 后端和 Native 共同 fail closed，不凭缓存 bypass 密码/ACL | NOT_TESTED |
| D04 | 图片、PDF、视频上传→等待 metadata ACK→另一端下载 | 元数据及二进制 hash 都一致；元数据确认不误报附件完成 | NOT_TESTED |
| D05 | 已缓存附件离线打开；未缓存附件离线打开 | 缓存字节可读；缺字节明确可恢复状态，无空白假成功 | NOT_TESTED |
| D06 | 删除共享去重附件笔记与恢复软删笔记 | 仍被引用字节不丢失；软删恢复正文及附件 hash 正确 | NOT_TESTED |
| E01 | 服务器停机/重启、Wi-Fi/移动网络/域名/局域网切换 | 不把网络失败报密码错误；重试恢复队列与当前收据 | NOT_TESTED |
| E02 | 在途请求切账号、再切回；同地址另一身份 | 旧 ACK/正文不能写入新账号，队列按身份隔离 | NOT_TESTED |
| E03 | 切服务器/本地模式再返回 | 本地空间、未同步修改与 Profile 上下文可追溯，不清库补救 | NOT_TESTED |
| E04 | 浏览器/桌面与手机同时编辑、回收站操作，长期后台再前台 | 三端最终回读与冲突符合预期，logcat 无致命崩溃 | NOT_TESTED |
| F01 | 手机真实键盘、旋转、标签焦点、返回列表上下文 | 控件可点击、焦点和返回位置保留，不把 jsdom 当实机通过 | NOT_TESTED |
| F02 | AI 流式生成、失败重试、替换正文、撤销与保存后重开 | 键盘不遮挡，替换目标正确，无草稿丢失，记录实际服务响应 | NOT_TESTED |
| F03 | 从旧正式包升级到同 SHA 候选包 | 旧正文、附件、账号偏好、队列完整；不卸载清资料后再宣称升级成功 | NOT_TESTED |

任何正文/附件丢失、跨账号泄漏、权限绕过、闪退或当前收据误报，应单独开缺陷并维持 NO-GO。修复后在最终包重测受影响路径；设备执行者必须记录实际结果，不能把这张步骤表当完成证据。
