# Issue #739 外观与分享页验收

记录日期：2026-10-13。

## 范围与版本

- 基线：`release/v1.5.2` 的 `59522c3feaa65958b2a9cf89bebf506e2af5295c`，本地和远端在开始验收时一致。
- 先重新验证知识树显示大小、离线图标搜索、分享页宽度和页尾文字，再验证本次新增的管理员统一横幅。
- 当前正式发布标签仍为 v1.5.1。分支代码、自动化测试和浏览器检查不等于正式版交付。
- 不包含任意 CSS、外部矢量图标源、每篇分享独立封面或整版发布验收。

## 自动化结果

| 检查 | 结果 | 证据范围 |
| --- | --- | --- |
| 已有功能基线 | 前端 9 个文件、63 项通过；后端 2 个文件、7 项通过 | 保存和刷新、账号上下文、知识树三种入口、分享宽度、大纲、页尾文字、图标搜索及中英文文案 |
| 横幅与已有功能组合回归 | 前端 12 个文件、75 项通过 | 增加裁切坐标、上传边界、真实设置组件的异步加载、公开页面显示和横幅设置持久化 |
| 后端组合回归 | 3 个文件、13 项通过 | 其中横幅 6 项，覆盖默认值、管理员权限、重新打开数据库后的持久化、关闭和删除、透明图片白底，以及非法输入的原子拒绝 |
| 前端生产构建 | `npm run build`，退出码 0 | TypeScript、Vite 和现有通知 UI 校验 |
| 后端生产构建 | `npm run build`，退出码 0 | 实际生成 `backend/dist/index.js` |

前端使用 Node 26.3.0，并设置 `NODE_OPTIONS=--no-experimental-webstorage`；构建增加 `--max-old-space-size=6144`。后端使用项目 Electron 的 Node 运行模式，以匹配当前 SQLite 原生模块；测试通过 `tests/setup-db-isolation.ts` 使用临时数据库。

前端回归文件：`noteIconRegistry.test.ts`、`useKnowledgeTreeDisplaySize.test.tsx`、`useSidebarTextStyle.test.tsx`、`useSiteSettingsIcp.test.tsx`、`SharedNoteFooter.test.tsx`、`knowledgeTreeSidebarContract.test.ts`、`siteSettingsPublicCache.test.ts`、`KnowledgeTreeCreatedSelection.test.tsx`、`releaseI18nCoverage.test.ts`、`shareBannerCrop.test.ts`、`ShareBannerEditor.test.tsx`、`SettingsModalSiteIdentity.test.tsx`。

后端回归文件：`settings-share-banner.test.ts`、`settings-share-width.test.ts`、`settings-share-footer.test.ts`。

## 浏览器结果

使用 Edge 的 Playwright 无头浏览器，公开 API 使用模拟数据，不读取或修改真实用户数据。

| 场景 | 结果 |
| --- | --- |
| 已有分享页：1600px / 390px、标准 / 宽屏 / 全宽、有 / 无大纲 | 12 个组合通过，无横向溢出 |
| 新横幅：1600px / 390px、三种分享宽度 | 6 个组合通过，无横向溢出，桌面 4:1、窄屏 3:1 |
| 关闭横幅后刷新 | 正文仍正常显示，横幅消失 |
| 实际图片选择、取消和竖向裁切 | 通过；取消不生成新配置，应用后输出 1600 × 400 的 JPEG |
| 裁切结果像素 | 验证底部取景包含原图底部色块，透明区域输出白色（RGB 255、255、255），与裁切预览一致 |
| 关闭、删除图片 | 关闭保留图片，删除清除图片并关闭显示 |

分享页使用真实生产构建产物。通用 Vite 预览服务不能直接兼容相对资源的深层地址；测试将 `/share/assets/` 按 `backend/src/index.ts` 的生产文件候选规则映射到 `/assets/`，随后访问真实分享路由。裁切流程另将真实编辑器组件打包到隔离页面，使用浏览器原生 FileReader、Image 和 Canvas 操作。

## 交付边界

- 横幅默认关闭，配置适用于全站所有分享页，入口见 [分享操作说明](../tutorials/sharing.md)。
- 输入只接受 PNG、JPEG、WebP 的图片数据。后端校验真实格式、大小和解码结果，重新编码为静态 JPEG；拒绝外部地址、SVG、伪装图片和损坏图片。
- 普通用户和匿名访客不能修改横幅；无效配置不会连带修改站点名称等其他字段。
- 站点配置加载完成前禁止保存；配置到达后填充原站点名称、图标和页尾，防止仅修改横幅时覆盖其他品牌字段。
- 无新增数据库迁移。保留标准分享宽度和默认页尾文字的兼容行为。
- Android / iOS 真机、Electron 完整安装包、线上部署与外部 CI 未执行。本记录不替代 v1.5.2 整版发布门禁。
