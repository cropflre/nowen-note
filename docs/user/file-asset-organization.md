# 文件标签与智能文件夹 / File tags and smart folders

Phase C 位于独立功能分支，尚未合并或发布。适用于连接同一服务端的 Web 和 Electron 网页界面；原生模式暂不可用。

Phase C is on a separate feature branch and has not been merged or released. It targets the server-backed Web/Electron interface; Native organization is unavailable.

## 标签 / Tags

打开文件详情，在「标签」中搜索已有标签并点击添加，或输入名称按 Enter 新建并添加。点击已关联标签可将它从当前文件移除。选择多个文件后，使用「批量标签」添加或移除某个标签，其他标签保持不变。侧栏支持搜索、重命名和删除标签；标签列表按需分页。

Open file details to find or create tags. Select multiple files and use Batch tags to add or remove a tag while preserving other associations. The sidebar supports paginated tag search, rename and delete.

个人标签属于当前账号；工作区标签属于该工作区，只有编辑者及以上角色可以管理。修改文件标签还要求具备该文件的管理权限，批量中任一文件无权限时整批拒绝。删除标签仅删除标签和关联，不删除文件或笔记引用。

Personal tags belong to the account; workspace tags are shared within that workspace. Editors can manage workspace tags, but applying tags also requires management permission on every selected file. A rejected batch leaves every file unchanged. Deleting a tag removes associations, not files or note references.

## 筛选与智能文件夹 / Filters and smart folders

侧栏点击标签可按标签浏览；「筛选」中可同时选择多个标签（全部匹配）、格式、大小、添加日期、可见笔记引用和相同内容文件。日期以设备的本地日历为准。列表继续使用分页和原有文件权限。

Browse by sidebar tag or combine tags (match all), format, size, local calendar dates, visible note references and identical content in Filters. File pagination and existing access rules remain authoritative.

点击「保存为智能文件夹」、输入名称并确认，即可保存当前文件分类、目录、搜索词和属性条件。「更新当前智能文件夹」保存当前调整；侧栏支持重命名和删除。智能文件夹是每个账号在当前空间里的私人保存搜索，不会实际移动或复制文件。「最近添加」保存为滚动的最近七天条件。

Save the current category, directory, search and attributes as a smart folder. Update saves adjustments; rename/delete are available in the sidebar. Smart folders are private saved searches per account and space. They never move or duplicate files. Recently added retains a rolling seven-day window.

## 相同内容与边界 / Identical content and limits

相同内容按已有 SHA-256 元数据识别，只展示当前空间里有权读取的记录；这是字节相同的文件，不是相似图片检索。旧文件缺少哈希时不会凭文件名猜测重复，也不会为了检测重复读取全部原图。不会自动合并、删除或移动重复记录。

Identical content uses existing SHA-256 metadata and exposes only readable records in the current space. It is not visual similarity search. Legacy files without a hash are not guessed from names, and original images are not downloaded for classification. No automatic merge or deletion occurs.

Native 的仅此设备模式和登录同步模式均未加入标签 / 智能文件夹的持久化与同步协议；此阶段会提示不可用，拒绝相关写入和筛选，不会悄悄改写个人库或远端数据。Web 网络失败时操作显示错误，不把尚未提交的修改显示为成功。文件夹完整同步、回收站、插入笔记与 AI 仍属于后续阶段。

Native device-only and signed-in modes do not yet persist/synchronize this metadata. They report unavailability and reject organization writes/filters without falling through to another store. Web network failures surface errors; uncommitted changes are not presented as saved. Complete folder sync, recycle bin, insertion and AI remain later phases.
