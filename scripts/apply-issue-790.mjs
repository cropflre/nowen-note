import { readFileSync, writeFileSync } from "node:fs";

// This script is intentionally anchored to the inspected release/v1.5.0 source. Fail rather
// than silently edit a different version of a large, concurrently developed editor module.
const changed = new Map();
function replaceOnce(path, before, after) {
  const source = changed.get(path) ?? readFileSync(path, "utf8");
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Issue #790 integration anchor missing or ambiguous: ${path} / ${before.slice(0, 90)}`);
  }
  changed.set(path, source.slice(0, index) + after + source.slice(index + before.length));
}

const md = "frontend/src/components/MarkdownPreview.tsx";
replaceOnce(md,
  'import { BlockEmbedCard } from "@/components/BlockEmbedExtension";',
  'import { BlockEmbedCard } from "@/components/BlockEmbedExtension";\nimport MindMapEmbedCard, { parseMindMapEmbedHref } from "@/components/MindMapEmbedCard";',
);
replaceOnce(md,
  '      if (typeof embedHref === "string" && embedHref.startsWith("note:")) {\n        return <div className="my-4"><BlockEmbedCard href={embedHref} /></div>;\n      }',
  '      if (typeof embedHref === "string" && parseMindMapEmbedHref(embedHref)) {\n        return <div className="my-4"><MindMapEmbedCard href={embedHref} /></div>;\n      }\n      if (typeof embedHref === "string" && embedHref.startsWith("note:")) {\n        return <div className="my-4"><BlockEmbedCard href={embedHref} /></div>;\n      }',
);

const editor = "frontend/src/components/EditorPane.tsx";
replaceOnce(editor,
  'import NoteThemeMenuSelect from "@/components/NoteThemeMenuSelect";',
  'import NoteThemeMenuSelect from "@/components/NoteThemeMenuSelect";\nimport MindMapEmbedInsertDialog from "@/components/MindMapEmbedInsertDialog";',
);
replaceOnce(editor,
  '  const actions = useAppActions();\n  const { loadNote, retryNoteLoad } = useNoteLoader();',
  `  const actions = useAppActions();
  useEffect(() => {
    const handler = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (!id || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) return;
      sessionStorage.setItem("pendingOpenMindMapId", id);
      actions.setViewMode("mindmaps");
    };
    window.addEventListener("nowen:request-open-embedded-mindmap", handler);
    return () => window.removeEventListener("nowen:request-open-embedded-mindmap", handler);
  }, [actions]);
  const { loadNote, retryNoteLoad } = useNoteLoader();`,
);
replaceOnce(editor,
  '  const [showMermaidDialog, setShowMermaidDialog] = useState(false);',
  '  const [showMermaidDialog, setShowMermaidDialog] = useState(false);\n  const [showMindMapInsertDialog, setShowMindMapInsertDialog] = useState(false);',
);
replaceOnce(editor,
  `            aria-label={t('editor.searchInNote')}
          >
            <Search size={17} />
          </Button>`,
  `            aria-label={t('editor.searchInNote')}
          >
            <Search size={17} />
          </Button>
          <Button
            variant="ghost" size="icon" className="h-8 w-8 shrink-0"
            aria-label="插入思维导图" title="插入思维导图"
            disabled={effectiveLocked || isTrashed || noteIsFullHtmlDoc}
            onClick={() => setShowMindMapInsertDialog(true)}
          >
            <Network size={17} />
          </Button>`,
);
replaceOnce(editor,
  `                    <span>{t('editor.searchInNote')}</span>
                  </button>`,
  `                    <span>{t('editor.searchInNote')}</span>
                  </button>
                  <button
                    type="button"
                    disabled={effectiveLocked || isTrashed || noteIsFullHtmlDoc}
                    onClick={() => { setShowMobileMenu(false); setShowMindMapInsertDialog(true); }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-tx-secondary hover:bg-app-hover disabled:opacity-40"
                  >
                    <Network size={15} className="text-accent-primary" />
                    <span>插入思维导图</span>
                  </button>`,
);
replaceOnce(editor,
  '      <AnimatePresence>\n        {showMermaidDialog && (',
  `      <MindMapEmbedInsertDialog
        open={showMindMapInsertDialog && !!activeNote && !effectiveLocked && !isTrashed && !noteIsFullHtmlDoc}
        onClose={() => setShowMindMapInsertDialog(false)}
        onInsert={(id) => {
          if (!activeNote || effectiveLocked || isTrashed || noteIsFullHtmlDoc) return false;
          const inserted = editorHandleRef.current?.appendMarkdown?.(\`\\n\\n![[mindmap:\${id}]]\\n\\n\`) === true;
          if (inserted) toast.success("已插入思维导图引用");
          return inserted;
        }}
      />
      <AnimatePresence>
        {showMermaidDialog && (`,
);

// Keep full-text snippets free of opaque resource IDs. The original source remains untouched.
const contentFormat = "frontend/src/lib/contentFormat.ts";
replaceOnce(contentFormat,
  '  // 链接\n  text = text.replace(/\\[([^\\]]+)\\]\\([^)]*\\)/g, "$1");',
  '  // 原生思维导图引用是结构元数据，不把 UUID 暴露到全文摘要。\n  text = text.replace(/!\\[\\[mindmap:[0-9a-f-]{36}\\]\\]/gi, "思维导图");\n  // 链接\n  text = text.replace(/\\[([^\\]]+)\\]\\([^)]*\\)/g, "$1");',
);

for (const [path, contents] of changed) {
  writeFileSync(path, contents);
  console.log(`Updated ${path}`);
}
