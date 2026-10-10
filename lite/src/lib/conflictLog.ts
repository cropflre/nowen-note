/**
 * 版本冲突台账（本机）。
 *
 * 为什么要有它：Lite 是薄客户端，服务端对内容类变更强制校验 version，
 * 不一致就回 409 VERSION_CONFLICT。这个冲突原本只弹一次对话框就没了 ——
 * 用户点掉之后**再也想不起来哪几篇没处理**。
 * 有了台账，「设置 → 同步诊断 → 未解决冲突」就是一个真实的数字，
 * 点进去还能看到是哪几篇。
 *
 * ⚠️ 边界：
 *   · 只存本机（localStorage），不上报服务端 —— 冲突是"这台设备的一次交互"，
 *     不是服务端事实；换设备看到的是那台设备自己遇到过的冲突。
 *   · 有上限（MAX），超出丢最旧的 —— 台账无限增长只会拖慢诊断表的渲染。
 *   · 记录里**不存正文**，只留 id/标题/版本号，避免把笔记内容复制到第二处。
 */
import { useEffect, useState } from "react";

const KEY = "nowen-lite.conflicts";
/** 最多留多少条（诊断表只展示最近几条，但保留一些历史便于回溯） */
const MAX = 50;

export type ConflictResolution = "overwrite" | "reload" | "dismiss";

export interface ConflictRecord {
  id: string;
  noteId: string;
  noteTitle: string;
  /** 本机这份基于的版本 */
  localVersion: number;
  /** 服务端当前的版本 */
  serverVersion: number;
  at: number;
  resolvedAt: number | null;
  resolution?: ConflictResolution;
}

const listeners = new Set<() => void>();

function read(): ConflictRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ConflictRecord[]) : [];
  } catch {
    return [];
  }
}

function write(list: ConflictRecord[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* 超配额/隐私模式：台账丢了不影响主流程 */
  }
  for (const fn of listeners) fn();
}

/** 记一笔冲突；返回记录 id（用于之后标记已解决） */
export function logConflict(entry: {
  noteId: string;
  noteTitle: string;
  localVersion: number;
  serverVersion: number;
}): string {
  // ⚠️ 必须带随机后缀：只用 `${noteId}:${Date.now()}` 时，
  //    同一毫秒内的两次调用会生成**相同 id**，之后按 id 标记已解决就会张冠李戴
  //    （实测导致"标记后仍未解决"的偶发失败）。
  const id = `${entry.noteId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  // 同一篇笔记短时间内重复冲突（用户反复点保存）只留一条，避免刷屏
  const list = read().filter(
    (c) => !(c.noteId === entry.noteId && c.resolvedAt === null && Date.now() - c.at < 60_000),
  );
  list.unshift({
    id,
    noteId: entry.noteId,
    noteTitle: entry.noteTitle || "(无标题)",
    localVersion: entry.localVersion,
    serverVersion: entry.serverVersion,
    at: Date.now(),
    resolvedAt: null,
  });
  write(list);
  return id;
}

export function listConflicts(): ConflictRecord[] {
  return read();
}

/** 未解决的（诊断表那个数字就是它） */
export function unresolvedConflicts(): ConflictRecord[] {
  return read().filter((c) => c.resolvedAt === null);
}

export function resolveConflict(id: string, resolution: ConflictResolution): void {
  write(
    read().map((c) =>
      c.id === id ? { ...c, resolvedAt: Date.now(), resolution } : c,
    ),
  );
}

/** 把全部未解决标记为"我知道了" */
export function dismissAllConflicts(): void {
  const now = Date.now();
  write(
    read().map((c) =>
      c.resolvedAt === null ? { ...c, resolvedAt: now, resolution: "dismiss" as const } : c,
    ),
  );
}

export function clearConflicts(): void {
  write([]);
}

export function subscribeConflicts(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 组件订阅（台账变化时重渲染） */
export function useConflicts(): ConflictRecord[] {
  const [, force] = useState(0);
  useEffect(() => subscribeConflicts(() => force((n) => n + 1)), []);
  return read();
}
