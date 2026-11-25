import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Capacitor } from "@capacitor/core";
import {
  BrainCircuit,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileType2,
  FolderPlus,
  LayoutTemplate,
  Lock,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import EncryptedNoteCreateDialog from "@/components/EncryptedNoteCreateDialog";
import NoteTemplatePickerDialog from "@/components/NoteTemplatePickerDialog";
import { prompt } from "@/components/ui/confirm";
import { api, getCurrentWorkspace } from "@/lib/api";
import { isExcelCreationEnabled } from "@/lib/excelApi";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { registerMobileBackHandler } from "@/lib/mobileBackNavigation";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";
import { MOTION_SPRING, overlayMotion } from "@/lib/motion";
import { markNewNoteForImmediateEdit } from "@/lib/newNoteImmediateEdit";
import { noteTemplatesApi } from "@/lib/noteTemplatesApi";
import { pluginApi } from "@/lib/pluginApi";
import { emitKnowledgeTreeRefresh } from "@/lib/workspaceRefreshBridge";
import { useApp, useAppActions } from "@/store/AppContext";

export interface MobileLiteCreateSheetProps {
  open: boolean;
  onClose: () => void;
  onCreateNote: (kind: "normal" | "markdown" | "plaintext") => Promise<void> | void;
  onCreateFolder: (title: string) => Promise<void> | void;
  onCreateMindMap: (title: string) => Promise<void> | void;
  onCreateExcel: (title: string) => Promise<void> | void;
}

export default function MobileLiteCreateSheet({
  open,
  onClose,
  onCreateNote,
  onCreateFolder,
  onCreateMindMap,
  onCreateExcel,
}: MobileLiteCreateSheetProps) {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();
  const currentParentId = state.selectedKnowledgeTreeParentId ?? null;
  const localMode = isMobileLocalMode();
  const [templateOpen, setTemplateOpen] = useState(false);
  const [encryptedOpen, setEncryptedOpen] = useState(false);
  const [excelEnabled, setExcelEnabled] = useState(false);

  useEffect(() => {
    if (!open || localMode) return;
    let cancelled = false;
    void isExcelCreationEnabled()
      .then((enabled) => { if (!cancelled) setExcelEnabled(enabled); })
      .catch(() => { if (!cancelled) setExcelEnabled(false); });
    return () => { cancelled = true; };
  }, [localMode, open]);

  useEffect(() => {
    if (!open) return;
    return registerMobileBackHandler("sheet", () => {
      onClose();
      return true;
    });
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const handleFolderClick = async () => {
    onClose();
    const entered = await prompt({
      title: t("mobileLite.directory.folderPromptTitle"),
      placeholder: t("mobileLite.directory.folderPromptPlaceholder"),
      confirmText: t("common.confirm"),
    });
    if (entered?.trim()) {
      await onCreateFolder(entered.trim());
    }
  };

  const handleMindMapClick = async () => {
    onClose();
    const entered = await prompt({
      title: t("mobileLite.create.mindmap"),
      defaultValue: t("mobileLite.create.mindmap"),
      confirmText: t("common.confirm"),
    });
    if (entered?.trim()) {
      await onCreateMindMap(entered.trim());
    }
  };

  const handleExcelClick = async () => {
    onClose();
    const entered = await prompt({
      title: t("mobileLite.create.excel"),
      defaultValue: t("mobileLite.create.excel"),
      confirmText: t("common.confirm"),
    });
    if (entered?.trim()) {
      await onCreateExcel(entered.trim());
    }
  };

  const openTemplateNote = async (result: { noteId: string; node: KnowledgeTreeNode }) => {
    setTemplateOpen(false);
    emitKnowledgeTreeRefresh("mobile-lite-template-created");
    actions.refreshNotebooks();
    actions.refreshNotes();
    const note = await api.getNote(result.noteId);
    markNewNoteForImmediateEdit(note.id);
    actions.setActiveNote(note);
    actions.addNoteToList(note);
    actions.setMobileView("editor");
  };

  const items = [
    {
      id: "normal",
      icon: <FileText size={18} className="text-accent-primary" />,
      title: t("mobileLite.create.normal"),
      desc: t("mobileLite.create.normalDesc"),
      onClick: () => { onClose(); void onCreateNote("normal"); },
    },
    {
      id: "markdown",
      icon: <FileCode size={18} className="text-emerald-500" />,
      title: t("mobileLite.create.markdown"),
      desc: t("mobileLite.create.markdownDesc"),
      onClick: () => { onClose(); void onCreateNote("markdown"); },
    },
    {
      id: "plaintext",
      icon: <FileType2 size={18} className="text-sky-500" />,
      title: t("mobileLite.create.plaintext"),
      desc: t("mobileLite.create.plaintextDesc"),
      onClick: () => { onClose(); void onCreateNote("plaintext"); },
    },
    ...(!localMode
      ? [
        {
          id: "mindmap",
          icon: <BrainCircuit size={18} className="text-violet-500" />,
          title: t("mobileLite.create.mindmap"),
          desc: t("mobileLite.create.mindmapDesc"),
          onClick: () => { void handleMindMapClick(); },
        },
        ...(excelEnabled
          ? [
            {
              id: "excel",
              icon: <FileSpreadsheet size={18} className="text-emerald-600" />,
              title: t("mobileLite.create.excel"),
              desc: t("mobileLite.create.excelDesc"),
              onClick: () => { void handleExcelClick(); },
            },
          ]
          : []),
        {
          id: "template",
          icon: <LayoutTemplate size={18} className="text-indigo-500" />,
          title: t("mobileLite.create.template"),
          desc: t("mobileLite.create.templateDesc"),
          onClick: () => { onClose(); setTemplateOpen(true); },
        },
      ]
      : []),
    {
      id: "folder",
      icon: <FolderPlus size={18} className="text-amber-500" />,
      title: t("mobileLite.create.folder"),
      desc: t("mobileLite.create.folderDesc"),
      onClick: () => { void handleFolderClick(); },
    },
    ...(!localMode && !Capacitor.isNativePlatform()
      ? [
        {
          id: "encrypted",
          icon: <Lock size={18} className="text-orange-500" />,
          title: t("mobileLite.create.encrypted"),
          desc: t("mobileLite.create.encryptedDesc"),
          onClick: () => { onClose(); setEncryptedOpen(true); },
        },
      ]
      : []),
  ];

  return (
    <>
      <AnimatePresence>
        {open && (
          <div
            data-mobile-lite-create-sheet=""
            data-swipe-blocker="mobile-lite-create"
            className="fixed inset-0 z-50 flex flex-col justify-end md:hidden"
            role="dialog"
            aria-modal="true"
            aria-label={t("mobileLite.create.title")}
          >
            <motion.div
              initial={overlayMotion.initial}
              animate={overlayMotion.animate}
              exit={overlayMotion.exit}
              onClick={onClose}
              className="absolute inset-0 bg-zinc-900/55 backdrop-blur-[2px]"
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={MOTION_SPRING.panel}
              className="relative flex max-h-[80dvh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-app-border bg-app-elevated shadow-2xl"
              style={{ paddingBottom: "var(--safe-area-bottom)" }}
            >
              <div className="flex justify-center pt-2 pb-1 shrink-0" aria-hidden="true">
                <span className="h-1 w-10 rounded-full bg-app-border" />
              </div>

              <div className="flex items-start justify-between gap-2 px-4 pb-2 shrink-0">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-tx-primary">
                    {t("mobileLite.create.title")}
                  </h2>
                  <p className="mt-0.5 text-xs text-tx-tertiary">
                    {t("mobileLite.create.subtitle")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={t("mobileLite.create.close")}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 space-y-1.5">
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-mobile-lite-create-option={item.id}
                    onClick={item.onClick}
                    className="flex min-h-[54px] w-full items-center gap-3 rounded-xl border border-app-border/70 bg-app-surface px-3.5 py-2.5 text-left transition-colors hover:bg-app-hover active:scale-[0.99]"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-app-hover">
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-tx-primary">{item.title}</span>
                      <span className="block truncate text-xs text-tx-tertiary">{item.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <NoteTemplatePickerDialog
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        parentId={currentParentId}
        onCreate={async (templateId) => {
          await openTemplateNote(await noteTemplatesApi.createNote(templateId, currentParentId));
        }}
        onCreatePlugin={async (pluginId, templateId, values) => {
          const result = await pluginApi.createNoteFromTemplate(pluginId, templateId, {
            workspaceId: getCurrentWorkspace(),
            parentId: currentParentId,
            values,
          });
          await openTemplateNote({ noteId: result.noteId, node: result.node as KnowledgeTreeNode });
        }}
      />

      {encryptedOpen && (
        <EncryptedNoteCreateDialog
          parentId={currentParentId}
          onClose={() => setEncryptedOpen(false)}
        />
      )}
    </>
  );
}
