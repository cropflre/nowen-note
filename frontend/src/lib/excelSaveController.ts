/**
 * Excel 工作簿保存控制器（与 Univer 解耦，便于测试）。
 *
 * 重写自 cropflre/nowen-note PR #802 的 ExcelEditor 保存逻辑。PR 中 replaceWorkbook()
 * 先把新快照写入 savedJsonRef，performSave() 发现快照“相同”就跳过请求，导致导入成功
 * 却从未落库。这里不再用“快照是否与上次相同”判断，而是：
 *
 * - 每次修改递增 changeSeq；只有服务端返回新 revision（持久化确认）后才推进 persistedSeq；
 * - 保存期间继续编辑：请求结束后发现 changeSeq 更大，立即再存一次；
 * - 网络 / 5xx 失败：保留本地修改并按退避重试，不显示“已保存”；
 * - 409：停止自动保存，本地内容原样保留，由用户选择载入服务器版本或以本机版本覆盖；
 * - 离开页面：调用方先 freeze() 冻结当前快照再 flush()，编辑器销毁后保存仍继续，
 *   同一表格重新打开时通过 takePendingExcelSave() 接回未确认的本地版本。
 */

export type ExcelSaveStatus = "saved" | "dirty" | "saving" | "retrying" | "conflict" | "failed";
export type ExcelSnapshot = Record<string, unknown>;

export interface ExcelSaveError extends Error {
  code?: string;
  status?: number;
  payload?: { currentRevision?: number | null };
}

export interface ExcelSaveState {
  status: ExcelSaveStatus;
  revision: number;
  attempt: number;
  message?: string;
  conflictRevision?: number | null;
}

export interface ExcelSaveControllerOptions {
  noteId: string;
  revision: number;
  save: (snapshot: ExcelSnapshot, expectedRevision: number) => Promise<{ revision: number }>;
  readSnapshot: () => ExcelSnapshot | null;
  onChange?: (state: ExcelSaveState) => void;
  debounceMs?: number;
  retryDelaysMs?: number[];
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** 无法通过重试解决、需要用户处理的错误。 */
const PERMANENT_CODES = new Set(["FORBIDDEN", "EXCEL_NOT_FOUND", "INVALID_PAYLOAD", "EXCEL_TOO_LARGE"]);

export class ExcelSaveController {
  readonly noteId: string;
  private revision: number;
  private changeSeq = 0;
  private persistedSeq = 0;
  private status: ExcelSaveStatus = "saved";
  private attempt = 0;
  private message: string | undefined;
  private conflictRevision: number | null | undefined;
  private inFlight: Promise<void> | null = null;
  private timer: unknown = null;
  private frozen: ExcelSnapshot | null = null;
  private disposed = false;
  private readonly options: Required<Pick<ExcelSaveControllerOptions, "debounceMs" | "retryDelaysMs" | "setTimer" | "clearTimer">> & ExcelSaveControllerOptions;

  constructor(options: ExcelSaveControllerOptions) {
    this.noteId = options.noteId;
    this.revision = options.revision;
    this.options = {
      debounceMs: 600,
      retryDelaysMs: [1_000, 3_000, 10_000, 30_000],
      setTimer: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
      ...options,
    };
  }

