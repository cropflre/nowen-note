export type EditorRevisionToken = {
  noteId: string;
  editor: object;
  generation: number;
  revision: number;
};

export class EditorRevisionGuard {
  private noteId = "";
  private editor: object | null = null;
  private generation = 0;
  private revision = 0;

  reset(noteId: string, editor: object): void {
    this.noteId = noteId;
    this.editor = editor;
    this.generation += 1;
    this.revision = 0;
  }

  next(noteId: string, editor: object): EditorRevisionToken {
    if (this.noteId !== noteId || this.editor !== editor) this.reset(noteId, editor);
    this.revision += 1;
    return this.capture();
  }

  capture(): EditorRevisionToken {
    if (!this.editor) throw new Error("EditorRevisionGuard has not been initialized");
    return {
      noteId: this.noteId,
      editor: this.editor,
      generation: this.generation,
      revision: this.revision,
    };
  }

  isCurrent(token: EditorRevisionToken, noteId: string, editor: object): boolean {
    return token.noteId === noteId
      && token.editor === editor
      && token.generation === this.generation
      && token.revision === this.revision;
  }

  invalidate(): void {
    this.generation += 1;
    this.revision = 0;
  }
}
