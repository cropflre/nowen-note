# 循环任务删除修复验收（P1）

日期：2026-10-14。目标分支：`release/v1.5.2`。代码已实现并通过本地回归，尚未正式发布。

## 原因与行为

原删除接口仅按任务 ID 删除任务树，循环实例通过 `repeatGroupId` 关联；起始任务删除后，其他实例仍能继续生成。Sync V2 对已不存在的任务直接 UPSERT，迟到的离线更新能够复活已删除实例。Native 删除和 Outbox 入队原来分别执行。

| 操作 | 结果 |
| --- | --- |
| 仅删除本次 | 删除所选实例及其子任务；已生成的其他实例不受影响。若本次尚未完成且没有下一次，沿用原有重复规则跳过本次、生成下一次；日期/次数上限仍有效。 |
| 终止后续循环 | 保留历史和所有已生成实例，停止整个系列生成新任务。已终止系列需要另建任务才能重新开始循环。 |
| 删除整个系列 | 删除同一作用域中同一系列的全部实例，包括历史、归档任务和各实例的子任务；清理依赖和提醒。 |

确认弹窗展示当前加载的影响数量与不可撤销提示。离线缓存可能不包含其他设备最新生成的实例，实际同步仍按完整系列处理。批量删除保持“仅删除选中的本次实例”，并明确提示循环会继续。

## 补充反馈：异常日期导致任务中心白屏

使用反馈中的 `dueDate=NaN-NaN-NaN`、`dueAt=NaN-T00:00:00` 复现：修复前 DateBadge 和任务详情渲染均抛出 `RangeError: Invalid time value`。循环生成器将 SQLite 格式 `2026-09-20 16:30:00` 当成日期键拼接，确实能生成 `NaN` 日期并丢失时间。

- 生成器现在规范化 ISO/SQLite 日期时间，保留小时和分钟，验证基础日期、重复间隔、结束日期和生成结果；既有异常实例不会再生成异常后续任务，仍可完成、终止或删除。
- REST 与 Sync V2 拒绝新写入的非法日期；已有异常字段原样保留时允许编辑其他字段，避免阻断用户修复。不会推测用户原本的日期或把所有坏数据强制改为某一天。
- 任务列表、详情、日历和时间线安全处理异常值；列表和详情显示“日期异常，请编辑修复”，其他任务继续可用。手动选择合法截止日期时清除无效旧时间，防止残留的坏 `dueAt` 覆盖新日期。
- 补充的 HTTP 401 日志只能证明请求鉴权失败；前端日期渲染异常不会使服务端返回 401。没有用户环境的完整鉴权与请求上下文，不能认定两者同因，本次未修改鉴权逻辑。

## 一致性与兼容边界

- SQLite 后端迁移 v126 添加持久化任务墓碑及系列生命周期记录；Native schema 9 → 10 添加对应表，保留现有任务、账户绑定和 Outbox。业务变更与同步意图在同一事务内提交。
- 桌面 Outbox 捕获完整系列意图；Native 系列命令由服务端按实际系列展开，覆盖另一设备新生成的实例。Sync V2 迟到更新进入冲突，保留草稿，不能将已删除任务重新插入服务器。
- Web 在原有账号/服务器/空间缓存范围内持久化删除与终止意图；请求失败、重启、迟到列表、创建 ACK 与删除交错均不能让删除实例重新出现在列表中。
- 合并后的“终止循环 + 删除本次”同步命令同时校验系列与待删子任务权限；共享空间编辑者不能借合并命令删除他人的子任务，拒绝后任务与生命周期记录均保持原样。
- 仅明确删除操作记录墓碑；权限变化或 Snapshot 缺失引发的内部清理不记录用户删除意图。删除通知的应用不会再次生成下一次任务。
- 旧服务器必须升级后才能执行/同步整个系列操作。REST 删除前检查能力，Native 和桌面 Sync V2 在 Push 前检查协商结果；不支持时保留待同步意图，防止旧 UPSERT 将系列命令误当作空任务更新。
- 默认 DELETE 与旧客户端继续保持单次删除入口。墓碑保护自新版本记录删除时生效，不猜测升级前已经消失的任务或自动清理历史残留。
- 适用契约：DCC-002、003、007、009、010；对应真实用例已加入机器可读矩阵。

## 自动化结果

