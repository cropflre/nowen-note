# Extension V3 Phase 3A · Inspector 本地验收

2026-10-18。开发分支 `codex/extension-v3-inspector`，基线 `3b7579f08187700962b810c383990b9eca78bb88`。实现提交见当前开发分支 Git 历史；尚未推送、未合并、未发布，不代表整个 Phase 3 完成。

环境：macOS Apple Silicon / arm64，宿主 Node 24.18.0；后端测试使用 Electron 33.0.0 的 Node 20.18.0 / ABI 130。浏览器使用本机 Chrome。测试数据库和插件目录均位于临时目录，未修改用户数据库和已有未提交锁文件。

## 已通过

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 后端插件专项 | 7 文件 / 27 项，失败 0、跳过 0 | V3 声明、会话、权限、数据、V2.1 兼容；含新增 Inspector 用例 |
| 前端专项及翻译覆盖 | 8 文件 / 139 项，失败 0、跳过 0 | 当前资源绑定、迟到响应、身份切换、关闭开关、原生降级、既有导航/布局/数据行为和中英文覆盖 |
| 前端 DCC | 31 文件 / 250 项，失败 0、跳过 0 | 含新增身份/工作区隔离用例；与专项存在重叠，不累加为独立用例数 |
| 生产路由浏览器 E2E | 2 项，失败 0、跳过 0，24.7 秒 | 原有应用/Dashboard 闭环及新 Inspector 闭环 |
| SDK | 生成合同测试 1 项；TypeScript 构建通过 | Host 合同版本 6，V1/V2 拒绝新增 inspect 方法 |
| 构建与映射 | 前端生产构建、后端 TypeScript、9 份生成物检查、DCC 映射、diff 空白检查通过 | DCC：12 不变量 / 174 引用 |

Inspector 后端用例验证：合法声明；重复 ID、未知类型、重复类型、外部页面、缺读权限被拒绝；个人笔记/任务/附件跨身份拒绝；资源与工作区不匹配拒绝；工作区 viewer 可读、移除成员后旧会话拒绝；参数替换资源拒绝；普通应用不能调用 Inspector 适配器；Inspector 不能枚举资源或写插件数据；资源入回收站、授权撤销及功能关闭后旧会话拒绝；加密笔记拒绝；不返回正文、任务描述、文件路径或用户标识。

浏览器通过真实 CLI 安装包和生产认证/安装路由验证：安装授权前无入口；笔记、任务、附件详情均可手动打开 Resource Inspector；选中元数据准确；切换笔记后关闭旧 frame，旧会话拒绝调用；新笔记正常运行；深色主题事件、390px 窄屏的笔记入口和附件窗口正常；停用插件回收界面。所有用户、资源及内容均为临时测试数据。

截图：[笔记检查器 / 深色](./artifacts/extension-v3-inspector/inspector-note-dark.png)、[附件检查器 / 390px](./artifacts/extension-v3-inspector/inspector-attachment-narrow.png)。

## 既有失败与未执行

补充运行 `EditorPaneMobileHeader.test.ts`、`EditorPaneRuntimeLayout.test.tsx`、`TaskDetailPanelCreatedAt.test.tsx`：合计 8 项通过、1 项失败。失败为 `keeps desktop action titles matched with their buttons`，测试查找旧字符串 `{SHOW_EDITOR_MODE_TOGGLE && (`，而源码已有 `activeNote.contentFormat` 条件，导致结束位置为 -1。

通过 `git show HEAD:<path>` 将未修改的 `EditorPane.tsx` 和对应测试复制到独立临时快照，使用相同 Vitest/jsdom 重跑：6 项中 5 通过、同一项失败。基线为上述 `3b7579f0`，本轮没有修改这个既有测试，不能宣称所有前端测试全绿。

本轮没有运行完整后端 DCC 或全仓库测试；既有 Native 多设备 DCC 失败仍见 [Phase 2 记录](../../plugin-platform/extension-platform-v3-dashboard-data.md)。没有 Inspector 对应提交的远端 CI；Electron 成品、Docker/NAS、真实 Android/iOS/HarmonyOS 设备及生产升级恢复未验收。此前启动的 Phase 2 候选构建已在用户选择转入 Inspector 开发后停止，不能计为候选产物通过。

iframe 自身导航首次请求、CPU/内存硬配额等既有安全边界未解决。首期只读元数据不包含文件字节、EXIF、正文分析、Previewer、后台服务或 AI Tool/审批实现。

## 复测命令

根目录执行后端专项：

```sh
cd backend
ELECTRON_RUN_AS_NODE=1 ../node_modules/.bin/electron --import tsx --import ./tests/setup-db-isolation.ts --test tests/application-v3-foundation.test.ts tests/application-v3-runtime.test.ts tests/application-v3-dashboard-data.test.ts tests/application-v3-inspector.test.ts tests/extension-capability-catalog.test.ts tests/extension-v2-1-feature-gates.test.ts tests/ui-contribution.test.ts
npm run build:tsc
```

前端专项和 DCC：

```sh
cd frontend
npx vitest run src/lib/__tests__/pluginInspector.test.tsx src/lib/__tests__/pluginDataActions.test.tsx src/lib/__tests__/pluginApps.test.ts src/lib/__tests__/pluginDashboard.test.ts src/lib/__tests__/appPathNavigation.test.ts src/lib/__tests__/serverUrl.test.ts src/lib/__tests__/pluginRuntimePresentation.test.ts src/i18n/__tests__/releaseI18nCoverage.test.ts
cd ..
node scripts/data-consistency-contract.mjs --frontend
```

浏览器测试前分别在 `examples/plugins/hello-nowen-app`、`personal-dashboard`、`resource-inspector` 运行 `node ../../../packages/nowen-plugin-cli/bin/nowen-plugin.mjs pack`，然后：

```sh
cd frontend
npm run build
NOWEN_QA_NODE="$PWD/../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" NOWEN_QA_BROWSER_CHANNEL=chrome npx playwright test --config playwright.plugin-apps.config.ts --reporter=line
```

CI 使用 Node 22 及 Chromium，无需 `NOWEN_QA_NODE` / Chrome 覆盖。现有 V3 工作流已加入新包打包、新后端用例、前端及浏览器用例；改动尚未推送。

手动使用：`NOWEN_EXTENSION_V3_INSPECTORS=1 npm run dev`，再按[示例说明](../../../examples/plugins/resource-inspector/README.md)安装并打开检查器。

## 2026-10-18 补充：管理入口并入应用

设置中的桌面/移动端插件分类与面板已移除；在“应用”中通过“我的应用”和“应用管理”切换运行目录与管理页面。安装、授权、启停、市场、更新和开发者功能复用原实现；管理页重新确认当前账号角色，身份切换清掉旧管理界面，迟到的管理员信息不能覆盖新账号。`/apps/manage` 支持刷新，服务器地址推断已补充该路由及反代子路径回归。

本次前端定向回归为 8 文件 / 139 项通过，包含管理角色、身份切换、失败重试、设置导航、路由、服务器路径、安装策略和翻译覆盖。前端 TypeScript/生产构建、DCC 映射及 `git diff --check` 通过。浏览器 2 项通过，覆盖桌面与 390px 窄屏设置中不再存在“插件”、管理页直接刷新、新入口安装授权、原有应用/Dashboard 与 Inspector 闭环。

截图：[应用管理 / 桌面](./artifacts/extension-v3-inspector/app-management-desktop.png)、[应用管理 / 窄屏](./artifacts/extension-v3-inspector/app-management-narrow.png)。此补充已提交到本地开发分支，尚未推送；不改变上述平台验收边界。
