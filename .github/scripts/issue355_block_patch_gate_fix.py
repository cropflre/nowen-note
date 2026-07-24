from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one occurrence, found {count}: {old!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "backend/tests/block-patch-route.test.ts",
    'test("rejects Markdown notes until their block patch protocol is format-aware", async () => {',
    'test("rejects the legacy Tiptap operation shape for Markdown notes", async () => {',
)
replace_once(
    "backend/tests/block-patch-route.test.ts",
    '  assert.equal(payload.code, "BLOCK_FORMAT_UNSUPPORTED");',
    '  assert.equal(payload.code, "INVALID_MARKDOWN_PATCH");',
)

mock_old = '''vi.mock("@/lib/api.impl", () => ({
  getBaseUrl: () => "/api",
}));'''
mock_new = '''vi.mock("@/lib/api.impl", () => ({
  api: {
    attachments: { upload: async () => ({}) },
    search: async () => [],
    moveNotebook: async () => ({}),
    reorderNotebooks: async () => ({}),
    updateNotebook: async () => ({}),
    createTask: async () => ({}),
    getHabitCheckinLog: async () => [],
  },
  getBaseUrl: () => "/api",
  getCurrentWorkspace: () => null,
  getServerUrl: () => "",
}));'''

for path in [
    "frontend/src/components/__tests__/TiptapBlockPatchEmptyDocument.test.tsx",
    "frontend/src/components/__tests__/TiptapBlockPatchRuntimeV2.test.tsx",
    "frontend/src/components/__tests__/TiptapBlockPatchListStructureRuntime.test.tsx",
    "frontend/src/components/__tests__/TiptapBlockPatchImageRuntime.test.tsx",
    "frontend/src/components/__tests__/TiptapBlockPatchListRuntime.test.tsx",
]:
    replace_once(path, mock_old, mock_new)

print("Block Patch gate tests repaired")
