# 已有笔记加密：待发布说明 / Release draft

Web/桌面的个人 Markdown 与基础富文本笔记新增“更多 → 加密笔记”。系统自动检查来源、历史和未保存修改，在客户端加密并解密核验，以版本校验原地转换正文及全部历史，确认服务端密文并清理当前浏览器已保存的旧副本后显示锁定页。保留笔记 ID、目录位置、标题与标签。转换后可解锁、编辑、自动保存、改密码、查看历史及锁定；中断时可继续确认，尚未提交时可以取消并保留原数据。

首版不支持复杂内容、图片/附件/嵌入、已有加密区域、分享或工作空间笔记及同步 Profile。检查失败会说明原因，不会复制笔记、丢弃历史或覆盖未同步修改。历史恢复、统一隐私密码、完整普通编辑器能力及原生移动端仍待完成。逻辑清理不承诺物理擦除或追回旧备份、导出及其他设备的旧明文。此草稿不代表已发布或 Epic #796 已完成。

修复正常后台读写或编辑器关闭时的短暂占用误报，以及自动备份历史 ID 和旧版空富文本历史导致的加密拦截。转换保留原始历史内容、ID 和时间；其他窗口持续编辑时仍会阻止转换。

Personal Markdown and basic rich-text notes on Web/Desktop now offer **More → Encrypt note**. The client checks the source, history and pending changes, encrypts and verifies the content locally, converts the original note and all history with revision checks, confirms the server ciphertext and clears confirmed local copies. The note keeps its ID, location, title and tags. Unlocking, editing, autosave, password changes, history viewing and locking use isolated encrypted sessions. Interrupted conversions can resume; uncommitted conversions can be cancelled without deleting the source or local changes.

Complex content, images/attachments/embeds, existing encrypted regions, shared/workspace notes and servers with synchronization profiles remain unsupported. History restoration, a unified privacy password, full editor parity and native mobile support are still pending. Logical cleanup does not promise physical erasure or withdrawal of older backups, exports or copies on other devices. This draft does not claim a release or completion of Epic #796.

Fixed transient busy errors during background writes or editor teardown, and conversion failures caused by safety-snapshot IDs or legacy empty rich-text history. Original history content, IDs and timestamps are preserved; persistent editing in another window still blocks conversion.
