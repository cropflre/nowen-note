# 日历日期与移动端日期选择修复

日期：2026-10-15。分支：`release/v1.5.2`。属于待发布修复，不代表 1.5.1 安装包已更新。

## 复现与修复范围

| 问题 | 修复前证据 | 处理 |
| --- | --- | --- |
| 手机选日期后左侧被裁、右侧留白 | Chromium 移动触控模式，393px，外层 `scrollLeft` 从 0 变为 128，选完日期仍保持偏移；普通桌面缩窄视口不能稳定触发 | 把原生日期输入的定位与尺寸约束在可见快捷按钮内，保留触控、键盘和焦点提示，不用事后滚回掩盖问题 |
| 两处“日历”的日期和内容范围不同 | 笔记按 `updatedAt`，瞬间按可编辑的 `createdAt` 发布时间 | 中英文明确命名“笔记日历 / 瞬间日历”，分别说明修改日期和发布时间 |
| 凌晨笔记有徽章但点开漏记录 | 本地 10 月 3 日有 2 篇，原服务端 UTC 日期筛选只返回 1 篇 | 在既有授权范围的笔记元数据上复用 `noteLocalDayKey`，数字和列表使用同一个本地日期口径，兼容旧服务端，不改变 API 协议 |
| 瞬间被归到前一天 | 上海本地 10 月 2 日 00:30，即 UTC 10 月 1 日 16:30；原聚合截取 UTC 字符串，落到 10 月 1 日 | 使用已有 UTC 解析和本地日期工具；日面板的时间也按本地时间显示 |
| 月初月末记录遗漏或混入相邻月份 | 原请求使用 UTC 日历日期，且 `formatDateKey(year, month + 1, 0)` 会把 day=0 截为 1，而非该月最后一天 | 先计算本月实际最后一天，再把本地月初至月末转换成 UTC 查询边界 |

不修改数据库或导入时间，不增加永久登录或绕过鉴权。DCC-006 相关边界：笔记和瞬间仍从既有接口读取当前用户/工作区有权访问的数据，日期筛选不扩大权限；无新增业务写入、Outbox 或收据逻辑。

笔记点选日期时读取当前范围的完整元数据后在本地筛选，与日历徽章保持一致。这避免依赖旧服务端的 UTC 日期解释；相较服务端单日筛选，单次请求可能返回更多元数据。未进行大库性能基准，不涉及正文批量加载或额外启动请求。

## 验证命令

在根目录先运行 `npm run build:web`；浏览器测试读取 `frontend/dist`，不使用旧构建产物。

```bash
cd frontend
TZ=Asia/Shanghai npx vitest run \
  src/lib/__tests__/sayCalendar.test.ts \
  src/lib/__tests__/noteListTime.test.ts \
  src/lib/__tests__/dateTime.test.ts \
  src/lib/__tests__/dailyRecords.test.ts \
  src/lib/__tests__/remoteWebStartup.test.ts \
  src/lib/__tests__/authSession.test.ts \
  src/components/daily-records/__tests__/dailyRecordsMobileScrollContract.test.ts \
  src/components/__tests__/DailyRecordsResponsiveActions.test.ts \
  src/components/__tests__/NoteListPresentation.test.tsx
TZ=America/New_York npx vitest run src/lib/__tests__/sayCalendar.test.ts src/lib/__tests__/dateTime.test.ts
npx playwright test --config playwright.daily-records.config.ts
```

另在根目录运行：`npm run test:loading-ux`、`node scripts/data-consistency-contract.mjs --verify`、`git diff --check`。

## 实际验证

- 修复前：393px 触控回归失败，实际偏移 128px；新增本地日期单元用例失败；新增凌晨笔记浏览器用例复现“徽章 2 篇、列表 1 篇”。
- 单元测试：上海时区 54 项通过；纽约时区日期相关 10 项通过（包含与上海运行重复的用例，不相加为独立用例数）。
- 浏览器：8 项全部通过，使用隔离 SQLite / 专用测试账号 / 真实路由与生产 Web 产物，覆盖 320/360/393/430/1440px 的触控聚焦、选日期、重复打开、取消，以及上海月初/月末查询、发布时间、本地凌晨导入笔记、中英文口径说明。修复后外层 `scrollLeft=0`，标题位置不变；凌晨笔记的徽章与列表都为 2 篇。已检查 320/393/1440px 截图。
- Web 构建、启动加载 5 项契约检查、DCC 12 项映射校验通过。映射校验不是完整同步行为回归；未运行全量后端测试。
- 浏览器测试会在仓库外创建临时库，结束后停止后端并删除测试库；截图输出在 `docs/qa/artifacts/daily-records-calendar/`。

## 登录、启动与发布边界

- 当前分支已包含先前的慢启动兼容：12 秒转为继续加载提示，60 秒才报告超时；刷新令牌及响应读取有 8 秒界限。此次复测现有 `remoteWebStartup`、`authSession` 和 loading-ux 用例，没有重复实现或调整鉴权策略。
- 此前同源、保留存储的刷新和重新打开未复现“每次都要求密码”。用户只提供了版本 1.5.1，手机入口、导入来源和启动现场诊断仍缺失；不能宣称重复登录的现场问题已解决。
- “导入当天 99+”仍可能来自源数据的修改时间或导入元数据缺失；本轮保留这些值，不批量推断历史时间。
- 没有真实 Android / 飞牛 WebView / Safari 或 iOS 日期选择返回验收，没有安装包构建、CI、推送或正式发布证据；代码提交状态以 Git 记录为准。
- 真机复测：重复点选择日期→选历史日期/取消→切换瞬间日历/日记，确认内容左边界、顶部栏和横向快捷栏正常；对照原始导入文件日期及启动诊断，再决定是否修复导入适配或手机存储环境。
