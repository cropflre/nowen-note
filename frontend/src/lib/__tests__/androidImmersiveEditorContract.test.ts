import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

function toolbarSection(source: string, compactMarker: string, expandedMarker: string): string {
  return source.split(compactMarker)[1]?.split(expandedMarker)[0] || "";
}

function expectInOrder(source: string, values: string[]): void {
  let previous = -1;
  for (const value of values) {
    const current = source.indexOf(value);
    expect(current, `missing ${value}`).toBeGreaterThan(-1);
    expect(current, `${value} is out of order`).toBeGreaterThan(previous);
    previous = current;
  }
}

describe("Android immersive editor contract", () => {
  it("collapses the mobile document header while the native keyboard is visible", () => {
    const source = read("src/components/EditorPane.tsx");
    expect(source).toContain('useKeyboardVisible');
    expect(source).toContain('data-mobile-editor-compact');
    expect(source).toContain('compactMobileEditing && "hidden"');
    expect(source).toContain("nowen:open-search");
  });

  it("keeps one compact toolbar and exposes advanced formatting on demand", () => {
    const source = read("src/components/TiptapEditor.tsx");
    expect(source).toContain('data-mobile-editor-toolbar="compact"');
    expect(source).toContain('data-mobile-editor-toolbar="expanded"');
    expect(source).toContain('mobileToolbarExpanded');
    expect(source).toContain('data-mobile-editing-compact');
  });

  it("keeps image and local video actions visible before more in the Tiptap compact toolbar", () => {
    const source = read("src/components/TiptapEditor.tsx");
    const compact = toolbarSection(
      source,
      'data-mobile-editor-toolbar="compact"',
      'data-mobile-editor-toolbar="expanded"',
    );
    expectInOrder(compact, [
      "editor.chain().focus().undo().run()",
      "editor.chain().focus().redo().run()",
      "toggleHeadingSmart(editor, 1)",
      "toggleHeadingSmart(editor, 2)",
      "toggleBold().run()",
      "toggleBulletListSmart(editor)",
      "onClick={handleImageUpload}",
      "onClick={handleVideoUpload}",
      "setMobileToolbarExpanded",
    ]);
    expect(compact).not.toContain("handleVideoUrlInsert");
    expect(compact).toContain("<ImagePlus size={16} />");
    expect(compact).toContain("<Film size={16} />");
    expect(compact).toContain("flex-nowrap");
    expect(compact).toContain("overflow-x-auto");
    expect(source).toContain('compact ? "shrink-0 p-1');
    expect(compact).toContain('className="ml-auto"');
  });

  it("removes nonessential metadata and floating actions from the keyboard viewport", () => {
    const source = read("src/components/TiptapEditor.tsx");
    expect(source).toContain('data-mobile-editor-metadata');
    expect(source).toContain('!compactMobileEditing && (');
    expect(source).toContain('showBackToTop && !compactMobileEditing');
  });

  it("applies the same compact hierarchy to native Markdown documents", () => {
    const source = read("src/components/MarkdownEditorImpl.tsx");
    expect(source).toContain('data-markdown-mobile-editing-compact');
    expect(source).toContain('data-markdown-mobile-toolbar="compact"');
    expect(source).toContain('data-markdown-mobile-toolbar="expanded"');
    expect(source).toContain('data-markdown-mobile-status');
    expect(source).toContain('!compactMobileEditing');
    expect(source).toContain('onMouseDown={(event) => event.preventDefault()}');
    expect(source).toContain('[keyboardVisible, note.id]');
  });

  it("matches the Tiptap image, local video and more order in the Markdown compact toolbar", () => {
    const source = read("src/components/MarkdownEditorImpl.tsx");
    const compact = toolbarSection(
      source,
      'data-markdown-mobile-toolbar="compact"',
      'data-markdown-mobile-toolbar="expanded"',
    );
    expectInOrder(compact, [
      "undo(view)",
      "redo(view)",
      "toggleHeading(view, 1)",
      "toggleHeading(view, 2)",
      'toggleWrap(view, "**")',
      "toggleBulletList(view)",
      "onClick={triggerImagePicker}",
      "onClick={triggerVideoPicker}",
      "setMobileToolbarExpanded",
    ]);
    expect(compact).toContain("<ImagePlus size={16} />");
    expect(compact).toContain("<Film size={16} />");
    expect(compact).toContain("flex-nowrap");
    expect(compact).toContain("overflow-x-auto");
    expect(compact).toContain("[&>button]:shrink-0");
    expect(compact).toContain("[&>button]:p-1");
    expect(compact).toContain('className="ml-auto"');
  });

  it("suppresses the mobile space launcher while the IME is open", () => {
    const source = read("src/components/PublicSpaceLauncher.tsx");
    expect(source).toContain('useKeyboardVisible');
    expect(source).toContain('keyboardVisible && mount.rail.classList.contains("md:hidden")');
  });
});
