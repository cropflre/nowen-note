from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    Path(path).write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


use_y_doc = "frontend/src/hooks/useYDoc.ts"
replace_once(
    use_y_doc,
    '''    const initialDurability = provider.getDurabilityState();
    setState({
      doc,
      provider,
      status: provider.getStatus(),
      synced: provider.getStatus() === "synced",
      durability: initialDurability,
    });''',
    '''    const currentStatus = provider.getStatus();
    const initialSynced = currentStatus === "synced";
    const initialDurability = provider.getDurabilityState();
    // Imported Markdown already has a reliable REST payload. Do not expose a half-initialized
    // Y.Doc to CodeMirror: an empty Y.Text bound before server + IndexedDB recovery completes can
    // replace the visible note with an empty collaborative update.
    setState({
      doc: initialSynced ? doc : null,
      provider,
      status: currentStatus,
      synced: initialSynced,
      durability: initialDurability,
    });''',
)
replace_once(
    use_y_doc,
    '''    const offSynced = provider.on("synced", () => {
      setState((prev) =>
        prev.provider === provider ? { ...prev, synced: true } : prev,
      );
    });''',
    '''    const offSynced = provider.on("synced", () => {
      setState((prev) =>
        prev.provider === provider
          ? { ...prev, doc, status: "synced", synced: true }
          : prev,
      );
    });''',
)


data_manager = "frontend/src/components/DataManager.tsx"
replace_once(
    data_manager,
    '''function persistImportFormat(key: string, value: ImportTargetContentFormat): void {''',
    '''function hasPersistedImportFormat(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const value = window.localStorage.getItem(key);
    return value === "markdown" || value === "tiptap-json";
  } catch {
    return false;
  }
}

function persistImportFormat(key: string, value: ImportTargetContentFormat): void {''',
)
replace_once(
    data_manager,
    '''  const [activeImportMethod, setActiveImportMethod] = useState<ImportMethod>(() => readImportMethod());''',
    '''  // A persisted choice and an explicit click are authoritative. Package inspection may only
  // recommend a default before the user has selected a format.
  const siyuanImportFormatUserSelectedRef = useRef(
    hasPersistedImportFormat(IMPORT_FORMAT_STORAGE.siyuan),
  );
  const [activeImportMethod, setActiveImportMethod] = useState<ImportMethod>(() => readImportMethod());''',
)
replace_once(
    data_manager,
    '''  useEffect(() => persistImportMethod(activeImportMethod), [activeImportMethod]);''',
    '''  const selectSiyuanImportContentFormat = useCallback((format: ImportTargetContentFormat) => {
    siyuanImportFormatUserSelectedRef.current = true;
    setSiyuanImportContentFormat(format);
  }, []);
  const recommendSiyuanImportContentFormat = useCallback((format: ImportTargetContentFormat) => {
    if (siyuanImportFormatUserSelectedRef.current) return;
    setSiyuanImportContentFormat(format);
  }, []);

  useEffect(() => persistImportMethod(activeImportMethod), [activeImportMethod]);''',
)

text = read(data_manager)
process_start = text.index("  const processFiles = async")
process_end = text.index("  const toggleFileSelection", process_start)
process_source = text[process_start:process_end]
if process_source.count('setSiyuanImportContentFormat("markdown");') != 2:
    raise SystemExit("DataManager processFiles: expected two Markdown recommendations")
if process_source.count('setSiyuanImportContentFormat("tiptap-json");') != 1:
    raise SystemExit("DataManager processFiles: expected one rich-text recommendation")
process_source = process_source.replace(
    'setSiyuanImportContentFormat("markdown");',
    'recommendSiyuanImportContentFormat("markdown");',
)
process_source = process_source.replace(
    'setSiyuanImportContentFormat("tiptap-json");',
    'recommendSiyuanImportContentFormat("tiptap-json");',
)
write(data_manager, text[:process_start] + process_source + text[process_end:])

replace_once(
    data_manager,
    'onClick={() => setSiyuanImportContentFormat("tiptap-json")}',
    'onClick={() => selectSiyuanImportContentFormat("tiptap-json")}',
)
replace_once(
    data_manager,
    'onClick={() => setSiyuanImportContentFormat("markdown")}',
    'onClick={() => selectSiyuanImportContentFormat("markdown")}',
)


