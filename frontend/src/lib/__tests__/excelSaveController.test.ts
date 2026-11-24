// Excel 保存可靠性。修复 cropflre/nowen-note PR #802 评审指出的 replaceWorkbook()/savedJsonRef 跳过保存问题。
import { describe, expect, it } from "vitest";

import {
  ExcelSaveController,
  hasPendingExcelSaves,
  keepPendingExcelSave,
  takePendingExcelSave,
  type ExcelSaveError,
  type ExcelSnapshot,
  type ExcelSaveStatus,
} from "@/lib/excelSaveController";

/** 带乐观锁的内存服务器，行为与 PUT /api/excels/:id 一致。 */
function fakeServer(initial: ExcelSnapshot) {
  const server = { revision: 1, data: initial, writes: [] as Array<{ data: ExcelSnapshot; expected: number }>, fail: null as null | (() => ExcelSaveError) };
  const save = async (data: ExcelSnapshot, expected: number) => {
    await Promise.resolve();
    server.writes.push({ data, expected });
    if (server.fail) throw server.fail();
    if (expected !== server.revision) {
      throw Object.assign(new Error("conflict"), { code: "EXCEL_CONFLICT", status: 409, payload: { currentRevision: server.revision } });
    }
    server.revision += 1;
    server.data = structuredClone(data);
    return { revision: server.revision };
  };
  return { server, save };
}

function manualTimers() {
  const timers: Array<{ callback: () => void; ms: number }> = [];
  return {
    timers,
    setTimer: (callback: () => void, ms: number) => { const entry = { callback, ms }; timers.push(entry); return entry; },
    clearTimer: (handle: unknown) => { const index = timers.indexOf(handle as never); if (index >= 0) timers.splice(index, 1); },
    async runNext() {
      timers.shift()?.callback();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    },
    async runAll() {
      while (timers.length) {
        timers.shift()!.callback();
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      }
    },
  };
}

const workbook = (value: string) => ({ id: "wb", sheets: { s1: { cellData: { 0: { 0: { v: value } } } } } });
const valueOf = (data: ExcelSnapshot) => (data as { sheets: { s1: { cellData: Record<number, Record<number, { v: string }>> } } }).sheets.s1.cellData[0][0].v;

