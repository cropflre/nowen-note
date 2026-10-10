export type MarkdownExportWorkspaceResolutionOptions = {
  explicitWorkspaceId?: string;
  noteIds: string[];
  currentWorkspace: string;
  getNoteWorkspaceId: (noteId: string) => Promise<string | null | undefined>;
};

function normalizeWorkspaceId(value: string | null | undefined): string | undefined {
  if (value === null) return "personal";
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

/**
 * Resolve the authoritative workspace scope for Markdown ZIP jobs.
 *
 * Single-note export must follow the note itself instead of whichever workspace happens to be
 * active in the UI. This matters for team notes opened in a retained tab: without the workspace
 * query the backend treats the request as personal-space export and rejects it with
 * NOTE_SCOPE_MISMATCH before the Knowledge Tree canDownload guard can run.
 *
 * Older backends may omit note.workspaceId. In that compatibility case only, fall back to the
 * currently active workspace. Multi-note exporters already know their scope and should pass it
 * explicitly; if they do not, the current workspace remains the safest legacy fallback.
 */
export async function resolveMarkdownExportWorkspaceId(
  options: MarkdownExportWorkspaceResolutionOptions,
): Promise<string> {
  const explicit = normalizeWorkspaceId(options.explicitWorkspaceId);
  if (explicit) return explicit;

  if (options.noteIds.length === 1) {
    try {
      const noteWorkspaceId = await options.getNoteWorkspaceId(options.noteIds[0]);
      const resolved = normalizeWorkspaceId(noteWorkspaceId);
      if (resolved) return resolved;
    } catch {
      // Permission/network errors are handled by the real export request. Scope resolution should
      // not replace that error with a separate preflight failure.
    }
  }

  return normalizeWorkspaceId(options.currentWorkspace) || "personal";
}
