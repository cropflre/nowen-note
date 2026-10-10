import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { Editor } from "@tiptap/react";
import { GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ColumnToolbar } from "./ColumnToolbar";
import { getSlashEditorId } from "./extensions/SlashCommandExtension";
import { addBlockBelow, convertBlock, copyBlock, cutBlock, deleteBlock, pasteBlock, type AddBelowType, type BlockTarget } from "./blockMenuActions";
import { toast } from "@/lib/toast";

const targets: { key: string; target: BlockTarget; insert: AddBelowType }[] = [
  { key: "paragraph", target: { type: "paragraph" }, insert: "paragraph" },
  ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({ key: `heading${level}`, target: { type: "heading" as const, level }, insert: `heading${level}` as AddBelowType })),
  ...(["bulletList", "orderedList", "taskList", "blockquote", "codeBlock", "callout", "details", "columns"] as const).map((type) => ({ key: type, target: { type }, insert: type as AddBelowType })),
];

export default function RichTextBlockControls({ editor, editable, isMobile }: { editor: Editor; editable: boolean; isMobile: boolean }) {
  const { t } = useTranslation();
  const hovered = useRef<{ pos: number; leaf: boolean } | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ from: number; top: number; left: number; doc: typeof editor.state.doc } | null>(null);
  const [panel, setPanel] = useState<"main" | "convert" | "insert">("main");

  const open = (from: number, rect: Pick<DOMRect, "right" | "bottom">) => {
    if (!editor.isEditable) return;
    setPanel("main");
    setMenu({ from, doc: editor.state.doc, left: Math.max(8, Math.min(rect.right + 4, window.innerWidth - 232)), top: Math.max(8, Math.min(rect.bottom, window.innerHeight - 320)) });
  };

  useEffect(() => {
    const onOpen = (event: Event) => {
      if ((event as CustomEvent).detail?.editorId !== getSlashEditorId(editor)) return;
      const from = editor.state.selection.from;
      open(from, editor.view.coordsAtPos(from));
    };
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged || !editor.isEditable) setMenu(null);
    };
    window.addEventListener("nowen:open-block-menu", onOpen);
    editor.on("transaction", onTransaction);
    return () => {
      window.removeEventListener("nowen:open-block-menu", onOpen);
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  useEffect(() => { if (!editable) setMenu(null); }, [editable]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => { if (!popup.current?.contains(event.target as Node)) setMenu(null); };
    const close = () => setMenu(null);
    const onScroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) close(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const run = async (action: "copy" | "cut" | "paste" | "delete") => {
    if (!menu || !editor.isEditable || !editor.state.doc.eq(menu.doc)) return;
    const { from } = menu;
    setMenu(null);
    if (action === "delete") { deleteBlock(editor, from); return; }
    const ok = await (action === "copy" ? copyBlock(editor, from) : action === "cut" ? cutBlock(editor, from) : pasteBlock(editor, from));
    if (!ok) toast.error(t(`richText.${action}Failed`));
  };

  if (!editable) return null;
  const buttonClass = "w-full rounded px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover focus:bg-app-hover";
  return <>
    {!isMobile && <>
      <ColumnToolbar editor={editor} editable={editable} />
      <DragHandle editor={editor} className="tiptap-drag-handle" computePositionConfig={{ placement: "left-start" }} nested={{ edgeDetection: "none" }} onNodeChange={({ node, pos }) => {
        hovered.current = node && pos >= 0 ? { pos, leaf: node.isLeaf } : null;
      }}>
        <button type="button" className="tiptap-drag-handle__grip" aria-label={t("slash.blockMenu")} onClick={(event) => {
          event.preventDefault();
          const target = hovered.current;
          if (target) open(target.pos + (target.leaf ? 0 : 1), event.currentTarget.getBoundingClientRect());
        }}><GripVertical size={16} /></button>
      </DragHandle>
    </>}
    {menu && createPortal(<div ref={popup} role="menu" aria-label={t("slash.blockMenu")} className="fixed z-[80] w-56 overflow-y-auto rounded-lg border border-app-border bg-app-elevated p-1 shadow-xl" style={{ top: menu.top, left: menu.left, maxHeight: `min(360px, calc(100dvh - ${menu.top + 8}px))` }} onMouseDown={(event) => event.preventDefault()}>
      {panel === "main" ? <>
        <button type="button" className={buttonClass} onClick={() => setPanel("convert")}>{t("slash.convertTitle")}</button>
        {(["copy", "cut", "paste", "delete"] as const).map((action) => <button type="button" role="menuitem" className={buttonClass} key={action} onClick={() => void run(action)}>{t(`slash.action${action[0].toUpperCase()}${action.slice(1)}`)}</button>)}
        <button type="button" className={buttonClass} onClick={() => setPanel("insert")}>{t("slash.actionAddBelow")}</button>
      </> : <>
        <button type="button" className={buttonClass} onClick={() => setPanel("main")}>{t("common.back")}</button>
        {targets.map(({ key, target, insert }) => <button key={key} type="button" role="menuitem" className={buttonClass} onClick={() => {
          if (!editor.isEditable || !editor.state.doc.eq(menu.doc)) return;
          if (panel === "convert") {
            if (!convertBlock(editor, target, menu.from)) toast.error(t("richText.convertUnsupported"));
          }
          else addBlockBelow(editor, insert, menu.from);
          setMenu(null);
          editor.commands.focus();
        }}>{t(`slash.convert.${key}`)}</button>)}
      </>}
    </div>, document.body)}
  </>;
}
