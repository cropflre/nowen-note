import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useSyncExternalStore,
} from "react";

import type {
  NoteEditorHandle,
  NoteEditorProps,
  NoteEditorUpdatePayload,
} from "@/components/editors/types";
import {
  getActiveEditorRuntimeState,
  subscribeEditorRuntime,
} from "@/lib/editorRuntimeStore";
import { shouldPublishRealtimeTiptapOutline } from "@/lib/tiptapDerivedRuntime";
import {
  BlockPatchRequestError,
  createBlockPatchOperationId,
  patchTiptapBlocks,
} from "@/lib/blockPatchApi";
import { planTiptapBlockPatch } from "@/lib/tiptapBlockPatchPlannerRuntime";
import {
  resolveTiptapBlockPatchEnabled,
  shouldFallbackTiptapBlockPatchToWholeSave,
  shouldRetryTiptapBlockPatch,
  TIPTAP_BLOCK_PATCH_OVERRIDE_KEY,
} from "@/lib/tiptapBlockPatchRuntime";
import { clearDraft, saveDraft } from "@/lib/draftStorage";
import { useAppActions } from "@/store/AppContext";
import type { Note } from "@/types";
import BaseTiptapEditor from "./TiptapEditor";

type RuntimeTiptapEditorProps = NoteEditorProps & {
  presentationMode?: boolean;
};

type AppActions = ReturnType<typeof useAppActions>;

type InflightPatch = {
  operationId: string;
  lifecycle: number;
  actions: AppActions;
};

function readBlockPatchOverride(): string | null {
  try {
    return localStorage.getItem(TIPTAP_BLOCK_PATCH_OVERRIDE_KEY);
  } catch {
    return null;
  }
}

/**
 * Public/share routes render the same aliased editor without AppProvider. Keep the context hook in a
 * child which is mounted only when authenticated Block Patch persistence is actually enabled.
 */
function BlockPatchAppActionsBridge({
  target,
}: {
  target: React.MutableRefObject<AppActions | null>;
}) {
  const actions = useAppActions();
  useEffect(() => {
    target.current = actions;
    return () => {
      if (target.current === actions) target.current = null;
    };
  }, [actions, target]);
  return null;
}

/**
 * Runtime shell for two independent optimizations:
 *
 * - optimized modes stop publishing a live whole-document outline;
 * - safely expressible Tiptap snapshots use the confirmed Block Patch V1 endpoint.
 *
 * The patch path is deliberately narrow. Unsupported structures and rejected pre-persistence
 * patches immediately reuse the original whole-document save callback. Uncertain network results
 * never trigger a second write with a different protocol because that could overwrite a patch
 * which actually committed before the connection disappeared.
 */
