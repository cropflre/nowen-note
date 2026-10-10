import { describe, expect, it } from "vitest";
import { getPluginRuntimePresentation, isDeclarativePluginRuntime } from "../pluginRuntimePresentation";

describe("plugin runtime presentation", () => {
  it("identifies declarative extensions by runtime or execution mode", () => {
    expect(isDeclarativePluginRuntime({ runtime: "declarative" })).toBe(true);
    expect(isDeclarativePluginRuntime({ executionMode: "declarative-zero-code" })).toBe(true);
    expect(isDeclarativePluginRuntime({ runtime: "sandbox-js", executionMode: "executable" })).toBe(false);
  });

  it("presents declarative extensions as zero-code and zero-data-permission", () => {
    expect(getPluginRuntimePresentation({
      runtime: "declarative",
      executionMode: "declarative-zero-code",
      permissions: [],
      actions: [],
    })).toEqual({
      declarative: true,
      runtimeLabel: "声明式",
      executionLabel: "不执行代码",
      permissionLabel: "零数据权限",
      canExecuteActions: false,
      requiresPermissionConfirmation: false,
      enableLabel: "启用扩展",
    });
  });

  it("keeps executable extensions on the permission-confirmation path", () => {
    const presentation = getPluginRuntimePresentation({
      runtime: "sandbox-js",
      executionMode: "executable",
      permissions: [{ permission: "notes:read" }],
      actions: [{ id: "demo" }],
    });

    expect(presentation.declarative).toBe(false);
    expect(presentation.canExecuteActions).toBe(true);
    expect(presentation.requiresPermissionConfirmation).toBe(true);
    expect(presentation.enableLabel).toBe("确认权限并启用");
    expect(presentation.executionLabel).toBe("1 Actions");
  });
});
