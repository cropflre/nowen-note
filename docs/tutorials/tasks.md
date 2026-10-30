# 待办任务使用教程

> 用任务清单管理你的待办事项和工作计划。

---

## 进入待办

点击左侧导航栏的 ✅「待办」图标。

## 导出任务报告

点击任务中心的「导出任务」，选择 **Excel 工作簿 (.xlsx)** 或 **Markdown 报告 (.md)**。也可从「设置 → 数据管理 → 待办数据导入导出」进入。

报告包含当前空间全部任务（包括已完成和已归档任务）的标题、状态、项目、父子层级、进度、描述、优先级和日期。进度与任务树一致：叶子任务为 0% 或 100%，父任务为直属子任务进度的平均值。Excel 还包含任务 ID、父任务 ID 和完整路径；Markdown 使用有层级的勾选清单，并保留描述中的 Markdown 格式。

只导出单个任务时，在任务或子任务上右键，选择「导出 Excel」或「导出 Markdown」；移动端点击该任务的「更多操作」。报告仅包含所选任务和它的全部下级子任务（包括折叠、已完成和已归档的子任务），不会包含它的父任务、兄弟任务或其他项目。选择没有下级的任务时，只导出这一条。

导出期间不会修改任务。图片保留原引用，需要包含图片文件的完整迁移请使用 ZIP。Excel 单元格超过 32767 字符时会提示使用 Markdown，避免截断；Excel / Markdown 报告不用于重新导入，恢复和批量迁移仍使用 ZIP / JSON / CSV。Android 客户端使用系统文件保存选择器；移动浏览器复用文件分享或下载入口。

**English:** Choose **Export tasks** in the task center, then **Excel workbook (.xlsx)** or **Markdown report (.md)**. Reports include all tasks in the current space, including completed and archived tasks, with status, hierarchy, project, progress, full descriptions, priority and dates. Leaf progress is 0% or 100%; parent progress averages its direct children's progress, matching the task tree. Excel includes task IDs and paths; Markdown preserves nested checkboxes and description formatting. Reports do not modify tasks. Images remain references; use ZIP for image files and ZIP / JSON / CSV for re-import. Text exceeding Excel's 32767-character cell limit requires Markdown to retain the full content. Android uses the system file picker; mobile browsers use the existing file-sharing or download path.

For a single task or subtask, right-click it (or use its mobile **Task actions** button), then choose **Export Excel** or **Export Markdown**. Only that task and its complete subtree are included, even when descendants are collapsed, completed or archived. Ancestors, siblings and other projects are excluded. A leaf task produces a one-task report.

---

## 创建任务

1. 点击待办页面顶部的输入框
2. 输入任务标题
3. 按需点击输入框下方的「截止日期」「截止时间」「提醒设置」，选择常用属性
4. 按回车或点击「添加」创建

日期和提醒也可以直接写在标题中，例如「明天晚上8点 开会 提前30分钟」，识别结果会显示在输入框下方。手动选择的日期、时间和提醒优先于智能识别；在「今天」筛选下创建任务时，默认截止日期为今天。

提醒支持截止时、提前 10 分钟、30 分钟、1 小时、1 天，也可以填写自定义提前分钟数（最多提前一年），并同时选择多个提醒。请先设置截止日期；选择「不提醒」可关闭识别产生的自动提醒，选择「清除截止日期」会清除日期、时间和提醒。

创建成功后，快捷属性会重置；创建失败时保留设置，便于重试。

## 任务右键菜单 / Task context menu

在列表、子任务树、看板、日历或甘特视图中右键任务，可查看详情、完成或重新打开、添加子任务、调整优先级、移动项目、保存为笔记，以及归档、恢复或删除。菜单只操作指向的任务；带子任务的删除会说明影响范围，取消确认不会删除。已归档任务保持只读，归档与恢复以根任务树为单位，归档时整棵任务树必须已经完成。

列表中的「任务操作」按钮提供相同入口。键盘聚焦任务后可按 Shift+F10 或菜单键打开，使用 Tab 和 Enter 选择操作，Escape 或点击菜单外部关闭。

