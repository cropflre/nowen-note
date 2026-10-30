export const zhCNTaskRemovalTranslations = { taskRemoval: {
  title: "循环任务操作", single: "仅删除本次", stop: "终止后续循环", series: "删除整个系列",
  stopped: "此循环已终止，请另建循环任务。",
  upgradeServer: "请升级服务器后再操作整个循环系列。",
  invalidDate: "日期异常，请编辑修复",
  singleHint: "删除本次及其子任务，其他实例不受影响；尚未完成的本次将跳过并生成下一次。",
  stopHint: "保留历史和已生成的任务，停止整个系列继续生成新任务。",
  seriesHint: "删除同一循环系列的所有任务及子任务，包括已完成和已归档的任务。",
  range: "当前已加载的影响范围：{{count}} 个任务。", rangeFailed: "无法加载完整范围，请检查连接；同步时会处理整个系列。",
  seriesWarning: "此操作不可撤销。同步后其他设备上的同一系列也会删除。",
  bulkSingle: "批量删除仅删除选中的本次任务及子任务，循环仍会继续。确认删除？",
} };
export const enTaskRemovalTranslations = { taskRemoval: {
  title: "Recurring task actions", single: "Delete this occurrence", stop: "Stop recurrence", series: "Delete entire series",
  stopped: "This recurrence has ended. Create a new recurring task.",
  upgradeServer: "Upgrade the server before changing the entire recurring series.",
  invalidDate: "Invalid date; edit to repair",
  singleHint: "Delete this occurrence and its subtasks. Other occurrences remain; an unfinished occurrence is skipped and the next one is generated.",
  stopHint: "Keep history and existing tasks, and stop generating new occurrences throughout this series.",
  seriesHint: "Delete every task and subtask in this series, including completed and archived tasks.",
  range: "Currently loaded affected tasks: {{count}}.", rangeFailed: "Could not load the full range. Check your connection; sync will process the entire series.",
  seriesWarning: "This cannot be undone. Sync also deletes this series on other devices.",
  bulkSingle: "Bulk deletion deletes only the selected occurrences and their subtasks. Recurrence will continue. Delete?",
} };
