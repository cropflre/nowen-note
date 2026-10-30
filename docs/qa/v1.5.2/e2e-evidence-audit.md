# E2E 四层证据审计

等级分别为请求成功、UI 交互成功、数据落盘/回读成功、完整业务闭环。每项分开报告；HTTP 200 的业务 failures、ready token 和布局不越界都不能直接换成完整 PASS。

| 场景 | 请求层 | UI 层 | 落盘/回读 | 闭环判定 |
| --- | --- | --- | --- | --- |
| 登录 | 本轮 built hardened HTTP 两个临时账号实际登录 200，header spoof 401 | 浏览器表单 NOT_TESTED；LoginPage DOM 已确认地址显示 BUG-07 | 后端真实 JWT 用于后续请求；登录偏好跨重启未测 | 仅 API 登录链路通过，UI/账号历史持久化仍缺 |
| 编辑→自动保存 | 历史附件称通过，本轮未重跑编辑器 | NOT_TESTED | 未以本轮编辑器操作后查询 DB | 历史正文回读转述不可当作当前独立证据 |
| 全文搜索 | 历史附件称 API 命中 | 搜索框、过滤和打开结果 NOT_TESTED | 本轮未新增真实搜索实验 | UI 与业务闭环待测 |
| 标签 | 旧报告十组逻辑查询，原 E2E JSON 不在此处 | 本轮 EditorTagInputKeyboard 是 DOM 模型验证，不是浏览器完整页面 | 标签落盘/跨端传播本轮未测 | 不把逻辑过滤通过当作完整标签 E2E |
| 回收站 | 本轮直接路由软删/恢复 200，现有 trash-center 10/10 | 页面操作 NOT_TESTED | 软删保持正文，恢复 isTrashed=0；原 note-delete 去重与附件保护 7/7 | API/数据部分具备证据；页面端到端待测 |
| legacy DELETE | 真实授权 HTTP owner 200、other 403、无 JWT 401 | 通用删除 UI 未实测 | 正文/历史/独占附件/树移除，Outbox 墓碑，重开仍缺失 | **数据风险闭环已复现**；不是安全 PASS |
| Markdown 导出 | 本轮真实 HTTP 202→ready→下载 200 | 导出按钮/浏览器保存 NOT_TESTED | ZIP 3185 bytes、SHA256 和 content.md 内容实检；现有导出单测覆盖附件字节 | **实际下载+内容校验**已完成；重新导入、导入后编辑/附件重新打开 NOT_TESTED，因此完整往返未通过 |
| AI 面板 | 本轮未调用外部模型 | 旧双视口截图未提供；本轮无独立截图 | AI 正文替换与撤销保存未测 | 旧 rect 只能证明当时布局；流式生成、失败、键盘、替换闭环缺失 |
| Android 跨端同步 | 部分仓库历史模拟器 Bridge 记录 | 当前正式 App/真实编辑器 NOT_TESTED | 有明确历史 SHA、APK、网络边界，不能代替当前包 | 最终候选真机矩阵 NOT_TESTED；收尾设备已连接 |
| 备份升级恢复 | 本轮 encrypted-notes-upgrade 1/1、schema 122→123，受控全备份回放 | 备份/恢复页面 NOT_TESTED | 既有测试检查模拟正文、历史、附件、队列、第二次启动与旧版回滚 | 受控 fixture 闭环通过；大型备份、用户真实旧库、WebDAV/NAS 往返仍缺 |

本轮 ZIP 原文件见 `evidence/http-export.zip`，校验值见 `http-bundle-proof.json`。完整往返验收应保存：导出前语义摘要与附件 hash → 实际下载 → 空白隔离目标导入 → 重启 → 读取、打开附件、再次编辑 → 再次导出对比。Markdown/rich-text 表示应按语义而非无条件逐字比对；加密格式和权限边界另测。

历史报告的“闭环 6 项”“UI 缺口 4 项”缺少原始浏览器脚本、截图和 JSON，本轮不能独立核验其计数。“state=ready + downloadToken”只是产物可下载状态，第二轮将其称为完整导出闭环过强；已经在本轮明确分开。
