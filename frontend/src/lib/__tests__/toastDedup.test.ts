// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeToasts, toast, type ToastItem } from "@/lib/toast";

describe("toast burst deduplication", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T09:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses the same near-simultaneous Android error into one toast", () => {
    let latest: ToastItem[] = [];
    const unsubscribe = subscribeToasts((items) => {
      latest = items;
    });

    const first = toast.error("权限不足");
    const duplicate = toast.error("权限不足");
    const duplicateAgain = toast.error("权限不足");

    expect(duplicate).toBe(first);
    expect(duplicateAgain).toBe(first);
    expect(latest.filter((item) => item.message === "权限不足")).toHaveLength(1);

    toast.dismiss(first);
    unsubscribe();
  });

  it("allows the same message again after the burst window", () => {
    let latest: ToastItem[] = [];
    const unsubscribe = subscribeToasts((items) => {
      latest = items;
    });

    const first = toast.error("权限不足");
    vi.advanceTimersByTime(901);
    const later = toast.error("权限不足");

    expect(later).not.toBe(first);
    expect(latest.filter((item) => item.message === "权限不足")).toHaveLength(2);

    toast.dismiss(first);
    toast.dismiss(later);
    unsubscribe();
  });
});