| 验证 | 实际结果 |
| --- | --- |
| 后端：任务删除、日期异常、重复次数、任务生命周期、个人实体同步、Sync Engine、多设备 Native HTTP、任务生成日期 | 165 / 165 通过 |
| 前端：操作弹窗、能力检查、离线队列、Native 迁移/回滚、移动任务桥、重复规则、异常日期渲染、日历/时间线、i18n 覆盖 | 158 / 158 通过 |
| 独立服务端与三台 Native SQLite：终止 → 重启 → 第二设备读取 → 删除系列 → 三端收敛 | 通过（上述后端测试内） |
| 旧服务器能力缺失：不发送系列命令，保留稳定待同步意图，升级后再同步 | 通过（上述测试内） |
| Chromium 弹窗：1280×900、390×844、844×390，范围/操作及滚动可达性 | 通过；使用独立模拟任务，非生产数据 |
| Chromium 实际任务中心及详情：1280×900、390×844，同时含异常与正常任务 | 通过，无页面异常；使用模拟数据及接口 |
| 前后端构建、TypeScript、DCC 映射校验、任务范围 diff-check | 通过 |

后端依赖当前为 Electron ABI，因此测试使用 Electron-as-Node，未重建或改变原生依赖。可复现命令：

```sh
# 在 backend/ 下
ELECTRON_RUN_AS_NODE=1 ../node_modules/.bin/electron --import tsx --test \
  tests/task-recurrence-delete.test.ts tests/task-repeat-count.test.ts \
  tests/task-lifecycle.test.ts tests/sync-v2-personal-entities.test.ts \
  tests/sync-v2-engine.test.ts tests/sync-v2-mobile-multidevice.test.ts \
  tests/task-composer.test.ts tests/task-composer-dates.test.ts
npx tsc --noEmit
npm run build

# 在 frontend/ 下
npx vitest run src/lib/__tests__/taskRecurrenceApi.test.ts \
  src/components/tasks/__tests__/TaskRecurrenceDeleteDialog.test.tsx \
  src/lib/__tests__/taskOfflineApi.test.ts src/lib/__tests__/nativeTreeSchemaMigration.test.ts \
  src/lib/__tests__/mobileLocalAdvancedTaskBridge.test.ts \
  src/components/tasks/__tests__/taskRepeatUtils.test.ts \
  src/i18n/__tests__/releaseI18nCoverage.test.ts \
  src/components/tasks/__tests__/taskInvalidDates.test.tsx \
  src/components/tasks/__tests__/DateBadge.test.ts \
  src/components/tasks/__tests__/taskDueTimeUtils.test.ts \
  src/components/tasks/__tests__/taskGanttUtils.test.ts \
  src/components/tasks/__tests__/taskCalendarLayout.test.ts \
  src/components/tasks/__tests__/TaskDetailPanelCreatedAt.test.tsx \
  src/components/tasks/__tests__/taskCalendarDrag.test.ts \
  src/components/tasks/__tests__/taskAllDayContract.test.ts
npm run build

# 在仓库根目录
node scripts/data-consistency-contract.mjs --verify
```

浏览器截图：[桌面](../artifacts/task-recurrence-deletion/desktop.png)、[移动窄屏](../artifacts/task-recurrence-deletion/mobile.png)、[横屏](../artifacts/task-recurrence-deletion/landscape.png)。

异常日期浏览器截图：[桌面列表](../artifacts/task-recurrence-deletion/invalid-dates-desktop.png)、[移动列表](../artifacts/task-recurrence-deletion/invalid-dates-mobile.png)、[桌面详情](../artifacts/task-recurrence-deletion/invalid-dates-detail-desktop.png)、[移动详情](../artifacts/task-recurrence-deletion/invalid-dates-detail-mobile.png)。

## 发布前待验收

Electron 安装包、Android 真机/APK、实际提醒取消、多设备断网/重连和生产升级未执行，不能由 SQLite/浏览器测试代替。应在升级前备份后，验证旧系列、含子任务与提醒的系列、三种操作、杀进程重启、离线重连、第二设备同步及旧服务端升级。外部 CI、正式 Release 和用户复测尚无完成证据。

对用户可回复：

> 已完成循环任务删除相关的代码修复，并通过本地回归测试，计划随 v1.5.2 发布。本次区分仅删除本次、终止后续循环和删除整个系列，同时修复循环生成异常日期、导致任务中心白屏，以及删除后被旧同步数据重新创建的问题。发版前还会完成安装包和真实设备复测，发布后请升级验证。感谢反馈！
