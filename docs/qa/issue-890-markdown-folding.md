# Issue #890 Markdown 章节折叠验收

- 验收日期：2026-11-01
- 分支：`release/v1.5.4`
- 实现提交：`2c08e0dfb95c556f14c34deb95e5283b0e5edbd8`
- 验收基线：`8e2bfbc42b4311a33f021858e308f3c85cf23a29`，另有随本记录一起提交的测试与 CI 配置修改。
- 环境：macOS，Node 24.22.1、Electron 43.8.4、Playwright Chromium；浏览器后端使用临时数据库和测试账号。

## 结果

| 检查 | 实际结果 |
| --- | --- |
| 普通和大文档编辑器折叠专项 | 14 项通过：同级边界、嵌套章节、代码围栏中的伪标题、搜索和目录展开、编辑后范围映射、切换笔记和只读模式 |
| 大文档预览、移动预览、Live Preview 和工具栏回归 | 20 项通过；与折叠专项合计 5 个测试文件、34 项通过 |
| 生产构建 | `npm run build` 通过；保留现有 bundle 大小和混合导入警告 |
| 类型检查 | 修改测试后 `npx tsc -b --pretty false` 通过 |
| 桌面 1440px Chromium | 折叠/展开、同级标题保留、分屏预览保持全文、深浅主题、搜索展开、快捷键通过 |
| 移动 390px Chromium 触控模拟 | `tap()` 折叠/展开、24px 按钮宽度、深浅主题、搜索展开通过 |
| 折叠不保存正文 | 两项浏览器用例均确认服务端正文和版本号保持不变 |
| CI 使用的 Node 后端入口 | 隔离副本安装 Node ABI 的 SQLite 二进制后，两项浏览器用例均通过；没有重建工作区的 Electron 原生依赖 |
| 工作流检查 | YAML 解析和 `git diff --check` 通过；尚未运行修改后的 GitHub Actions |

普通、大文档编辑器均已接入折叠。关闭语法解析的 `lightweight-edit` 模式有意不提供折叠，不能将“所有大文档模式支持折叠”作为已完成项。

## 旧 CI 失败与本次改动

[原失败运行](https://github.com/cropflre/nowen-note/actions/runs/40974127776) 对应实现提交；16 项中 15 项通过，失败断言是点击图片后没有找到图片预览弹窗。该运行未执行折叠专项。

本地原用例通过，尚未复现旧 CI 的失败。本次为该用例增加 React `act`，等待 CodeMirror 内 React 子树挂载、被动副作用、点击、关闭和销毁完成，保留图片节点、选区和原文不变的全部断言。这修正了测试中的同步缺口；不能据本地通过断定旧 CI 根因已完全排除。

`markdown-live-preview-ci.yml` 已增加折叠实现、测试、浏览器 fixture 和依赖变更的触发路径，执行全部 34 项相关单测、生产构建、桌面和移动折叠浏览器测试，并上传浏览器截图。浏览器 fixture 新增可选 Node 运行入口，供 CI 使用 Node ABI 的后端依赖；本地默认仍使用 Electron。

## 复测命令

在已安装依赖的仓库根目录执行：

```bash
cd frontend
npx vitest run \
  src/components/__tests__/MarkdownEditor.folding.test.tsx \
  src/components/__tests__/LargeMarkdownSafeEditor.preview.test.tsx \
  src/components/__tests__/MarkdownExperienceBridge.interaction.test.tsx \
  src/components/__tests__/MarkdownEditor.mobilePreview.test.ts \
  src/lib/__tests__/markdownLivePreview.test.tsx
npm run build
npx playwright test --config playwright.markdown-slash.config.ts \
  --grep "Markdown chapter folding"
```

CI 使用 `NOWEN_MARKDOWN_TEST_RUNTIME=node` 运行同一 Playwright 命令，要求后端 SQLite 原生依赖匹配 Node；默认命令要求其匹配 Electron。

## 尚未完成

- 修改后的 GitHub Actions 在目标提交上通过；旧运行仍为失败状态。
- Android 真机的按钮误触率、长文档和嵌套标题手势体验；390px 触控模拟不能替代真机。
- Electron 安装包中的实际桌面交互验收；当前证据来自 Chromium 页面和 Electron/Node 后端 fixture。

本记录不代表推送、回复或关闭 Issue，也不代表发布。结论为功能已实现、本地自动化验收通过、CI 接入已补齐；云端和设备验收待完成。
