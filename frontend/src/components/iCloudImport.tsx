import React, { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Loader2, CheckCircle, AlertCircle, CloudDownload,
  FileText, Trash2, ExternalLink, Copy, ClipboardPaste
} from "lucide-react";
import { SiApple } from "react-icons/si";
import { useTranslation } from "react-i18next";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";

interface iCloudNoteEntry {
  id: string;
  title: string;
  content: string;
  folder?: string;
  date?: string;
  createDate?: string;
  modifyDate?: string;
  selected: boolean;
}

// 提供给用户在 iCloud.com 网页控制台运行的提取脚本
// 基于 iCloud.com/notes 真实 DOM 结构精确匹配
const EXTRACT_SCRIPT = `(async () => {
  try {
    console.log("=== iPhone 备忘录提取工具 v2 ===");
    console.log("正在扫描 iCloud 备忘录页面...");
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ① 获取文件夹列表(用于按文件夹提取全部备忘录) */
    const folderItems = document.querySelectorAll(".folder-list .folder-list-item-container");
    if (!folderItems.length) {
      console.error("❌ 未找到文件夹列表，请确保在 iCloud.com/notes 页面并已完全加载");
      console.log("当前页面 URL:", location.href);
      return;
    }
    console.log("找到 " + folderItems.length + " 个文件夹/分类");

    /* ② 点击"所有 iCloud 备忘录"以显示全部 */
    const allFolder = document.querySelector('[data-id*="iCloudFolder"]') || folderItems[0];
    if (allFolder) { allFolder.querySelector(".folder-title-select-button")?.click(); await delay(1500); }

    /* ③ 收集备忘录列表项 */
    const listItems = document.querySelectorAll(".cw-collection-view .list-item");
    if (!listItems.length) {
      console.error("❌ 未找到备忘录列表，可能页面未加载完成，请稍后重试");
      return;
    }
    console.log("找到 " + listItems.length + " 条备忘录，开始逐条提取内容...");

    const notes = [];
    for (let i = 0; i < listItems.length; i++) {
      try {
        /* 点击列表项加载内容到编辑器 */
        listItems[i].click();
        await delay(1500);

        /* 从列表项提取元数据 */
        const titleEl = listItems[i].querySelector(".note-list-item-title");
        const dateEl = listItems[i].querySelector(".note-list-item-date");
        const folderEl = listItems[i].querySelector(".note-list-item-folder-title");
        const snippetEl = listItems[i].querySelector(".note-list-item-snippet");

        const title = titleEl ? titleEl.textContent.trim() : "";
        const date = dateEl ? dateEl.textContent.trim() : "";
        const folder = folderEl ? folderEl.textContent.trim() : "";

        /* 从编辑器区域提取内容（优先 innerHTML 以保留格式） */
        let content = "";
        const editorDiv = document.querySelector(".ct-input-manager > div[tabindex]");
        if (editorDiv) {
          /* 提取编辑器内容，排除 header/footer 辅助元素 */
          const clone = editorDiv.cloneNode(true);
          clone.querySelectorAll("header, footer").forEach((el) => el.remove());
          content = clone.innerHTML.trim();
          /* 清理空白内容 */
          if (content.replace(/<[^>]+>/g, "").trim().length === 0) {
            content = clone.textContent.trim();
          }
        }

        /* 编辑器为 canvas 渲染时的备用方案 */
        if (!content) {
          const snippet = snippetEl ? snippetEl.textContent.trim() : "";
          content = title + (snippet && snippet !== "无其他文本" ? "\\n" + snippet : "");
        }

        const noteData = {
          id: String(i + 1),
          title: title || "备忘录 " + (i + 1),
          content: content || title || "备忘录 " + (i + 1),
          folder: folder,
          date: date
        };
        notes.push(noteData);
        console.log("[" + (i + 1) + "/" + listItems.length + "] " + noteData.title.substring(0, 30) + " (" + content.length + "字)" + (folder ? " [📁" + folder + "]" : ""));
      } catch (e) {
        console.warn("第 " + (i + 1) + " 条提取失败:", e.message);
      }
    }

    if (!notes.length) {
      console.error("❌ 未能提取任何备忘录");
      return;
    }

    const json = JSON.stringify(notes, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      console.log("\\n✅ 完成! " + notes.length + " 条备忘录已复制到剪贴板");
      console.log("请回到 nowen-note 的「iPhone 备忘录导入」区域粘贴数据。");
    } catch (e) {
      window.__icloudNotes = json;
      console.log("\\n⚠️ 自动复制失败，请手动运行以下命令复制:");
      console.log("copy(window.__icloudNotes)");
    }
  } catch (e) {
    console.error("提取失败:", e);
  }
})()`;


