import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import type { Task } from "@/types";
import { parseRepeatRuleRequestValue } from "@/components/tasks/customRepeatRule";

const INSTALL_KEY = "__NOWEN_TASK_UPDATE_SAFETY_BRIDGE_V1__";

type TaskPatch = Partial<Task> & { repeatRuleJson?: unknown };

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizeTaskRepeatRequest<T extends TaskPatch>(patch: T): T {
  if (!hasOwn(patch, "repeatRuleJson")) return patch;
  return {
    ...patch,
    repeatRuleJson: parseRepeatRuleRequestValue(patch.repeatRuleJson),
  } as T;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const value = error as { error?: unknown; message?: unknown };
    if (typeof value.error === "string") return value.error;
    if (typeof value.message === "string") return value.message;
  }
  return "服务器未接受本次修改";
}

function shouldShowUpdateToast(patch: TaskPatch): boolean {
  // TaskCenter already has dedicated messages for description and Gantt date-range failures.
  if (hasOwn(patch, "description")) return false;
  const keys = Object.keys(patch);
  if (keys.length > 0 && keys.every((key) => key === "startDate" || key === "dueDate")) return false;
  return true;
}

export function installTaskUpdateSafetyBridge(): void {
  if (typeof window === "undefined") return;
  const host = window as unknown as Record<string, unknown>;
  if (host[INSTALL_KEY]) return;
  host[INSTALL_KEY] = true;

  const nativeCreateTask = api.createTask.bind(api);
  const nativeUpdateTask = api.updateTask.bind(api);

  api.createTask = ((patch: Partial<Task>) => (
    nativeCreateTask(normalizeTaskRepeatRequest(patch) as Partial<Task>)
  )) as typeof api.createTask;

  api.updateTask = (async (id: string, patch: Partial<Task>) => {
    const requestPatch = normalizeTaskRepeatRequest(patch);
    try {
      return await nativeUpdateTask(id, requestPatch as Partial<Task>);
    } catch (error) {
      if (shouldShowUpdateToast(patch)) {
        const repeatUpdate = hasOwn(patch, "repeatRule") || hasOwn(patch, "repeatRuleJson");
        const prefix = repeatUpdate ? "自定义重复规则保存失败" : "任务保存失败";
        toast.error(`${prefix}：${errorDetail(error)}`);
      }
      throw error;
    }
  }) as typeof api.updateTask;
}