Right-click a task in list, tree, board, calendar or Gantt views for its existing actions. The menu operates on that task, confirms deletion, preserves archived tasks as read-only, and archives/restores a completed tree from its root. List rows also expose a Task actions button. Focus a task and press Shift+F10 or the menu key; use Tab and Enter to choose, or Escape to close.

## AI 智能生成待办 / AI Task Composer

在任务中心顶部点击「AI 生成待办」，描述计划或粘贴待办文字。复用设置中的 AI 服务；无需配置第二套密钥。高级选项可设置日期范围、项目、候选上限（默认 12，最多 30）以及时间和重复识别。

生成结果仅为草稿。可以编辑标题、描述、项目、优先级、日期、时间和重复规则，删除或添加候选项，再勾选需要的任务。疑似重复项默认不选中；确实需要同名同日期任务时，勾选「仍然创建此重复任务」。点击「确认创建」后整批事务保存，任何项失败都会回滚本批次。请求结果不确定时，请用「重试确认创建」重试原批次，不必重新生成。

只提供日期的任务保持全天日期语义；精确时间沿用当前任务系统的本地时间语义。离线或移动端仅此设备模式不进行在线生成或确认，草稿在当前账号、服务器和空间的浏览器会话中保留。每日重点数量只指导优先级建议，不自动加入「我的一天」。笔记提取和已有任务智能规划属于后续阶段。

In Task Center, choose **AI tasks**, describe a plan, and generate drafts using your existing AI settings. Edit, add/remove and select candidates before confirming. The default limit is 12 candidates, with a server limit of 30. Possible duplicates start unselected and need an explicit override. Confirmation saves the entire batch atomically; uncertain responses retry the same request ID. Offline and device-only mobile modes preserve the session draft without submitting tasks. Date-only tasks and local wall times follow the existing task calendar contract. Daily priority suggestions do not automatically change My Day.

## 记住任务视图

列表、看板、日历、时间线的选择会保存在当前设备的浏览器本地。刷新页面或重新进入待办后会恢复上次选择；手机端点击视图切换按钮可依次切换这四种视图。不同设备的视图选择独立保存。

---

## 智能识别快速添加

在待办顶部输入框中，可以把日期、时间、重复规则和提醒直接写进任务标题。创建任务时，系统会自动提取这些信息，并把剩余内容作为任务标题。

### 基本示例

| 输入 | 创建结果 |
|---|---|
| `明天 交周报` | 标题：交周报；截止日期：明天 |
| `今天下午3点 开会` | 标题：开会；截止时间：今天 15:00 |
| `明天12:50提醒我上班` | 标题：上班；截止时间：明天 12:50；到点提醒 |
| `每周四 例会` | 标题：例会；每周四重复 |
| `每个工作日 写日报` | 标题：写日报；周一到周五重复 |
| `每2天9点 运动` | 标题：运动；每 2 天重复；时间 09:00 |
| `提前3小时 明天15:00 提交材料` | 标题：提交材料；明天 15:00 到期；提前 3 小时提醒 |

### 日期识别

支持中文和英文日期表达：

| 类型 | 示例 |
|---|---|
| 相对日期 | `今天`、`明天`、`后天`、`today`、`tomorrow`、`day after tomorrow` |
| 星期 | `周一`、`星期天`、`Monday`、`Fri.`、`next Monday` |
| 月日 | `3月6日`、`3/6`、`3-6`、`1.20`、`Mar. 6`、`6 Sept` |
| 月份 | `3月`、`in Oct` |

如果只写月日而不写年份，系统会选择从今天开始最近的那个日期。例如今天已经晚于 `3月6日`，则会识别为下一年的 3 月 6 日。

### 时间识别

| 类型 | 示例 | 说明 |
|---|---|---|
| 24 小时制 | `9:30`、`12:50`、`5:30:40` | 秒会被忽略，只保留小时和分钟 |
| 中文时间 | `9点`、`9点半`、`下午3点` | `下午3点` 会识别为 15:00 |
| 英文时间 | `9am`、`5pm`、`10:30 p.m.` | 支持 am/pm |
| 时段词 | `早上`、`上午`、`中午`、`下午`、`傍晚`、`晚上` | 使用默认时间：早上 07:00、上午 09:00、中午 12:00、下午 13:00、傍晚 17:00、晚上 20:00 |
| 英文时段 | `morning`、`afternoon`、`evening`、`tonight`、`noon` | 使用对应默认时间 |

