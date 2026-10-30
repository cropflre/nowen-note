# 文件回收站 / File recycle bin

开发分支功能，尚未发布。文件中心侧栏 → **文件回收站**。
普通删除会保留原始文件、附件 ID 和标签。正在被笔记使用或有有效分享的文件会受到保护，请先处理引用或关闭分享。
选中文件可以恢复；原文件夹不存在时恢复到“未归档”。恢复不自动重新开放公开外链。
永久删除需要单独确认，并再次检查权限、引用和分享。它无法从回收站撤销；存储清理失败会明确提示。
文件不会自动过期。永久删除来源笔记前，请先恢复或永久删除其文件回收站内容。
Native 模式暂不支持回收站，请在服务器网页端管理。真机与生产 S3/PostgreSQL 尚未验收。
升级前备份数据库和附件目录；回滚请恢复匹配的数据库与附件快照，不能只换回旧程序。

Development branch, not released. Open **File recycle bin** from the file center sidebar.
Normal deletion retains original bytes, attachment IDs and tags. Files referenced by notes or active shares are protected.
Restore returns files to their original folder, or Unorganized if it was removed. Public links stay disabled until explicitly enabled again.
Permanent deletion requires confirmation and fresh permission/reference/share checks. Storage cleanup failure is reported; purge cannot be undone from the bin.
Files do not expire automatically. Restore or purge retained file entries before permanently deleting their source note.
Native mode is unsupported; use the server web app. Real devices and production S3/PostgreSQL have not been accepted.
Before upgrading, back up the database and attachments; rollback requires restoring their matching snapshot, not just an old binary.
