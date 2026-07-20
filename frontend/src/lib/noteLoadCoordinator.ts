export const NOTE_LOADING_DELAY_MS = 150;
export const NOTE_LOADING_MIN_VISIBLE_MS = 180;
export const NOTE_LOADING_SLOW_MS = 800;
export const NOTE_LOADING_TIMEOUT_MS = 10_000;

export interface NoteLoadSummary {
  title: string;
  notebookId: string;
  contentFormat?: string;
}

export interface NoteLoadBeginPayload {
  requestId: number;
  noteId: string;
  summary: NoteLoadSummary;
  startedAt: number;
}

export interface NoteLoadSink {
  begin(payload: NoteLoadBeginPayload): void;
  show(requestId: number): void;
  markSlow(requestId: number): void;
  finish(requestId: number): void;
  fail(requestId: number, error: string): void;
}

export interface NoteLoadOptions<T> {
  noteId: string;
  summary: NoteLoadSummary;
  request: () => Promise<T>;
  sink: NoteLoadSink;
  onSuccess: (value: T) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export type NoteLoadResult<T> =
  | { status: "success"; value: T }
  | { status: "cancelled" }
  | { status: "error"; error: Error };

interface ActiveNoteLoad {
  requestId: number;
  sink: NoteLoadSink;
  showTimer: ReturnType<typeof setTimeout>;
  slowTimer: ReturnType<typeof setTimeout>;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error || "笔记加载失败"));
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export class NoteLoadCoordinator {
  private sequence = 0;
  private active: ActiveNoteLoad | null = null;
  private retryOptions: NoteLoadOptions<unknown> | null = null;

  private clearTimers(active: ActiveNoteLoad | null): void {
    if (!active) return;
    clearTimeout(active.showTimer);
    clearTimeout(active.slowTimer);
    clearTimeout(active.timeoutTimer);
  }

  cancel(): void {
    const active = this.active;
    this.sequence += 1;
    this.clearTimers(active);
    this.active = null;
    this.retryOptions = null;
    if (active) active.sink.finish(active.requestId);
  }

  async run<T>(options: NoteLoadOptions<T>): Promise<NoteLoadResult<T>> {
    const previous = this.active;
    this.clearTimers(previous);

    const requestId = ++this.sequence;
    const startedAt = Date.now();
    let shownAt: number | null = null;
    let rejectTimeout: ((reason: Error) => void) | null = null;

    options.sink.begin({
      requestId,
      noteId: options.noteId,
      summary: options.summary,
      startedAt,
    });

    const showTimer = setTimeout(() => {
      if (this.sequence !== requestId) return;
      shownAt = Date.now();
      options.sink.show(requestId);
    }, NOTE_LOADING_DELAY_MS);

    const slowTimer = setTimeout(() => {
      if (this.sequence !== requestId) return;
      options.sink.markSlow(requestId);
    }, NOTE_LOADING_SLOW_MS);

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timeoutTimer = setTimeout(() => {
      rejectTimeout?.(new Error("笔记加载超时，请检查网络后重试"));
    }, NOTE_LOADING_TIMEOUT_MS);

    const active: ActiveNoteLoad = {
      requestId,
      sink: options.sink,
      showTimer,
      slowTimer,
      timeoutTimer,
    };
    this.active = active;
    this.retryOptions = null;

    try {
      const value = await Promise.race([options.request(), timeoutPromise]);
      if (this.sequence !== requestId) return { status: "cancelled" };

      this.clearTimers(active);
      if (shownAt !== null) {
        const remaining = NOTE_LOADING_MIN_VISIBLE_MS - (Date.now() - shownAt);
        await wait(remaining);
      }
      if (this.sequence !== requestId) return { status: "cancelled" };

      await options.onSuccess(value);
      if (this.sequence !== requestId) return { status: "cancelled" };

      options.sink.finish(requestId);
      this.active = null;
      return { status: "success", value };
    } catch (cause) {
      if (this.sequence !== requestId) return { status: "cancelled" };
      this.clearTimers(active);
      const error = toError(cause);
      this.retryOptions = options as NoteLoadOptions<unknown>;
      this.active = null;
      options.sink.fail(requestId, error.message);
      options.onError?.(error);
      return { status: "error", error };
    }
  }

  async retry(): Promise<NoteLoadResult<unknown> | null> {
    const options = this.retryOptions;
    if (!options) return null;
    return this.run(options);
  }
}

export const primaryNoteLoadCoordinator = new NoteLoadCoordinator();