export default function ICloudImport() {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();

  const [jsonInput, setJsonInput] = useState("");
  const [phase, setPhase] = useState<"idle" | "parsed" | "importing" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [notes, setNotes] = useState<iCloudNoteEntry[]>([]);
  const [importedCount, setImportedCount] = useState(0);
  const [selectedNotebookId, setSelectedNotebookId] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [copied, setCopied] = useState(false);

  const selectedCount = notes.filter((n) => n.selected).length;

  // 复制提取脚本
  const handleCopyScript = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(EXTRACT_SCRIPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = EXTRACT_SCRIPT;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, []);

  // 解析 JSON 数据
  const handleParse = useCallback(() => {
    if (!jsonInput.trim()) {
      setMessage(t("iCloud.jsonRequired"));
      setPhase("error");
      return;
    }

    try {
      const data = JSON.parse(jsonInput.trim());
      if (!Array.isArray(data) || data.length === 0) {
        setMessage(t("iCloud.invalidData"));
        setPhase("error");
        return;
      }

      const parsed: iCloudNoteEntry[] = data.map((n: any) => ({
        id: String(n.id || n.noteId || Date.now() + Math.random()),
        title:
          n.title ||
          (n.content || "")
            .split("\n")[0]
            ?.replace(/<[^>]+>/g, "")
            .substring(0, 50) ||
          t("iCloud.untitled"),
        content: n.content || n.text || n.body || "",
        folder: n.folder || "",
        date: n.date || "",
        createDate: n.createDate || "",
        modifyDate: n.modifyDate || n.date || "",
        selected: true,
      }));

      setNotes(parsed);
      setPhase("parsed");
      setMessage(t("iCloud.parseSuccess", { count: parsed.length }));
    } catch {
      setMessage(t("iCloud.parseError"));
      setPhase("error");
    }
  }, [jsonInput, t]);

  // 导入选中笔记
  const handleImport = useCallback(async () => {
    const selectedNotes = notes.filter((n) => n.selected);
    if (selectedNotes.length === 0) return;

    setPhase("importing");
    setMessage(t("iCloud.importing", { count: selectedNotes.length }));

    try {
      const result = await api.icloudImport(
        selectedNotes.map((n) => ({
          id: n.id,
          title: n.title,
          content: n.content,
          folder: n.folder,
          date: n.date,
          createDate: n.createDate,
          modifyDate: n.modifyDate,
        })),
        selectedNotebookId || undefined
      );

      if (result.success) {
        setImportedCount(result.count);
        setPhase("done");
        setMessage(t("iCloud.importSuccess", { count: result.count }));
        api.getNotebooks().then(actions.setNotebooks).catch(console.error);
      } else {
        setPhase("error");
        setMessage(t("iCloud.importFailed"));
      }
    } catch (err: any) {
      setPhase("error");
      setMessage(err.message || t("iCloud.importFailed"));
    }
  }, [notes, selectedNotebookId, t, actions]);

  const handleReset = useCallback(() => {
    setJsonInput("");
    setNotes([]);
    setPhase("idle");
    setMessage("");
    setImportedCount(0);
  }, []);

  const toggleNote = (id: string) => {
    setNotes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, selected: !n.selected } : n))
    );
  };

  const toggleAll = () => {
    const allSelected = notes.every((n) => n.selected);
    setNotes((prev) => prev.map((n) => ({ ...n, selected: !allSelected })));
  };

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <SiApple size={18} className="text-zinc-800 dark:text-zinc-200" />
        <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {t("iCloud.title")}
        </h4>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          {t("iCloud.description")}
        </p>

        {/* 数据输入区 */}
        {(phase === "idle" || phase === "error") && (
          <div className="space-y-3">
            {/* 使用教程 */}
            <div>
              <button
                onClick={() => setShowHelp(!showHelp)}
                className="text-xs text-blue-500 hover:text-blue-600 dark:hover:text-blue-400 font-medium mb-2"
              >
                {t("iCloud.howToExport")}
              </button>

              <AnimatePresence>
                {showHelp && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/30 text-xs text-zinc-600 dark:text-zinc-400 space-y-2">
                      <p className="font-medium text-blue-700 dark:text-blue-400">
                        {t("iCloud.helpTitle")}
                      </p>

                      {/* 方式一：通用方式 */}
                      <p className="font-medium text-blue-600 dark:text-blue-300 mt-2">
                        {t("iCloud.method1Title")}
                      </p>
                      <ol className="list-decimal list-inside space-y-1 ml-1">
                        <li>{t("iCloud.method1Step1")}</li>
                        <li>{t("iCloud.method1Step2")}</li>
                        <li>{t("iCloud.method1Step3")}</li>
                      </ol>

                      {/* 方式二：脚本提取 */}
                      <p className="font-medium text-blue-600 dark:text-blue-300 mt-3">
                        {t("iCloud.method2Title")}
                      </p>
                      <ol className="list-decimal list-inside space-y-1 ml-1">
                        <li>{t("iCloud.method2Step1")}</li>
                        <li>{t("iCloud.method2Step2")}</li>
                        <li>
                          {t("iCloud.method2Step3")}
                          <button
                            onClick={handleCopyScript}
                            className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
                          >
                            {copied ? (
                              <>
                                <CheckCircle size={10} />
                                {t("iCloud.copied")}
                              </>
                            ) : (
                              <>
                                <Copy size={10} />
                                {t("iCloud.copyScript")}
                              </>
                            )}
                          </button>
                        </li>
                        <li>{t("iCloud.method2Step4")}</li>
                        <li>{t("iCloud.method2Step5")}</li>
                      </ol>

                      <a
                        href="https://www.icloud.com/notes"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 mt-1"
                      >
                        {t("iCloud.openICloud")}
                        <ExternalLink size={10} />
                      </a>

                      <p className="text-amber-600 dark:text-amber-400 font-medium mt-2">
                        {t("iCloud.tip")}
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* JSON 输入 */}
            <div>
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-1 mb-1.5">
                <ClipboardPaste size={12} />
                {t("iCloud.jsonLabel")}
              </label>
              <textarea
                value={jsonInput}
                onChange={(e) => {
                  setJsonInput(e.target.value);
                  if (phase === "error") setPhase("idle");
                }}
                rows={4}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-700 dark:text-zinc-300 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 resize-none font-mono"
                placeholder={t("iCloud.jsonPlaceholder")}
              />
            </div>

            {/* 错误提示 */}
            {phase === "error" && message && (
              <div className="flex items-center gap-2 text-sm text-red-500">
                <AlertCircle size={14} />
                {message}
              </div>
            )}

            {/* 解析按钮 */}
            <button
              onClick={handleParse}
              disabled={!jsonInput.trim()}
              className={`flex items-center justify-center w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-all ${
                !jsonInput.trim()
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 cursor-not-allowed"
                  : "bg-blue-500 hover:bg-blue-600 text-white shadow-md hover:shadow-lg"
              }`}
            >
              <ClipboardPaste className="w-4 h-4 mr-2" />
              {t("iCloud.parseButton")}
            </button>
          </div>
        )}

        {/* 笔记列表 */}
        {(phase === "parsed" || phase === "importing" || phase === "done" || phase === "error") && notes.length > 0 && (
          <div className="space-y-3">
            {/* 操作栏 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleAll}
                  className="text-xs text-blue-500 hover:text-blue-600 dark:hover:text-blue-400 font-medium"
                >
                  {notes.every((n) => n.selected)
                    ? t("dataManager.deselectAll")
                    : t("dataManager.selectAll")}
                </button>
                <span className="text-xs text-zinc-400 dark:text-zinc-600">
                  {t("dataManager.selectedCount", {
                    selected: selectedCount,
                    total: notes.length,
                  })}
                </span>
              </div>
              <button
                onClick={handleReset}
                disabled={phase === "importing"}
                className="p-1 rounded text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-colors disabled:opacity-40"
              >
                <Trash2 size={14} />
              </button>
            </div>

            {/* 目标笔记本选择 */}
            <div>
              <label className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 block">
                {t("dataManager.importToNotebook")}
              </label>
              <select
                value={selectedNotebookId}
                onChange={(e) => setSelectedNotebookId(e.target.value)}
                className="w-full text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-3 py-1.5 outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
              >
                <option value="">{t("iCloud.autoCreateNotebook")}</option>
                {state.notebooks.map((nb) => (
                  <option key={nb.id} value={nb.id}>
                    {nb.icon} {nb.name}
                  </option>
                ))}
              </select>
            </div>

            {/* 笔记列表 */}
            <div className="max-h-64 overflow-y-auto space-y-1 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2">
              {notes.map((note) => (
                <label
                  key={note.id}
                  className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                    note.selected
                      ? "bg-blue-50/50 dark:bg-blue-500/5"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={note.selected}
                    onChange={() => toggleNote(note.id)}
                    className="w-3.5 h-3.5 rounded border-zinc-300 dark:border-zinc-600 text-blue-500 focus:ring-blue-500/30"
                  />
                  <FileText
                    size={14}
                    className="text-zinc-400 dark:text-zinc-500 flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-zinc-700 dark:text-zinc-300 truncate block">
                      {note.title || t("iCloud.untitled")}
                    </span>
                    {note.folder && (
                      <span className="text-[10px] text-zinc-400 dark:text-zinc-600">
                        📁 {note.folder}
                      </span>
                    )}
                  </div>
                  {note.date && (
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-600 flex-shrink-0">
                      {note.date}
                    </span>
                  )}
                </label>
              ))}
            </div>

            {/* 状态信息 */}
            {message && (
              <div className="flex items-center gap-2">
                {phase === "error" ? (
                  <AlertCircle size={14} className="text-red-500" />
                ) : phase === "done" ? (
                  <CheckCircle size={14} className="text-green-500" />
                ) : phase === "importing" ? (
                  <Loader2
                    size={14}
                    className="text-blue-500 animate-spin"
                  />
                ) : null}
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  {message}
                </span>
              </div>
            )}

            {/* 导入按钮 */}
            <button
              onClick={handleImport}
              disabled={phase === "importing" || selectedCount === 0}
              className={`flex items-center justify-center w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-all ${
                phase === "importing" || selectedCount === 0
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 cursor-not-allowed"
                  : phase === "done"
                  ? "bg-green-500 hover:bg-green-600 text-white shadow-md"
                  : "bg-blue-500 hover:bg-blue-600 text-white shadow-md hover:shadow-lg"
              }`}
            >
              {phase === "importing" ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t("iCloud.importing", { count: selectedCount })}
                </>
              ) : phase === "done" ? (
                <>
                  <CheckCircle className="w-4 h-4 mr-2" />
                  {t("iCloud.importSuccess", { count: importedCount })}
                </>
              ) : (
                <>
                  <CloudDownload className="w-4 h-4 mr-2" />
                  {t("iCloud.importButton", { count: selectedCount })}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
