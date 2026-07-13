import { describe, expect, it } from "vitest";
import { shouldConfirmHabitDelete } from "../tasks/taskCenterHardening";

describe("TaskCenter hardening", () => {
  it("recognizes the destructive habit delete control", () => {
    const row = document.createElement("div");
    row.dataset.nowenHabitRow = "true";
    const button = document.createElement("button");
    const icon = document.createElement("svg");
    icon.classList.add("lucide-trash-2");
    button.appendChild(icon);
    row.appendChild(button);
    expect(shouldConfirmHabitDelete(icon)).toBe(true);
  });
});