只写时间、不写日期时，如果该时间今天还没到，就设为今天；如果已经过去，就设为明天。

### 重复规则

| 类型 | 示例 |
|---|---|
| 每天 | `每天 写日记`、`daily write journal`、`every day review` |
| 每 N 天 | `每2天 运动`、`every 2 days workout` |
| 每周 | `每周 周会`、`weekly review`、`every week review` |
| 每 N 周 | `每2周 复盘`、`every 2 weeks review` |
| 指定星期 | `每周四 例会`、`每星期四 例会` |
| 工作日 | `每个工作日 写日报`、`every weekday write report` |
| 周末 | `每周末重复 打球`、`every weekend play tennis` |
| 每月 | `每月10日 记账`、`每月第1天 对账`、`每2月 归档` |
| 每年 | `每年3月 做预算`、`每年3月6日 纪念日` |

重复任务需要有一个起始日期。系统会根据规则自动选择最近一次应发生的日期；如果同时写了时间，且今天这个时间已经过去，会顺延到下一次。

### 提醒识别

| 输入片段 | 效果 |
|---|---|
| `提醒我`、`remind me`、`remind me to` | 到截止时间时提醒 |
| `提前5分钟`、`提前3小时`、`提前1天`、`提前1周` | 在截止时间前提醒 |
| `5 minutes before`、`2 hours before`、`1 day before` | 英文提前提醒 |
| `提前提醒我` | 默认提前 5 分钟提醒 |

提醒必须配合具体截止时间使用。例如 `明天9点提醒我开会` 可以创建提醒；只写 `提醒我开会` 不会自动创建提醒时间。

### 分隔规则

为了避免把普通标题误识别成日期或重复规则，中文独立词后面需要有明确分隔，才会被当成智能识别内容。明确分隔包括空格、标点、句尾，或紧跟具体时间。

| 输入 | 识别结果 |
|---|---|
| `下午 茶` | 识别 `下午`，标题为 `茶` |
| `下午茶` | 不识别，标题仍为 `下午茶` |
| `3月 报` | 识别 `3月`，标题为 `报` |
| `3月报` | 不识别，标题仍为 `3月报` |
| `每周 报` | 识别 `每周`，标题为 `报` |
| `每周报` | 不识别，标题仍为 `每周报` |
| `每年3月 报` | 识别为每年 3 月重复，标题为 `报` |
| `每年3月报` | 不识别，标题仍为 `每年3月报` |
| `今天下午3点 开会` | 保持识别为今天 15:00，标题为 `开会` |

如果你希望系统识别日期或重复规则，建议在识别词和标题之间加一个空格，例如 `明天 开会`、`每周 报告`。如果你希望它只是标题的一部分，直接连写即可，例如 `下午茶`、`每周报`。

---

## 今日完成汇总

在任务筛选栏选择「今日完成」，查看数量、完成时间及所属父任务，点击任务可打开详情。

- 按当前设备时区的实际完成时间统计，与截止日期无关。
- 包含已归档任务；每个任务项计一次，父任务和子任务分别计数。
- 重新打开任务后移出清单，再完成时使用新的完成时间。
- 老数据没有完成时间时不会推测日期；页面跨过本地午夜后会刷新。

## 归档完成的任务

打开顶层任务详情，点击「归档任务树」。顶层任务和所有后代都完成后才允许归档。

归档后，整棵任务树从活动列表、看板、日历和时间线中隐藏，详情、附件、层级、依赖关系和完成记录仍保留。在「已归档」中查看任务，打开顶层任务后点击「恢复任务树」恢复编辑。归档不会重新生成循环任务，也不会删除未来已经生成的独立任务。

