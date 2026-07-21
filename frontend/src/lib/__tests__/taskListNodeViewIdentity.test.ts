import { afterEach, describe, expect, it } from "vitest";
import { normalizeTaskListNodeViewIdentity } from "@/lib/taskListNodeViewIdentity";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("normalizeTaskListNodeViewIdentity", () => {
  it("restores the canonical task list and task item data types", () => {
    document.body.innerHTML = `
      <ul class="task-list">
        <li class="task-item"><label><input type="checkbox"></label><div><p>待办</p></div></li>
      </ul>
    `;

    expect(normalizeTaskListNodeViewIdentity(document.body)).toBe(2);
    expect(document.querySelector("ul.task-list")?.getAttribute("data-type")).toBe("taskList");
    expect(document.querySelector("li.task-item")?.getAttribute("data-type")).toBe("taskItem");
  });

  it("is idempotent and does not touch ordinary bullet list items", () => {
    document.body.innerHTML = `
      <ul class="task-list" data-type="taskList">
        <li class="task-item" data-type="taskItem"><p>待办</p></li>
      </ul>
      <ul><li class="ordinary-item"><p>普通列表</p></li></ul>
    `;

    expect(normalizeTaskListNodeViewIdentity(document.body)).toBe(0);
    expect(document.querySelector("li.ordinary-item")?.hasAttribute("data-type")).toBe(false);
  });

  it("normalizes an added task item subtree without scanning unrelated siblings", () => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `<li class="task-item"><div><p>动态待办</p></div></li>`;

    expect(normalizeTaskListNodeViewIdentity(wrapper)).toBe(1);
    expect(wrapper.querySelector("li")?.getAttribute("data-type")).toBe("taskItem");
  });
});
