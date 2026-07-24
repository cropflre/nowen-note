import { vi } from "vitest";

vi.mock("../WindowedTiptapEditor", async () => {
  const ReactModule = await import("react");
  const Windowed = ReactModule.forwardRef((_props: unknown, ref) => {
    ReactModule.useImperativeHandle(ref, () => ({
      flushSave: vi.fn(),
      discardPending: vi.fn(),
      getSnapshot: () => null,
      acknowledgeSave: vi.fn(),
      isReady: () => true,
      appendMarkdown: () => false,
    }));
    return ReactModule.createElement("div", { "data-windowed-tiptap": "" });
  });
  Windowed.displayName = "BlockPatchWindowedEditorStub";
  return {
    default: Windowed,
    TIPTAP_SUBDOCUMENT_WINDOWING_KEY: "nowen:tiptap-subdocuments",
    isTiptapSubdocumentWindowingEnabled: () => false,
  };
});
