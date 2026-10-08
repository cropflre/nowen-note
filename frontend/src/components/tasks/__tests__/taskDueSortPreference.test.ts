// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  loadTaskDueSort,
  saveTaskDueSort,
  TASK_DUE_SORT_PREFERENCE_KEY,
} from "../taskDueSortPreference";

afterEach(() => localStorage.removeItem(TASK_DUE_SORT_PREFERENCE_KEY));

describe("due sorting preference", () => {
  it("defaults to manual order and persists the selected mode", () => {
    expect(loadTaskDueSort()).toBe(false);
    saveTaskDueSort(true);
    expect(localStorage.getItem(TASK_DUE_SORT_PREFERENCE_KEY)).toBe("1");
    expect(loadTaskDueSort()).toBe(true);
    saveTaskDueSort(false);
    expect(loadTaskDueSort()).toBe(false);
  });
});
