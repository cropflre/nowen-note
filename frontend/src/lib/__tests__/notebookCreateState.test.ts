import { describe, expect, it, vi } from "vitest";
import {
  cleanupCancelledNotebook,
  createOptimisticNotebook,
  findNotebookCreateOperation,
  isTemporaryNotebookId,
  mergeAuthoritativeNotebooks,
  notebookCreateReducer,
  replaceOptimisticNotebook,
  withoutTemporaryNotebooks,
  type NotebookCreateOperation,
} from "@/lib/notebookCreateState";
import type { Notebook } from "@/types";

function operation(id: string): NotebookCreateOperation {
  return {
    operationId: id,
    tempId: `temp-notebook:${id}`,
    parentId: null,
    workspaceId: "personal",
    name: "新笔记本",
    status: "pending",
    submitted: false,
  };
}

function serverNotebook(id: string, name = "新笔记本"): Notebook {
  return {
    ...createOptimisticNotebook(operation(id), "📒", "2026-01-01T00:00:00.000Z"),
    id: `server:${id}`,
    name,
  };
}

describe("notebook create state", () => {
  it("keeps concurrent operations independent and preserves the latest typed name", () => {
    let state = notebookCreateReducer({}, { type: "start", operation: operation("a") });
    state = notebookCreateReducer(state, { type: "start", operation: operation("b") });
    state = notebookCreateReducer(state, { type: "name", operationId: "a", name: "Alpha" });
    state = notebookCreateReducer(state, { type: "submit", operationId: "a", name: "Alpha final" });
    state = notebookCreateReducer(state, {
      type: "confirm",
      operationId: "a",
      notebook: serverNotebook("a"),
    });
    state = notebookCreateReducer(state, { type: "fail", operationId: "b", error: "forbidden" });

    expect(state.a).toMatchObject({
      name: "Alpha final",
      submitted: true,
      status: "confirmed",
      serverId: "server:a",
    });
    expect(state.b).toMatchObject({ status: "failed", error: "forbidden" });
    expect(findNotebookCreateOperation(state, "temp-notebook:a")?.operationId).toBe("a");
    expect(findNotebookCreateOperation(state, "server:a")?.operationId).toBe("a");
  });

  it("retries without losing input and removes only the finished or cancelled operation", () => {
    let state = notebookCreateReducer({}, { type: "start", operation: operation("a") });
    state = notebookCreateReducer(state, { type: "start", operation: operation("b") });
    state = notebookCreateReducer(state, { type: "name", operationId: "a", name: "保留名称" });
    state = notebookCreateReducer(state, { type: "fail", operationId: "a", error: "offline" });
    state = notebookCreateReducer(state, { type: "pending", operationId: "a" });
    expect(state.a).toMatchObject({ name: "保留名称", status: "pending" });
    expect(state.a.error).toBeUndefined();

    state = notebookCreateReducer(state, { type: "cancel", operationId: "a" });
    expect(state.a).toBeUndefined();
    expect(state.b).toBeDefined();
    state = notebookCreateReducer(state, { type: "finish", operationId: "b" });
    expect(state).toEqual({});
  });

  it("creates a temporary notebook in the requested workspace and parent", () => {
    const nested = { ...operation("nested"), workspaceId: "team-1", parentId: "parent-1" };
    expect(createOptimisticNotebook(nested, "📁", "2026-01-01T00:00:00.000Z")).toMatchObject({
      id: "temp-notebook:nested",
      workspaceId: "team-1",
      parentId: "parent-1",
      name: "新笔记本",
      icon: "📁",
      isExpanded: 0,
    });
  });

  it("keeps temporary notebooks out of persisted notebook operations", () => {
    const persisted = serverNotebook("persisted");
    const temporary = createOptimisticNotebook(operation("temporary"), "📒");

    expect(isTemporaryNotebookId(temporary.id)).toBe(true);
    expect(withoutTemporaryNotebooks([persisted, temporary])).toEqual([persisted]);
  });

  it("preserves pending rows across authoritative refreshes without cloning them", () => {
    const temporary = createOptimisticNotebook(operation("temporary"), "📒");
    const authoritative = serverNotebook("authoritative");
    const merged = mergeAuthoritativeNotebooks([temporary], [authoritative]);

    expect(merged).toEqual([authoritative, temporary]);
    expect(merged[1]).toBe(temporary);
  });

  it("deduplicates a broadcast server entity when replacing its temporary row", () => {
    const temporary = createOptimisticNotebook(operation("temporary"), "📒");
    const server = serverNotebook("temporary");
    const sibling = serverNotebook("sibling");
    const replaced = replaceOptimisticNotebook(
      [sibling, temporary, server],
      temporary.id,
      server,
    );

    expect(replaced).toEqual([sibling, server]);
    expect(replaced[0]).toBe(sibling);
    expect(replaced[1]).toBe(server);
  });
});

describe("cancelled notebook compensation", () => {
  it("deletes only the exact server id acknowledged for that operation", async () => {
    const deleteNotebook = vi.fn().mockResolvedValue(undefined);
    const onFailure = vi.fn();

    await expect(cleanupCancelledNotebook(
      "operation-a",
      "server-created-by-operation-a",
      deleteNotebook,
      onFailure,
    )).resolves.toBe("deleted");
    expect(deleteNotebook).toHaveBeenCalledTimes(1);
    expect(deleteNotebook).toHaveBeenCalledWith("server-created-by-operation-a");
    expect(deleteNotebook).not.toHaveBeenCalledWith("server-created-by-operation-b");
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("treats 404 as already cleaned", async () => {
    const deleteNotebook = vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { status: 404 }));
    const onFailure = vi.fn();

    await expect(cleanupCancelledNotebook(
      "operation-a",
      "server-a",
      deleteNotebook,
      onFailure,
    )).resolves.toBe("not-found");
    expect(deleteNotebook).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it.each([403, 409, 500, undefined])(
    "reports status %s once without retrying or claiming success",
    async (status) => {
      const error = Object.assign(new Error("cleanup failed"), { status });
      const deleteNotebook = vi.fn().mockRejectedValue(error);
      const onFailure = vi.fn();

      await expect(cleanupCancelledNotebook(
        "operation-a",
        "server-a",
        deleteNotebook,
        onFailure,
      )).resolves.toBe("failed");
      expect(deleteNotebook).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledWith({
        operationId: "operation-a",
        notebookId: "server-a",
        status,
        error,
      });
    },
  );
});
