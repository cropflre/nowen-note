export interface NoteActivationIntent {
  requestId: number;
  noteId: string;
}

/**
 * Keeps the user's latest note-open intent authoritative across the complete switch lifecycle.
 *
 * A note switch flushes the old editor before loading the new note. That old save can finish not
 * only before React commits the target note, but also later (for example after a slow desktop RTE
 * autosave/reconcile). A late acknowledgement must still be allowed to persist on the server, but
 * it must never reactivate the note the user already left.
 *
 * The active intent therefore guards the load itself, while staleSourceNoteId keeps the previous
 * source retired after the target has committed. The retirement is cleared by the next explicit
 * BEGIN_NOTE_LOAD, so intentionally navigating back to the previous note still works normally.
 */
export class NoteActivationGuard {
  private intent: (NoteActivationIntent & {
    sourceNoteId: string | null;
    targetDispatched: boolean;
  }) | null = null;
  private staleSourceNoteId: string | null = null;

  begin(intent: NoteActivationIntent, sourceNoteId: string | null): void {
    // A new navigation intent is authoritative. In particular, the user may intentionally be
    // navigating back to the source retired by the previous switch, so release that retirement.
    this.staleSourceNoteId = null;
    this.intent = { ...intent, sourceNoteId, targetDispatched: false };
  }

  allowActiveNote(noteId: string | null): boolean {
    const intent = this.intent;
    if (intent) {
      if (noteId === null) return true;

      if (noteId === intent.noteId) {
        intent.targetDispatched = true;
        return true;
      }

      // While the target is still loading, the source note remains the visible/authoritative note.
      // Its save acknowledgements are safe and must keep updating version/sync metadata. Once the
      // target activation has been dispatched, however, no other note may steal this navigation.
      if (!intent.targetDispatched && noteId === intent.sourceNoteId) return true;

      return false;
    }

    // React committing the target is not proof that every async callback owned by the previous
    // editor has drained. Keep that source retired until the next explicit navigation starts.
    if (noteId !== null && noteId === this.staleSourceNoteId) return false;

    return true;
  }

  fail(requestId: number): void {
    if (this.intent?.requestId !== requestId) return;
    this.intent = null;
    this.staleSourceNoteId = null;
  }

  finish(requestId: number): void {
    const intent = this.intent;
    if (!intent || intent.requestId !== requestId) return;
    // A finish without ever dispatching the target note is a cancellation. There is no completed
    // navigation, so the source must remain usable and must not be retired.
    if (!intent.targetDispatched) {
      this.intent = null;
      this.staleSourceNoteId = null;
    }
  }

  commit(activeNoteId: string | null): void {
    const intent = this.intent;
    if (!intent || !intent.targetDispatched || activeNoteId !== intent.noteId) return;

    // The target is now visible, but old-editor save/reconcile callbacks may still arrive later.
    // Retire only the source note; unrelated deliberate activations remain possible.
    this.staleSourceNoteId = intent.sourceNoteId;
    this.intent = null;
  }
}