Web 离线归档保存到浏览器队列，发送失败会保留并重试；Native 归档在本机 SQLite 和 Outbox 中原子保存。浏览器离线副本的耐久性仍受浏览器环境限制。

## 将任务详情保存为笔记

打开任务详情，点击「保存为笔记」，选择当前空间内可写的文件夹，保存后可直接「打开笔记」。保存包含当前标题、最新详情草稿和附件；原任务保留，笔记与任务之后独立编辑。

附件会复制到笔记受管存储，后续删除原任务附件不会影响已生成笔记。附件正在上传、缺失、不可访问或无法下载时，保存会明确失败，不把不完整内容当作成功。保留保存窗口并重试会复用同一请求，避免网络中断后的重复笔记。首版不合并整个子任务树。

Native 的本机正文附件可以独立复制；仅此设备模式的任务可在本机保存。联网账户需要核对服务端的独立任务附件列表，这类保存需要联网并能读取源任务。Web 生成笔记需要后端可访问；Electron 使用本机后端。上述写入成功并不等于第二设备已经收到数据。

---

## 任务详情描述

每个任务支持填写详细的描述内容，用于补充说明、记录要点或附加上下文信息。

1. 点击任务打开详情面板
2. 在「描述」区域输入内容
3. 描述支持富文本格式，自动保存

描述字段适合记录任务背景、拆解步骤、参考资料等信息，让任务不仅仅是一行标题。

---

## 任务图片附件

任务详情中可以添加图片附件，方便记录截图、参考图等视觉资料。

### 使用方式

在任务详情面板中点击添加图片，选择本地图片文件上传。上传成功后图片会嵌入到任务描述中展示。

### 技术说明

- 图片通过 `/api/task-attachments/<id>` 接口读取，存储于 `task_attachments` 表
- 系统内置孤儿清理保护机制（orphan cleanup），防止正在使用的附件被误删

---

## 任务优先级

每个任务可以设置优先级：

| 优先级 | 颜色 | 说明 |
|---|---|---|
| 🔴 高 | 红色 | 紧急重要 |
| 🟡 中 | 琥珀色 | 一般优先（默认） |
| 🔵 低 | 蓝色 | 不急 |

创建任务后，点击任务可以设置优先级。

---

## 设置截止日期

1. 点击任务
2. 选择截止日期
3. 任务会显示日期标记

逾期的任务会显示「已逾期」标记。

---

## 完成任务

点击任务左侧的圆圈 ○，标记为已完成 ✅。

已完成的任务会显示删除线，可以点击切换回未完成。

---

## 筛选任务

待办页面顶部有筛选选项：

| 筛选 | 说明 |
|---|---|
| 全部 | 所有任务 |
| 今天 | 今天到期的任务 |
| 本周 | 本周到期的任务 |
| 已逾期 | 已过期未完成 |
| 已完成 | 已完成的任务 |

---

## 删除任务

右键任务 → 删除。

---

## 任务与笔记关联

任务可以关联到笔记。在笔记中创建待办列表（`/待办`），对应的任务会出现在待办模块中。

---

## 使用场景

- 每日待办清单
- 项目任务管理
- 学习计划跟踪
- 生活事务管理

---

## 常见问题

### 图片显示为灰色占位符

如果任务中的图片显示为灰色占位方块，说明对应的物理文件已缺失（数据库中仍有记录但磁盘上的文件不存在）。

**原因：** 文件可能在同步、迁移或手动清理过程中被意外删除。

**处理方式：**

1. 进入「设置 → 数据 → 修复附件」，系统会扫描并标记缺失的附件记录
2. 修复操作会阻止系统继续误删仍被引用的附件，但已经丢失的物理文件无法自动恢复
3. 如果文件确实丢失，需要从备份中手动恢复对应的图片文件

**建议：** 定期备份数据目录，避免附件文件不可逆丢失。

---

## 下一步

- [说说使用教程](./diary.md) — 短内容记录
- [文档树使用教程](../tree-tutorial.md) — 笔记管理
- [思维导图入门](./mindmap-intro.md) — 思路整理

---

> 本教程基于 nowen-note v1.1.18 编写，最后更新于 2026-07-08。
