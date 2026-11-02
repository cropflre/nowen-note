# Issue #892 图片预览修复与验收

- 记录日期：2026-11-02。
- 范围：[Issue #892](https://github.com/cropflre/nowen-note/issues/892)，从 `release/v1.5.4` 切出的 `codex/issue-892-image-preview`。
- 当前证据是本地源码、Vitest、Chromium 桌面/移动模拟；未取得反馈者原图、机型或录屏，不能认定已重现其全部 Android/PC 问题。没有修改或关闭远端 Issue，也未推送、发版。

## 确认的缺陷与修复

| 触发条件 / 修复前 | 修复后 / 回归证据 |
| --- | --- |
| 指针捕获丢失后仍保留旧指针；下一次单指拖动误入 pinch，测试从 1.25 倍跳到 5 倍 | `lostpointercapture` 按取消处理，忽略已结束指针的重复事件；失焦、复原、换图和关闭清理捕获及手势状态 |
| 拖动离开起点再返回，结束位置被当成点击，可能关闭预览 | 记录手势是否曾越过点击容差；拖动、pinch 与取消均不产生点击或双击 |
| 屏幕旋转后 fit ratio 未更新；长图 fit ratio 被限制到至少 1%，小图 1:1 按钮会额外放大 | resize 重新测量并约束位移；长图可回到真实 1:1，小图已经 1:1 时不额外放大 |
| Viewer 没有 App 全局侧边栏手势的屏蔽标记，边缘右滑可能同时操作侧边栏 | 根节点加入已有 `data-swipe-blocker` 协议；系统原生返回手势仍需真机验证 |
| 附件源带 `w=240/480/960` 时，Viewer 沿用缩略图 | 全屏预览在授权/离线解析后仅移除 Nowen 附件端点的 `w` 参数；保留代理前缀、文件名、签名、scope、share、inline 及其他参数；外部图片 URL 不改写。下载回调使用同一原始分辨率地址 |
| 图片解码前，布局桥从 width/测量尺寸推断比例并写入显式高度，可能固定导入的错误比例，且未监听 load | 等待 naturalWidth/naturalHeight 可用后按解码比例布局；load 后重算；持久化 width 和旋转/镜像属性保留 |
| 图片显示超过解码分辨率时没有解释 | 预览和选中的编辑器图片提供轻量清晰度提示，考虑 DPR；选中图片的提示 title 包含解码尺寸、CSS 尺寸、DPR。Android fetch 失败日志不再输出签名 URL 或错误中的 URL |

手势策略：适应窗口时，多图水平滑动切换；首尾停住，不循环。单图滑动不导航。放大后仅平移，不因拖到边缘而切图；先复原到适应窗口，再滑动切图。双指以焦点为锚点；抬起一指后剩余手指接续平移。位移约束使用旋转后实际尺寸，未超出视口的轴保持居中。

编辑态仍为单击选中，通过“查看大图”操作打开预览，桌面也可双击；只读态单击预览。未新增上传、压缩或改变图片数据的操作。

## 自动验证

1. 定向 Vitest（13 个测试文件，74 项通过）：`FullscreenImageViewer.gestures/rotation`、`EditorImageTransformBridge/Controls`、`ResizableImageBootstrap`、`useAttachmentImageRenderSource`、`imageViewerGeometry`、`editorImageTransformLayout`、`imageNodeTransformBootstrap`、`noteAttachmentAccessBridge`、`imagePreviewAttachmentAccess`、`mobileImageViewerContract`、`androidImagePreviewTapCloseContract`。
   - 已先取得缩略图、解码前错误比例、捕获丢失、拖动返回误关、旋转后旧比例、缺少侧滑屏蔽标记的失败证据。
   - 覆盖取消、双指焦点与转单指、两轴边界、旋转、首尾、单图、小图、极长图、续签、403/404 拒绝、Android blob、离线 blob、Native HEIC 兼容预览与日志脱敏。
2. `cd frontend && npx playwright test --config playwright.image-preview.config.ts`
   - 桌面 1280×800 / DPR 2，移动 390×844 / DPR 3；5 项通过，桌面不适用的触摸专项跳过。
   - 使用隔离的真实 Viewer、Tiptap NodeView 与布局桥，网络拦截生成尺寸固定的 SVG 图片。验证实际请求无缩略图参数、解码尺寸、宽高比、100% 模式、旋转/镜像、响应式宽度及移动 Chromium 的 CDP 触摸事件（滑动、pinch、抬一指后继续平移、屏幕旋转、关闭重开）。没有连接生产数据。
   - 截图输出位于 `frontend/node_modules/.cache/image-preview-results/`，已目检移动竖屏与横屏工具栏及关闭按钮。
3. `npm --prefix frontend run build`：TypeScript 与 Vite 构建。
4. `node scripts/data-consistency-contract.mjs --verify`：DCC-006 授权参数保留、DCC-009 离线 blob 的真实回归用例已映射；映射检查不代替行为测试。

数据边界：本次仅改变渲染地址和交互状态。笔记正文、附件文件、数据库、Outbox、ACK、游标及同步协议没有新增写入；预览旋转仍沿用现有文档事务。未经授权不请求裸附件，也不因下载失败改删附件。

## 待人工 / 真机验收

本机 `adb devices -l` 没有连接设备。以下尚未执行，不能由桌面 Chromium 模拟替代：

- Android WebView 与实体手机 Chrome：编辑态选择/查看大图、只读单击、软键盘/文本选区、App 侧边栏和系统边缘返回；单图/多图、横长/竖长图、双指缩放后单指拖动、pointercancel 与捕获拒绝、切后台后重试、横竖屏及 90° 旋转。
- Electron 安装版及不同系统/DPR：用反馈者原图与截图/粘贴/导入图片检查实际解码像素、CSS 显示尺寸与清晰度，区分源图像素不足和手动放大；SVG fixture 不证明真实照片的画质。
- 实际服务器 ACL 撤销、HEIC 解码、Android 离线文件与真实代理访问；当前为渲染链路模拟和已有权限边界回归，没有重新执行后端权限集成或生产网络验收。
- 保存宽度、旋转、镜像后重开笔记，导出/导入往返及第二设备同步读取；当前只有既有属性/导出回归与浏览器布局证据，没有实机同步或导出文件验收。

复测每项记录：客户端/服务器版本、设备/WebView 版本、源图尺寸与类型、前置状态、步骤、预期/实际、截图或事件序列。不得记录完整签名 URL。真机及反馈者复测完成前，不应将 Issue 所有验收项标为完成。