describe("ExcelSaveController", () => {
  it("DCC-001: 导入后立即离开也会真正写入，且只在服务端确认后才算已保存", async () => {
    const { server, save } = fakeServer(workbook("旧"));
    const timers = manualTimers();
    let current = workbook("导入的内容");
    const statuses: ExcelSaveStatus[] = [];
    const controller = new ExcelSaveController({
      noteId: "n1", revision: 1, save, readSnapshot: () => current,
      onChange: (state) => statuses.push(state.status), ...timers,
    });
    controller.markDirty(); // replaceWorkbook()
    expect(controller.hasUnsavedChanges).toBe(true);
    expect(statuses).not.toContain("saved");

    controller.freeze(current); // 编辑器卸载前冻结
    current = workbook("编辑器已销毁");
    keepPendingExcelSave(controller);
    expect(hasPendingExcelSaves()).toBe(true);
    await timers.runAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(valueOf(server.data)).toBe("导入的内容");
    expect(server.revision).toBe(2);
    expect(hasPendingExcelSaves()).toBe(false);
  });

  it("保存进行中继续编辑：请求返回后用最新内容和新 revision 再存一次", async () => {
    const { server, save } = fakeServer(workbook("v0"));
    const timers = manualTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let current = workbook("v1");
    const controller = new ExcelSaveController({
      noteId: "n2", revision: 1,
      save: async (data, expected) => { if (server.writes.length === 0) await gate; return save(data, expected); },
      readSnapshot: () => current, ...timers,
    });
    controller.markDirty();
    const flushing = controller.flush();
    current = workbook("v2");
    controller.markDirty();
    expect(controller.state.status).toBe("saving");
    release();
    await flushing;
    await timers.runAll();
    await controller.flush();
    expect(server.writes.map((write) => [valueOf(write.data), write.expected])).toEqual([["v1", 1], ["v2", 2]]);
    expect(controller.state).toMatchObject({ status: "saved", revision: 3 });
    expect(controller.hasUnsavedChanges).toBe(false);
  });

  it("DCC-003: 网络失败保留本地修改并退避重试，成功前不显示已保存", async () => {
    const { server, save } = fakeServer(workbook("v0"));
    const timers = manualTimers();
    const statuses: ExcelSaveStatus[] = [];
    const controller = new ExcelSaveController({
      noteId: "n3", revision: 1, save, readSnapshot: () => workbook("离线编辑"),
      onChange: (state) => statuses.push(state.status), retryDelaysMs: [5, 50], ...timers,
    });
    server.fail = () => Object.assign(new Error("Failed to fetch"), { status: 0 });
    controller.markDirty();
    expect(await controller.flush()).toBe(false);
    expect(controller.state).toMatchObject({ status: "retrying", attempt: 1 });
    expect(timers.timers.map((timer) => timer.ms)).toEqual([5]);
    expect(statuses).not.toContain("saved");

    server.fail = () => Object.assign(new Error("Bad gateway"), { status: 502 });
    await timers.runNext();
    // 第二次失败后退避到 50ms，修改仍未丢失
    expect(controller.state.attempt).toBe(2);
    expect(timers.timers.map((timer) => timer.ms)).toEqual([50]);
    expect(controller.hasUnsavedChanges).toBe(true);
    server.fail = null;
    await timers.runNext();
    expect(controller.state.status).toBe("saved");
    expect(valueOf(server.data)).toBe("离线编辑");
  });

  it("DCC-004: 两窗口冲突时保留本机内容、停止自动覆盖，用户确认后才覆盖服务器", async () => {
    const { server, save } = fakeServer(workbook("原始"));
    const timersA = manualTimers();
    const timersB = manualTimers();
    const windowA = new ExcelSaveController({ noteId: "n4", revision: 1, save, readSnapshot: () => workbook("A 的修改"), ...timersA });
    let localB = workbook("B 的修改");
    const windowB = new ExcelSaveController({ noteId: "n4", revision: 1, save, readSnapshot: () => localB, ...timersB });
    windowA.markDirty();
    expect(await windowA.flush()).toBe(true);
    windowB.markDirty();
    expect(await windowB.flush()).toBe(false);
    expect(windowB.state).toMatchObject({ status: "conflict", conflictRevision: 2 });
    expect(valueOf(server.data)).toBe("A 的修改");

    localB = workbook("B 继续编辑");
    windowB.markDirty();
    await timersB.runAll();
    expect(server.writes).toHaveLength(2); // 冲突期间不自动保存
    expect(windowB.hasUnsavedChanges).toBe(true);

    expect(await windowB.overwriteServer()).toBe(true);
    expect(valueOf(server.data)).toBe("B 继续编辑");
    expect(server.writes.at(-1)!.expected).toBe(2);
  });

  it("权限或体积等永久错误不重试，也不清除未保存标记", async () => {
    const { server, save } = fakeServer(workbook("v0"));
    const timers = manualTimers();
    const controller = new ExcelSaveController({ noteId: "n5", revision: 1, save, readSnapshot: () => workbook("x"), ...timers });
    server.fail = () => Object.assign(new Error("无权修改该 Excel 表格"), { code: "FORBIDDEN", status: 403 });
    controller.markDirty();
    expect(await controller.flush()).toBe(false);
    expect(controller.state).toMatchObject({ status: "failed", message: "无权修改该 Excel 表格" });
    expect(timers.timers.filter((timer) => timer.ms > 0)).toEqual([]);
    expect(controller.hasUnsavedChanges).toBe(true);
  });

  it("离开时仍未确认的版本在重新打开时被接回，而不是被服务器旧版本替换", async () => {
    const { server, save } = fakeServer(workbook("服务器旧版"));
    const timers = manualTimers();
    const controller = new ExcelSaveController({ noteId: "n6", revision: 1, save, readSnapshot: () => workbook("未确认的本地版本"), ...timers });
    server.fail = () => Object.assign(new Error("offline"), { status: 0 });
    controller.markDirty();
    controller.freeze(workbook("未确认的本地版本"));
    keepPendingExcelSave(controller);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hasPendingExcelSaves()).toBe(true);

    const reopened = takePendingExcelSave("n6");
    expect(reopened).toBe(controller);
    expect(valueOf(reopened!.frozenSnapshot!)).toBe("未确认的本地版本");
    server.fail = null;
    reopened!.setCallbacks(() => workbook("未确认的本地版本"));
    expect(await reopened!.retryNow()).toBe(true);
    expect(valueOf(server.data)).toBe("未确认的本地版本");
    reopened!.dispose();
  });
});
