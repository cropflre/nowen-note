export const zhCNMiCloudProgressTranslations = {
  miCloud: {
    progressCancelling: "正在取消导入，已处理 {{processed}} / {{total}}",
    progressRunning: "正在导入 {{processed}} / {{total}}，成功 {{succeeded}}，失败 {{failed}}",
    cancelledSummary: "导入已取消，已成功导入 {{count}} 条",
    cancelFailed: "取消导入失败",
    retryingFailed: "正在重试 {{count}} 条失败项…",
    retryFailedFailed: "重试失败项失败",
    cancellingLabel: "正在取消",
    backgroundTask: "后台导入任务",
    progressStats: "成功 {{succeeded}} · 失败 {{failed}}",
    currentItem: "当前 {{id}}",
    cancellingAction: "取消中",
    cancelAction: "取消导入",
    retryFailedAction: "重试 {{count}} 条失败项",
    progressButton: "正在导入 {{processed}} / {{total}}",
  },
} as const;

export const enMiCloudProgressTranslations = {
  miCloud: {
    progressCancelling: "Cancelling import, {{processed}} / {{total}} processed",
    progressRunning: "Importing {{processed}} / {{total}}, {{succeeded}} succeeded, {{failed}} failed",
    cancelledSummary: "Import cancelled after {{count}} successful imports",
    cancelFailed: "Failed to cancel import",
    retryingFailed: "Retrying {{count}} failed items…",
    retryFailedFailed: "Failed to retry failed items",
    cancellingLabel: "Cancelling",
    backgroundTask: "Background import task",
    progressStats: "{{succeeded}} succeeded · {{failed}} failed",
    currentItem: "Current: {{id}}",
    cancellingAction: "Cancelling",
    cancelAction: "Cancel import",
    retryFailedAction: "Retry {{count}} failed items",
    progressButton: "Importing {{processed}} / {{total}}",
  },
} as const;