collab_test = "frontend/src/components/__tests__/EditorPaneNativeMarkdownCollab.test.ts"
replace_once(
    collab_test,
    '''      "setState({ doc: null, provider, status: provider.getStatus(), synced: false });",''',
    '''      "doc: initialSynced ? doc : null",''',
)
replace_once(
    collab_test,
    '''    expect(useYDocSource).toContain("{ ...prev, doc, synced: true }");''',
    '''    expect(useYDocSource).toContain('{ ...prev, doc, status: "synced", synced: true }');''',
)


write(
    "frontend/src/components/__tests__/DataManagerImportFormatSelection.test.ts",
    '''import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve(__dirname, "../DataManager.tsx"),
  "utf8",
);

describe("DataManager SiYuan import format selection", () => {
  it("does not overwrite an explicit or persisted Markdown choice during file inspection", () => {
    expect(source).toContain("hasPersistedImportFormat(IMPORT_FORMAT_STORAGE.siyuan)");
    expect(source).toContain("siyuanImportFormatUserSelectedRef.current = true");
    expect(source).toContain("if (siyuanImportFormatUserSelectedRef.current) return;");

    const processStart = source.indexOf("const processFiles = async");
    const processEnd = source.indexOf("const toggleFileSelection", processStart);
    expect(processStart).toBeGreaterThanOrEqual(0);
    expect(processEnd).toBeGreaterThan(processStart);
    const processSource = source.slice(processStart, processEnd);

    expect(processSource).toContain('recommendSiyuanImportContentFormat("tiptap-json")');
    expect(processSource).toContain('recommendSiyuanImportContentFormat("markdown")');
    expect(processSource).not.toContain('setSiyuanImportContentFormat("tiptap-json")');
    expect(processSource).not.toContain('setSiyuanImportContentFormat("markdown")');

    expect(source).toContain(
      'onClick={() => selectSiyuanImportContentFormat("markdown")}',
    );
    expect(source).toContain(
      'onClick={() => selectSiyuanImportContentFormat("tiptap-json")}',
    );
  });
});
''',
)


import_ci = ".github/workflows/import-format-ci.yml"
text = read(import_ci)
trigger = '      - "frontend/src/lib/__tests__/importServiceSiyuanMarkdown.test.ts"'
if text.count(trigger) != 2:
    raise SystemExit("import-format CI: expected two import service triggers")
text = text.replace(
    trigger,
    trigger + '\n      - "frontend/src/components/__tests__/DataManagerImportFormatSelection.test.ts"',
)
old_run = "run: npm run test:run -- src/lib/__tests__/importServiceSiyuanMarkdown.test.ts src/lib/__tests__/obsidianImportFormat.test.ts"
new_run = old_run + " src/components/__tests__/DataManagerImportFormatSelection.test.ts"
if text.count(old_run) != 1:
    raise SystemExit("import-format CI: targeted run command not found")
write(import_ci, text.replace(old_run, new_run, 1))


durability_ci = ".github/workflows/issue-612-data-protection-ci.yml"
text = read(durability_ci)
trigger = '      - "frontend/src/components/MarkdownEditorImpl.tsx"'
if text.count(trigger) != 2:
    raise SystemExit("issue-612 CI: expected two Markdown editor triggers")
text = text.replace(
    trigger,
    trigger + '\n      - "frontend/src/components/__tests__/EditorPaneNativeMarkdownCollab.test.ts"',
)
old_tests = '''          src/lib/__tests__/yjsDurability.test.ts
          src/lib/__tests__/draftStorage.conflict.test.ts'''
new_tests = '''          src/lib/__tests__/yjsDurability.test.ts
          src/components/__tests__/EditorPaneNativeMarkdownCollab.test.ts
          src/lib/__tests__/draftStorage.conflict.test.ts'''
if text.count(old_tests) != 1:
    raise SystemExit("issue-612 CI: frontend test command not found")
write(durability_ci, text.replace(old_tests, new_tests, 1))
