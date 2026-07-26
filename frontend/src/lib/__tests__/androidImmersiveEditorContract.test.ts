import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

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

  it("suppresses the mobile space launcher while the IME is open", () => {
    const source = read("src/components/PublicSpaceLauncher.tsx");
    expect(source).toContain('useKeyboardVisible');
    expect(source).toContain('keyboardVisible && mount.rail.classList.contains("md:hidden")');
  });
});
