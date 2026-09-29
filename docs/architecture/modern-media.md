# 手机照片兼容链路（Issue #761）

## 原件与派生资源

上传、文件管理、Sync V2 二进制上传共用 `analyzeModernMedia`。根据字节识别
JPEG/PNG/HEIF、QuickTime/MP4，并读取手机照片的媒体元数据。原件仍保存在
`attachments`，同步和下载均保持原始字节；预览不会覆盖原件。

`attachment_media_variants`（迁移 v113）按 `(sourceAttachmentId, kind)` 保存：

| kind | 内容 |
| --- | --- |
| analysis | 解析版本、类型、Apple 媒体 UUID 或内嵌视频偏移 |
| original-motion | 同一笔记内配对的 Apple MOV/MP4 原件附件 ID |
| preview-webp | HEIF 的兼容静态预览缓存路径 |
| motion-mp4 | H.264/AAC 动态预览缓存路径及来源关系 |

普通 JPEG 的原图即封面，不重复创建静态副本。HEIF 继续使用现有 WebP 和 `?w=`
缩略图链路。动态预览位于 `.thumbs/<sourceId>_motion_<companionId|embedded>.mp4`，
只在请求播放时生成；并发请求合并，转码串行执行。缓存删除后可从原件恢复。

## 支持的动态资产

- Apple Live Photo：读取照片 Apple MakerNote 0x11，以及视频 QuickTime
  `com.apple.quicktime.content.identifier`。UUID 必须相同，且附件必须属于同一
  笔记、上传者和空间。文件名不作为自动配对依据。
- Google/Pixel Motion Photo：支持当前 XMP Container 的末尾 MotionPhoto 项、
  历史 MicroVideoOffset，以及 HEIF 的末尾 `mpvd` 容器。遵守明确的
  `MotionPhoto=0`；验证偏移、长度及视频容器边界。
- Samsung：读取 SEFH/SEFT 的 0x0a30 MotionPhoto_Data，支持直接视频数据和
  `mpv2` 的绝对偏移/长度。其它厂商兼容以上结构时可复用；未识别结构只展示照片。

照片选择器可同时选择多张照片及 MOV。先保存 MOV，再保存照片，正文只插入照片。
已有照片及 MOV 首次读取媒体信息时分析并关联，不要求重新上传。若导出工具删除了
媒体 UUID，无法可靠配对：显示“LIVE · 缺少配对视频”，保留两份原件，避免错误关联。

## 访问契约

所有请求使用源照片的原有签名、Bearer 或文件分享凭证，先鉴权再解析或读取缓存。

| 请求 | 行为 |
| --- | --- |
| `GET /api/attachments/:id` | 静态封面；HEIF 返回 WebP |
| `?w=240/480/960` | 静态缩略图 |
| `?media=info` | 类型、hasMotion、motionStatus、hasMotionOriginal、canDownloadOriginal |
| `?variant=motion&inline=1` | 兼容 MP4，支持单段 Range/If-Range 和独立 ETag |
| `?download=1` | 原照片，包括 Motion Photo 内嵌视频的完整原始文件 |
| `?variant=motion-original&download=1` | 配对的 Apple 原视频，保留原始字节 |

禁止下载的分享仍可看封面和播放兼容预览，不能下载照片或配对原视频。
MP4 不可生成时返回 422/MEDIA_PREVIEW_FAILED；封面和原件接口继续可用。

## 播放与原生端

编辑器、Markdown、全屏图片查看器及文件管理复用 `MotionPhotoOverlay`。
默认只显示照片；接近视口时查询类型，点 LIVE/Motion 才请求动态内容，播放结束
回到封面。默认静音以兼容移动浏览器自动播放策略；视频保留 AAC 音轨，播放器
可开启声音。播放失败显示明确提示，静态转换失败则提供原件下载入口。

Android Local-first 读取本地 HEIF 时，原生 BitmapFactory 按需生成最多 2048px
JPEG 封面，不修改原件。封面和原件 URL 分开，下载仍指向原件。动态派生请求
绕过原照片的本地 Blob/文件缓存，已同步且在线时访问服务端；HTTP 视频沿用
原生 AttachmentMedia 缓存，并区分原视频与 motion 表示。

纯设备本地模式、未完成同步或离线时不具备服务端转码能力；无法解析的设备保留
原件并展示下载降级。厂商解码器可用性及 iOS/Android 真机行为需实际设备验收，
不能用自动化通过代替所有设备验收。

## 生命周期与备份

源附件删除会级联清理派生关系，并删除对应静态/动态缓存。配对 MOV 是用户上传的
独立原件：只清理关系和派生 MP4，不擅自删除仍可单独使用的 MOV。正文仍引用照片
时，孤儿清理把配对 MOV 视为间接引用；两份原件均不再引用时按原有规则回收。
完整备份保存数据库关系和附件目录；恢复后缺失的预览可重新生成。Sync V2 不传输
派生缓存，接收端根据原件重建分析及配对关系。

## 转码运行时与限制

Web/Docker 使用系统 FFmpeg（Docker 安装 `ffmpeg` 并设置
`FFMPEG_PATH=/usr/bin/ffmpeg`）；Electron 保留 `ffmpeg-static` 运行时二进制和许可
文件。桌面安装包会因内置 FFmpeg 增大，发布构建需安装目标平台/架构的依赖。
FFmpeg 发行二进制及其许可随包分发，适用许可见依赖目录中的 LICENSE/README。

兼容 MP4 使用 H.264/yuv420p 和 AAC，faststart，最多 1920px 宽、15 秒、50MiB；
超出部分仍保留在原件内。单任务两线程、90 秒超时；临时文件只在本地缓存目录，
不允许网络输入协议。HDR 色调映射、RAW、AVIF 等没有纳入本次实现。

## 验证证据

`attachment-modern-media.test.ts` 用真实 FFmpeg 编码的 10-bit HEVC/AAC MOV 与 JPEG
构造格式样本，覆盖新旧 Google XMP、HEIF mpvd、两种三星 SEFT、Apple UUID 配对、
静态降级、原件字节、缓存去重、Range、权限、级联清理和数据库备份关系。
HEIF 的解码样本来源与许可见 `backend/tests/fixtures/heif/README.md`。
UI 测试覆盖默认封面、点按播放、播放结束、失败提示、原件下载和离线缓存隔离。

格式参考：[Android Motion Photo 规范](https://developer.android.com/media/platform/motion-photo-format)、
[Apple Live Photo](https://developer.apple.com/documentation/photos/phlivephoto)、
[Apple QuickTime content identifier](https://developer.apple.com/documentation/avfoundation/avmetadatakey/quicktimemetadatakeycontentidentifier)、
[ExifTool Apple 元数据定义](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Apple.pm)、
[ExifTool Samsung 尾部定义](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Samsung.pm)。
