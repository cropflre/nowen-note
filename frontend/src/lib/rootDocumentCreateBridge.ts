import { api } from "@/lib/api";
import {
  buildRootDocumentFollowupPatch,
  isRootDocumentNotebookId,
  resolveRootDocumentNodeType,
  resolveRootDocumentTitle,
  rootDocumentCreateRequestKey,
  type RootDocumentCreateInput,
} from "@/lib/rootDocumentCreatePolicy";

const INSTALL_KEY = "__NOWEN_ROOT_DOCUMENT_CREATE_BRIDGE__" as const;

type RootDocumentCreateWindow = Window & typeof globalThis & {
  [INSTALL_KEY]?: () => void;
};

type CreateNote = typeof api.createNote;
type CreateNoteInput = Parameters<CreateNote>[0] & RootDocumentCreateInput;
type CreateNoteResult = Awaited<ReturnType<CreateNote>>;

const inFlightCreates = new Map<string, Promise<CreateNoteResult>>();

/**
 * Root-level knowledge-tree documents are stored in an internal notebook whose id starts with
 * ROOT_DOCUMENT_NOTEBOOK_PREFIX. That notebook is deliberately hidden/soft-deleted so it never
 * appears as a real folder. Opening a root document used to leak this internal id into
 * selectedNotebookId; the regular note-list FAB then called POST /notes with that id and received
 * a permission/deleted-container error.
 *
 * Keep the compatibility at the API boundary: any caller that accidentally targets the hidden
 * container is converted into the supported knowledge-tree root-create operation. This protects
 * Android, Web and desktop entry points without teaching each button about the storage detail.
 */
export function installRootDocumentCreateBridge(): void {
  if (typeof window === "undefined") return;
  const bridgeWindow = window as RootDocumentCreateWindow;
  if (bridgeWindow[INSTALL_KEY]) return;

  const originalCreateNote = api.createNote.bind(api) as CreateNote;

  const createNoteWithRootCompatibility = (async (input: CreateNoteInput) => {
    if (!isRootDocumentNotebookId(input?.notebookId)) {
      return originalCreateNote(input);
    }

    const requestKey = rootDocumentCreateRequestKey(input);
    const existing = inFlightCreates.get(requestKey);
    if (existing) return existing;

    const createPromise = (async (): Promise<CreateNoteResult> => {
      const { knowledgeTreeApi } = await import("@/lib/knowledgeTreeApi");
      const createdNode = await knowledgeTreeApi.create({
        parentId: null,
        nodeType: resolveRootDocumentNodeType(input),
        title: resolveRootDocumentTitle(input),
      });

      let note = await api.getNote(createdNode.resourceId) as CreateNoteResult;
      const followupPatch = buildRootDocumentFollowupPatch(note, input);
      if (followupPatch) {
        note = await api.updateNote(createdNode.resourceId, {
          ...followupPatch,
          version: (note as { version?: number }).version || 1,
        } as any) as CreateNoteResult;
      }
      return note;
    })();

    inFlightCreates.set(requestKey, createPromise);
    try {
      return await createPromise;
    } finally {
      if (inFlightCreates.get(requestKey) === createPromise) {
        inFlightCreates.delete(requestKey);
      }
    }
  }) as CreateNote;

  api.createNote = createNoteWithRootCompatibility;
  bridgeWindow[INSTALL_KEY] = () => {
    api.createNote = originalCreateNote;
    inFlightCreates.clear();
    delete bridgeWindow[INSTALL_KEY];
  };
}

installRootDocumentCreateBridge();