  get state(): ExcelSaveState {
    return { status: this.status, revision: this.revision, attempt: this.attempt, message: this.message, conflictRevision: this.conflictRevision };
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 尚有未经服务端确认的修改。 */
  get hasUnsavedChanges(): boolean {
    return this.changeSeq > this.persistedSeq;
  }

  /** 编辑器替换回调（重新打开时接回控制器）。 */
  setCallbacks(readSnapshot: () => ExcelSnapshot | null, onChange?: (state: ExcelSaveState) => void): void {
    this.options.readSnapshot = readSnapshot;
    this.options.onChange = onChange;
    this.frozen = null;
    this.emit();
  }

  /** 编辑器即将销毁：冻结当前快照，之后的保存与重试都使用它。 */
  freeze(snapshot: ExcelSnapshot | null): void {
    if (snapshot) this.frozen = snapshot;
    this.options.onChange = undefined;
  }

  get frozenSnapshot(): ExcelSnapshot | null {
    return this.frozen;
  }

  markDirty(): void {
    if (this.disposed) return;
    this.changeSeq += 1;
    if (this.status === "conflict" || this.status === "failed") {
      // 冲突 / 永久失败期间的编辑只累积在本地，等待用户处理，不自动覆盖服务器。
      this.emit();
      return;
    }
    this.setStatus(this.inFlight ? "saving" : "dirty");
    this.schedule(this.options.debounceMs);
  }

  /** 立即保存；返回时所有已知修改是否都已得到服务端确认。 */
  async flush(): Promise<boolean> {
    this.cancelTimer();
    while (!this.disposed) {
      if (this.inFlight) {
        await this.inFlight;
        continue;
      }
      if (!this.hasUnsavedChanges) return true;
      if (this.status === "conflict" || this.status === "failed") return false;
      await this.saveOnce();
      if (this.status === "retrying") return false;
    }
    return !this.hasUnsavedChanges;
  }

  /** 用户在冲突后明确选择“以本机版本覆盖”：以服务器当前 revision 为基线重新保存。 */
  async overwriteServer(): Promise<boolean> {
    if (this.status !== "conflict" || typeof this.conflictRevision !== "number") return false;
    this.revision = this.conflictRevision;
    this.conflictRevision = undefined;
    this.setStatus("dirty");
    return this.flush();
  }

  /** 失败后用户点击“重试”。 */
  retryNow(): Promise<boolean> {
    if (this.status === "failed" || this.status === "retrying") {
      this.attempt = 0;
      this.setStatus("dirty");
    }
    return this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    this.timer = this.options.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.options.clearTimer(this.timer);
    this.timer = null;
  }

  private saveOnce(): Promise<void> {
    const snapshot = this.frozen ?? this.options.readSnapshot();
    if (!snapshot) {
      this.message = "无法读取表格内容，未保存";
      this.setStatus("failed");
      return Promise.resolve();
    }
    const seq = this.changeSeq;
    this.setStatus("saving");
    this.inFlight = (async () => {
      try {
        const result = await this.options.save(snapshot, this.revision);
        this.revision = result.revision;
        this.persistedSeq = Math.max(this.persistedSeq, seq);
        this.attempt = 0;
        this.message = undefined;
        if (this.hasUnsavedChanges) {
          this.setStatus("dirty");
          this.schedule(0);
        } else {
          this.setStatus("saved");
        }
      } catch (caught) {
        const error = caught as ExcelSaveError;
        if (error?.code === "EXCEL_CONFLICT" || error?.status === 409) {
          this.conflictRevision = error.payload?.currentRevision ?? null;
          this.message = "表格已在其他窗口或设备更新";
          this.setStatus("conflict");
        } else if (error?.code && PERMANENT_CODES.has(error.code)) {
          this.message = error.message || "保存被服务器拒绝";
          this.setStatus("failed");
        } else {
          const delays = this.options.retryDelaysMs;
          this.message = error?.message || "网络异常";
          this.attempt += 1;
          this.setStatus("retrying");
          this.schedule(delays[Math.min(this.attempt - 1, delays.length - 1)]);
        }
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  private setStatus(status: ExcelSaveStatus): void {
    this.status = status;
    this.emit();
  }

  private emit(): void {
    this.options.onChange?.(this.state);
  }
}

// ---------------------------------------------------------------------------
// 编辑器销毁后仍未确认的保存
// ---------------------------------------------------------------------------

const pending = new Map<string, ExcelSaveController>();

/** 编辑器销毁时登记仍有未确认修改的控制器，保存与重试在后台继续。 */
export function keepPendingExcelSave(controller: ExcelSaveController): void {
  // 已被用户明确放弃（例如冲突后选择载入服务器版本）的控制器不再接续。
  if (controller.isDisposed) return;
  if (!controller.hasUnsavedChanges) {
    controller.dispose();
    return;
  }
  pending.set(controller.noteId, controller);
  void controller.flush().then((saved) => {
    if (saved && pending.get(controller.noteId) === controller) {
      pending.delete(controller.noteId);
      controller.dispose();
    }
  });
}

/** 重新打开同一表格时接回未确认的本地版本，避免用服务器旧版本覆盖它。 */
export function takePendingExcelSave(noteId: string): ExcelSaveController | null {
  const controller = pending.get(noteId) || null;
  pending.delete(noteId);
  return controller;
}

export function hasPendingExcelSaves(): boolean {
  for (const controller of pending.values()) if (controller.hasUnsavedChanges) return true;
  return false;
}
