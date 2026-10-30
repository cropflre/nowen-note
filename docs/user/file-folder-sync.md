# 附件目录多端同步 / Attachment directory sync

本功能正在独立分支验收，尚未发布。实现与测试范围见 [D3 验收记录](../qa/files-assets-center-v2/phase-d-folder-sync.md)。

在支持此能力的新版服务器和客户端上，个人文件夹的创建、改名、移动、删除空文件夹，以及文件的目录位置可以同步。原附件 ID、笔记引用和文件内容保持不变。

1. 先连接服务器并完成首次同步，再在文件中心整理个人文件夹。
2. 首次同步完成后可以离线整理；修改会保存在本机并等待上传。登录失效或网络失败时，修改保留并可重试。
3. 两端同时修改同一目录或文件位置时，在同步设置的冲突中心逐项核对，再选择保留本机或云端版本。另一方保留在冲突历史中。
4. 已删除的目录不会因旧设备重连自动复活。需要重新建立目录时，请新建目录，再移动文件。

旧服务器尚未支持、首次同步未完成时，登录模式会拒绝目录写入。仅此设备模式仍保留本机目录功能。目录删除只允许空目录，不会连带删除文件。

目前限个人目录和 SQLite 同步链路。工作区目录、标签及智能文件夹同步、原生端文件回收站操作尚未支持。相似图片搜索和 AI 整理不在本模块内。真实设备与生产部署仍待验收。

---

This feature is under acceptance on a separate branch and has not been released. See the [D3 validation record](../qa/files-assets-center-v2/phase-d-folder-sync.md).

Compatible servers and clients synchronize personal folder creation, renaming, movement, empty-folder deletion and file locations. Attachment IDs, note references and file contents are preserved.

Connect and finish the first synchronization before organizing signed-in folders. Later offline changes remain on the device and in the retry queue. Network or login failures retain those changes. Concurrent edits appear individually in the conflict center; choose the local or server position after reviewing both versions. The other version remains in history. Deleted folders cannot be revived by an old device; create a new folder if needed.

Older servers and incomplete initial synchronization reject signed-in directory writes. Device-only folders remain local. Only empty folders can be deleted. This module covers personal directories on SQLite; workspace directories, tag/smart-folder sync, Native file recycle-bin mutations, similar-image search and AI organization are outside its scope. Device and production acceptance remain outstanding.
