# 相似图片与批量重命名 / Visual organization

Phase D4 开发分支功能，尚未合并或发布。需要配套更新服务端与前端。

## 查找相似图片

在文件中心打开图片详情，选择「查找相似图片」，也可从图片的更多菜单进入。
结果按色彩和画面布局的近似程度排列，点击结果复用已有文件详情、下载和移动功能。
每次检查 20 张图片，按「继续检查下一批」扩大范围；界面区分正在检查、部分扫描和本次扫描完成，
并显示已检查及跳过数量。关闭弹窗取消当前浏览器请求。

搜索只检查当前账号、当前个人空间或工作区内**有下载权限且未在回收站**的图片。
支持 PNG、JPEG、WebP、GIF 首帧和 BMP 解码候选，单张最多 20 MiB、4000 万像素。
损坏、过大、原文件不可读或解码器不支持的图片会跳过；源图片无法读取时直接报错。
旧服务端没有接口时会报错，不返回模拟结果。

这是一种局部布局和色彩比较，适合辅助查找缩放、重新编码的图片；不是语义搜索，
可能误匹配同版式素材，也可能漏掉裁剪、旋转或颜色变化很大的图片。
没有声明识别准确率，不替代人工判断，也不会自动合并、删除、移动文件。
「相同内容文件」仍沿用原有字节哈希判定，与视觉近似分开展示。
没有上传到 AI 服务，没有建立持久化图片特征索引。

## 批量重命名

1. 选择当前页内自己可管理的文件，点击「批量重命名」。
2. 输入统一名称和起始编号，查看逐项预览。
3. 确认后整批保存；每个文件保留原扩展名，附件 ID、原文件、原下载地址及笔记引用不变。

单次最多 200 项（文件中心当前页为 60 项）。若任意文件已改名、被移入回收站、跨空间或无管理权限，
整批不修改；刷新预览后再次确认。数据库或 Outbox 写入失败也会整批回滚。
已启用桌面同步时，沿用原附件 metadata mutation；保存成功只表示当前服务端/本机后端提交，
不证明第二台设备已应用。Web 网络失败保留预览并显示错误，不把失败冒充排队成功。

## 平台边界

本阶段验证 Web 浏览器和 SQLite 后端。Native 的相似图片搜索、批量重命名明确不可用，
不会回退访问服务器或偷偷改写本地表。窄屏截图是 Web 响应式证据，不是移动真机验收。
安装版桌面、生产 S3、PostgreSQL 和真实断网恢复仍需单独验收；没有新增数据库迁移或同步协议。

## English

These Phase D4 features are on a development branch, not merged or released. Update both frontend and backend.

Open an image's details or context menu and choose **Find similar images**. Search checks 20 authorized,
downloadable, active images per batch in the current space. Continue manually to scan more; counts distinguish
partial coverage, skipped files and completion. Results reopen existing file details. Closing cancels the browser request.

The server compares 64 layout differences and average color locally. PNG, JPEG, WebP, GIF first frames and BMP
are decode candidates, limited to 20 MiB / 40 megapixels each. Unsupported, damaged or unreadable candidates
are skipped. This can find resized or re-encoded images, but can confuse similar layouts and miss crops or major
changes. It is not semantic search, has no claimed accuracy and never merges or deletes files. Existing identical-file
discovery still uses byte hashes. No external AI calls, persistent feature index or migration is added.

Select manageable files, choose **Batch rename**, enter a common name and start number, review and confirm.
Original extensions, IDs, URLs, bytes and references remain stable. The operation checks original names and permissions
and rolls back the whole batch, including existing attachment Outbox capture, on failure. Refresh the preview after
a conflict. A successful backend commit does not prove another device has received it; Web network failure remains
an error with the preview retained.

Native explicitly rejects both operations. Responsive Web evidence is not device acceptance. Installed Electron,
real mobile devices, production S3/PostgreSQL and physical network-loss recovery remain untested.
