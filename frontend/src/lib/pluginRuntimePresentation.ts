export type PluginRuntimeLike = {
  runtime?: string | null;
  executionMode?: string | null;
  permissions?: readonly unknown[] | null;
  actions?: readonly unknown[] | null;
};

export type PluginRuntimePresentation = {
  declarative: boolean;
  runtimeLabel: string;
  executionLabel: string;
  permissionLabel: string;
  canExecuteActions: boolean;
  requiresPermissionConfirmation: boolean;
  enableLabel: string;
};

export function isDeclarativePluginRuntime(plugin: PluginRuntimeLike): boolean {
  return plugin.runtime === "declarative" || plugin.executionMode === "declarative-zero-code";
}

export function getPluginRuntimePresentation(plugin: PluginRuntimeLike): PluginRuntimePresentation {
  if (isDeclarativePluginRuntime(plugin)) {
    return {
      declarative: true,
      runtimeLabel: "声明式",
      executionLabel: "不执行代码",
      permissionLabel: "零数据权限",
      canExecuteActions: false,
      requiresPermissionConfirmation: false,
      enableLabel: "启用扩展",
    };
  }

  return {
    declarative: false,
    runtimeLabel: plugin.runtime || "executable",
    executionLabel: `${plugin.actions?.length ?? 0} Actions`,
    permissionLabel: plugin.permissions?.length ? "需要权限确认" : "不请求数据权限",
    canExecuteActions: true,
    requiresPermissionConfirmation: true,
    enableLabel: "确认权限并启用",
  };
}
