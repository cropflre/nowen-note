# HEIC / HEIF 兼容预览

Issue #761 的目标是让手机上传的 HEIC / HEIF 图片可以在 Web、桌面端和连接服务器的 Android 客户端显示，同时保留原始照片。

## 附件接口

- `POST /api/attachments` 和 `POST /api/files/upload` 检查 ISO BMFF `ftyp` 品牌，补全 HEIC / HEIF MIME。扩展名不作为上传格式识别依据，AVIF 不会被当成 HEIC。
- `GET /api/attachments/:id` 对 HEIC / HEIF 返回 `image/webp` 兼容预览。已有笔记里的图片 URL 不需要迁移。
- `GET /api/attachments/:id?w=240|480|960` 从兼容预览生成 WebP 缩略图。
- `GET /api/attachments/:id?download=1` 返回原始文件、原始 MIME 和下载文件名。需要原件字节的 API 调用方必须带此参数。

预览、各尺寸缩略图、原件各有独立 ETag。签名、分享撤销、禁止下载等权限检查保持在读取缓存和转码之前。Sync v2 的 blob 接口与备份仍读取原件。

## 生成与缓存

使用 `libheif-js` 自带的 WASM 解码 HEVC，再由 sharp 编码 WebP；不依赖宿主系统安装 HEIF 扩展或额外命令行工具。Docker 使用 npm 依赖，桌面完整包包含解码器和 sharp 的运行时依赖。

解码在工作线程中执行，串行处理大照片，同一附件的并发请求复用同一生成任务。首帧/主图尺寸限制为 6400 万像素，单次解码超时为 60 秒。预览保留完整尺寸，WebP 质量为 90；序列图片展示主图。

兼容副本位于 `attachments/.thumbs/<id>_preview.webp`，缩略图沿用 `<id>_w<width>.webp`。删除附件或修复原件时复用现有缩略图清理流程，不修改原始 HEIC 内容。远程对象同样支持按需转码和本地缓存。

存量空 MIME / `application/octet-stream` 附件，或带 `.heic` / `.heif` 文件名的附件，在首次访问时检查字节并修正 MIME，无需重新上传。已有普通附件链接保留原有正文形式，打开链接可获得兼容预览。

解码失败返回 `422 HEIF_PREVIEW_FAILED`，用户仍可下载原件。此能力由服务器提供；原生移动端仅本地离线存储的 HEIF 解码不在本次修复范围内。

## 回归验证

`backend/tests/attachment-heif.test.ts` 使用真实 HEIC 文件验证上传分类、字节识别、主图解码、原件下载、缩略图、存量兼容、远程缓存、分享权限、损坏图片和缓存清理。原有 `attachment-cache-contract.test.ts` 验证普通图片的 ETag 和远程缩略图回退。