const TiptapEditorRuntime = forwardRef<NoteEditorHandle, RuntimeTiptapEditorProps>(
  function TiptapEditorRuntime(props, ref) {
    const baseRef = useRef<NoteEditorHandle | null>(null);
    const appActionsRef = useRef<AppActions | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const lifecycleRef = useRef(0);
    const inflightRef = useRef<InflightPatch | null>(null);
    const queuedPayloadRef = useRef<NoteEditorUpdatePayload | null>(null);
    const drainAfterVersionRef = useRef<number | null>(null);
    const processPayloadRef = useRef<(payload: NoteEditorUpdatePayload) => void>(() => undefined);

    const runtimeState = useSyncExternalStore(
      subscribeEditorRuntime,
      getActiveEditorRuntimeState,
      getActiveEditorRuntimeState,
    );
    const runtimeBelongsToNote = runtimeState.noteId === props.note.id;
    const decision = runtimeState.decision;
    // Split/public editors may coexist with the active optimized editor. Only the note that owns
    // the runtime decision may inherit its outline and persistence degradation policy.
    const publishRealtimeOutline = !runtimeBelongsToNote
      || shouldPublishRealtimeTiptapOutline(decision);
    const blockPatchEnabled = runtimeBelongsToNote && resolveTiptapBlockPatchEnabled({
      mode: decision.mode,
      override: readBlockPatchOverride(),
      editable: props.editable !== false,
      isGuest: props.isGuest === true,
      presentationMode: props.presentationMode === true,
      contentFormat: props.note.contentFormat || "tiptap-json",
    });
    const blockPatchEnabledRef = useRef(blockPatchEnabled);
    blockPatchEnabledRef.current = blockPatchEnabled;

    useImperativeHandle(ref, () => ({
      flushSave: () => baseRef.current?.flushSave(),
      discardPending: () => baseRef.current?.discardPending?.(),
      getSnapshot: () => baseRef.current?.getSnapshot?.() ?? null,
      acknowledgeSave: (ack) => baseRef.current?.acknowledgeSave?.(ack),
      isReady: () => baseRef.current?.isReady?.() ?? Boolean(baseRef.current),
      appendMarkdown: (markdown) => baseRef.current?.appendMarkdown?.(markdown) ?? false,
    }), []);

    useEffect(() => {
      lifecycleRef.current += 1;
      inflightRef.current = null;
      queuedPayloadRef.current = null;
      drainAfterVersionRef.current = null;
    }, [props.note.id]);

    useEffect(() => {
      if (!publishRealtimeOutline) props.onHeadingsChange?.([]);
    }, [props.note.id, props.onHeadingsChange, publishRealtimeOutline]);

    const forwardWholeSave = useCallback((payload: NoteEditorUpdatePayload) => {
      try {
        void Promise.resolve(propsRef.current.onUpdate(payload)).catch((error) => {
          console.warn("[tiptap-block-patch] whole-save fallback failed", error);
        });
      } catch (error) {
        console.warn("[tiptap-block-patch] whole-save fallback failed", error);
      }
    }, []);

    const persistDraft = useCallback((payload: NoteEditorUpdatePayload, note: Note) => {
      if (typeof payload.content !== "string") return;
      try {
        saveDraft({
          noteId: note.id,
          editorMode: "tiptap",
          content: payload.content,
          contentText: payload.contentText || "",
          title: payload.title,
          baseVersion: note.version,
          savedAt: Date.now(),
        });
      } catch {
        // Quota failures must never block either persistence protocol.
      }
    }, []);

    const applyConfirmedResult = useCallback((options: {
      result: Awaited<ReturnType<typeof patchTiptapBlocks>>;
      payload: NoteEditorUpdatePayload;
      note: Note;
      inflight: InflightPatch;
    }) => {
      const { result, payload, note, inflight } = options;
      if (lifecycleRef.current !== inflight.lifecycle) return;
      if (propsRef.current.note.id !== note.id) return;
      if (inflightRef.current !== inflight) return;

      const snapshot = baseRef.current?.getSnapshot?.() ?? null;
      const preserveLocalEditor = Boolean(
        snapshot
        && typeof payload.content === "string"
        && snapshot.content !== payload.content,
      );
      if (payload._saveGeneration) {
        baseRef.current?.acknowledgeSave?.({
          noteId: note.id,
          version: result.version,
          content: result.content,
          saveGeneration: payload._saveGeneration,
          preserveLocalEditor,
        });
      }

      const current = propsRef.current.note;
      const updated: Note = {
        ...current,
        title: result.title || current.title,
        content: result.content,
        contentText: result.contentText,
        contentFormat: result.contentFormat || current.contentFormat,
        notebookId: result.notebookId ?? current.notebookId,
        version: result.version,
        updatedAt: result.updatedAt,
      };
      inflight.actions.setActiveNote(updated);
      inflight.actions.updateNoteInList({
        id: updated.id,
        title: updated.title,
        contentText: updated.contentText,
        updatedAt: updated.updatedAt,
        version: updated.version,
        notebookId: updated.notebookId,
        workspaceId: updated.workspaceId,
      } as any);
      inflight.actions.updateNoteTab({
        id: updated.id,
        title: updated.title,
        updatedAt: updated.updatedAt,
        contentFormat: updated.contentFormat,
        isLocked: updated.isLocked,
        isTrashed: updated.isTrashed,
        notebookId: updated.notebookId,
      });
      inflight.actions.setSyncStatus("saved");
      inflight.actions.setLastSynced(new Date().toISOString());
      if (!preserveLocalEditor && !queuedPayloadRef.current) {
        try { clearDraft(note.id); } catch { /* ignore */ }
      }
    }, []);

    const processPayload = useCallback((payload: NoteEditorUpdatePayload) => {
      const currentProps = propsRef.current;
      const note = currentProps.note;

      if (inflightRef.current) {
        // All saves, including title/meta changes which will use the whole-note route, must wait for
        // the authoritative patch version. Otherwise a same-version PUT can race the patch.
        queuedPayloadRef.current = payload;
        persistDraft(payload, note);
        return;
      }

      const actions = appActionsRef.current;
      if (
        !blockPatchEnabledRef.current
        || !actions
        || typeof payload.content !== "string"
        || note.contentFormat !== "tiptap-json"
        || payload.title !== note.title
      ) {
        forwardWholeSave(payload);
        return;
      }

      const plan = planTiptapBlockPatch(note.content, payload.content);
      if (!plan) {
        forwardWholeSave(payload);
        return;
      }

      const lifecycle = lifecycleRef.current;
      const inflight: InflightPatch = {
        operationId: createBlockPatchOperationId(),
        lifecycle,
        actions,
      };
      inflightRef.current = inflight;
      persistDraft(payload, note);
      actions.setSyncStatus("saving");

      const request = {
        expectedNoteVersion: note.version,
        operationId: inflight.operationId,
        operations: plan.operations,
      };

      void (async () => {
        try {
          let result;
          try {
            result = await patchTiptapBlocks(note.id, request);
          } catch (error) {
            if (!shouldRetryTiptapBlockPatch(error)) throw error;
            // The operation ID is intentionally reused: a server commit followed by a lost response
            // becomes an idempotent replay instead of a duplicate edit.
            result = await patchTiptapBlocks(note.id, request);
          }

          if (
            lifecycleRef.current !== lifecycle
            || propsRef.current.note.id !== note.id
            || inflightRef.current !== inflight
          ) return;
          applyConfirmedResult({ result, payload, note, inflight });
          if (inflightRef.current === inflight) inflightRef.current = null;
          if (queuedPayloadRef.current) drainAfterVersionRef.current = result.version;
        } catch (error) {
          if (
            lifecycleRef.current !== lifecycle
            || propsRef.current.note.id !== note.id
            || inflightRef.current !== inflight
          ) return;
          inflightRef.current = null;
          const latest = queuedPayloadRef.current || payload;
          queuedPayloadRef.current = null;
          drainAfterVersionRef.current = null;

          if (shouldFallbackTiptapBlockPatchToWholeSave(error)) {
            forwardWholeSave(latest);
            return;
          }

          // VERSION_CONFLICT and uncertain network outcomes keep the latest local snapshot as a
          // draft. A blind whole-document write here could overwrite a patch that committed before
          // the response was lost, or overwrite a newer remote version.
          persistDraft(latest, propsRef.current.note);
          inflight.actions.setSyncStatus("error");
          const detail = error instanceof BlockPatchRequestError
            ? { code: error.code, status: error.status, currentVersion: error.currentVersion }
            : undefined;
          console.warn("[tiptap-block-patch] confirmed save unavailable; draft preserved", detail || error);
        }
      })();
    }, [applyConfirmedResult, forwardWholeSave, persistDraft]);
    processPayloadRef.current = processPayload;

    useEffect(() => {
      const targetVersion = drainAfterVersionRef.current;
      if (targetVersion == null || props.note.version < targetVersion || inflightRef.current) return;
      const queued = queuedPayloadRef.current;
      drainAfterVersionRef.current = null;
      queuedPayloadRef.current = null;
      if (queued) processPayloadRef.current(queued);
    }, [props.note.content, props.note.version]);

    const handleUpdate = useCallback((payload: NoteEditorUpdatePayload) => {
      processPayloadRef.current(payload);
    }, []);

    return (
      <>
        {blockPatchEnabled && <BlockPatchAppActionsBridge target={appActionsRef} />}
        <BaseTiptapEditor
          {...props}
          ref={baseRef}
          onUpdate={handleUpdate}
          onHeadingsChange={publishRealtimeOutline ? props.onHeadingsChange : undefined}
        />
      </>
    );
  },
);

TiptapEditorRuntime.displayName = "TiptapEditorRuntime";

export default TiptapEditorRuntime;
