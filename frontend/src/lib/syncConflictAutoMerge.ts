import type { ConflictDetail } from "@/lib/syncLocalApi";

const ABSENT = Symbol("absent");
const TRANSPORT_FIELDS = new Set(["baseUpdatedAt"]);

type MissingValue = typeof ABSENT;
type MergeValue = unknown | MissingValue;

export type AutomaticConflictMergeResult =
  | {
      ok: true;
      payload: Record<string, unknown>;
      mergedFields: string[];
    }
  | {
      ok: false;
      reason: "missing-base" | "missing-side" | "overlapping-changes";
      conflictFields: string[];
    };

function valueAt(payload: Record<string, unknown>, key: string): MergeValue {
  return Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : ABSENT;
}

function valuesEqual(left: MergeValue, right: MergeValue): boolean {
  if (left === ABSENT || right === ABSENT) return left === right;
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
    return [...keys].every((key) => valuesEqual(
      valueAt(leftRecord, key),
      valueAt(rightRecord, key),
    ));
  }
  return false;
}

function assignValue(target: Record<string, unknown>, key: string, value: MergeValue): void {
  if (value !== ABSENT) target[key] = value;
}

/**
 * 对一个 Sync V2 冲突执行保守的三方字段合并。
 *
 * - 只有本机修改：采用本机；
 * - 只有服务器修改：采用服务器；
 * - 两边改成相同值：直接采用；
 * - 两边把同一字段改成不同值：拒绝自动合并，继续留在冲突中心。
 *
 * version 采用服务器当前版本，updatedAt 保留本机修改时间；真正推送时
 * Embedded Backend 仍会使用冲突记录里的 remoteVersion/baseUpdatedAt 做并发校验。
 */
export function buildAutomaticConflictMerge(
  detail: Pick<ConflictDetail, "base" | "local" | "remote">,
): AutomaticConflictMergeResult {
  if (!detail.local || !detail.remote) {
    return { ok: false, reason: "missing-side", conflictFields: [] };
  }
  if (!detail.base) {
    return { ok: false, reason: "missing-base", conflictFields: [] };
  }

  const keys = new Set([
    ...Object.keys(detail.base),
    ...Object.keys(detail.local),
    ...Object.keys(detail.remote),
  ]);
  const payload: Record<string, unknown> = {};
  const mergedFields: string[] = [];
  const conflictFields: string[] = [];

  for (const key of [...keys].sort()) {
    if (TRANSPORT_FIELDS.has(key)) continue;

    const baseValue = valueAt(detail.base, key);
    const localValue = valueAt(detail.local, key);
    const remoteValue = valueAt(detail.remote, key);

    if (key === "version") {
      assignValue(payload, key, remoteValue !== ABSENT ? remoteValue : localValue);
      continue;
    }
    if (key === "updatedAt") {
      assignValue(payload, key, localValue !== ABSENT ? localValue : remoteValue);
      continue;
    }

    if (valuesEqual(localValue, remoteValue)) {
      assignValue(payload, key, localValue);
      if (!valuesEqual(localValue, baseValue)) mergedFields.push(key);
      continue;
    }
    if (valuesEqual(localValue, baseValue)) {
      assignValue(payload, key, remoteValue);
      mergedFields.push(key);
      continue;
    }
    if (valuesEqual(remoteValue, baseValue)) {
      assignValue(payload, key, localValue);
      mergedFields.push(key);
      continue;
    }

    conflictFields.push(key);
  }

  if (conflictFields.length > 0) {
    return {
      ok: false,
      reason: "overlapping-changes",
      conflictFields,
    };
  }

  return {
    ok: true,
    payload,
    mergedFields: [...new Set(mergedFields)].sort(),
  };
}
