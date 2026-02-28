import React, { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Smartphone, Loader2, CheckCircle, AlertCircle, CloudDownload,
  FileText, Trash2, ExternalLink, Copy, ClipboardPaste
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";

interface OppoNoteEntry {
  id: string;
  title: string;
  content: string;
  selected: boolean;
}

// 提供给用户在 OPPO 云便签网页控制台运行的提取脚本
// OPPO 便签内容是端到端加密的(AES)，API 返回密文，只有页面渲染后才是明文
// 方案：逐个点击左侧便签列表项，从右侧编辑器(.tiptap.ProseMirror)中提取解密后的内容
const EXTRACT_SCRIPT = `(async()=>{try{console.log("=== OPPO 云便签提取工具 v3 ===");const delay=ms=>new Promise(r=>setTimeout(r,ms));const notes=[];const items=document.querySelectorAll('.list-container .list-item');if(!items.length){console.error("未找到便签列表(.list-container .list-item)");return}console.log("找到 "+items.length+" 条便签");for(let i=0;i<items.length;i++){const liBox=items[i].querySelector('.li-box');if(liBox)liBox.click();else items[i].click();await delay(1500);const editor=document.querySelector('.tiptap.ProseMirror');let content='';if(editor){content=(editor.innerText||'').trim()}if(!content){const ce=document.querySelector('[contenteditable=true]');if(ce)content=(ce.innerText||'').trim()}const titleEl=items[i].querySelector('.no-img-title');const dateEl=items[i].querySelector('.bottom-time > span');const sourceEl=items[i].querySelector('.source');const title=(titleEl?titleEl.innerText.trim():'')||(content?content.split('\\n')[0].substring(0,50):'便签'+(i+1));const date=dateEl?dateEl.innerText.trim():'';const source=sourceEl?sourceEl.innerText.trim():'';notes.push({id:String(i+1),title:title,content:content||title,date:date,folder:source});console.log("["+(i+1)+"/"+items.length+"] "+title.substring(0,30)+" ("+content.length+"字)"+(source?' ['+source+']':''))}const json=JSON.stringify(notes,null,2);try{await navigator.clipboard.writeText(json);console.log("\\n=== 完成! "+notes.length+" 条便签已复制到剪贴板 ===\\n请回到 nowen-note 粘贴导入。")}catch(e){window.__oppoNotes=json;console.log("\\n自动复制失败，请手动运行:\\ncopy(window.__oppoNotes)\\n或: navigator.clipboard.writeText(window.__oppoNotes)")}}catch(e){console.error("提取失败:",e)}})()`;



export default function OppoCloudImport() {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();

  const [jsonInput, setJsonInput] = useState("");
  const [phase, setPhase] = useState<"idle" | "parsed" | "importing" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [notes, setNotes] = useState<OppoNoteEntry[]>([]);
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
      // fallback
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
      setMessage(t("oppoCloud.jsonRequired"));
      setPhase("error");
      return;
    }

    try {
      const data = JSON.parse(jsonInput.trim());
      if (!Array.isArray(data) || data.length === 0) {
        setMessage(t("oppoCloud.invalidData"));
        setPhase("error");
        return;
      }

      const parsed: OppoNoteEntry[] = data.map((n: any) => ({
        id: String(n.id || n.noteId || Date.now() + Math.random()),
        title: n.title || (n.content || "").split("\n")[0]?.replace(/<[^>]+>/g, "").substring(0, 50) || t("oppoCloud.untitled"),
        content: n.content || n.text || n.body || "",
        selected: true,
      }));

      setNotes(parsed);
      setPhase("parsed");
      setMessage(t("oppoCloud.parseSuccess", { count: parsed.length }));
    } catch {
      setMessage(t("oppoCloud.parseError"));
      setPhase("error");
    }
  }, [jsonInput, t]);

  // 导入选中笔记
  const handleImport = useCallback(async () => {
    const selectedNotes = notes.filter((n) => n.selected);
    if (selectedNotes.length === 0) return;

    setPhase("importing");
    setMessage(t("oppoCloud.importing", { count: selectedNotes.length }));

    try {
      const result = await api.oppoCloudImport(
        selectedNotes.map((n) => ({
          id: n.id,
          title: n.title,
          content: n.content,
        })),
        selectedNotebookId || undefined
      );

      if (result.success) {
        setImportedCount(result.count);
        setPhase("done");
        setMessage(t("oppoCloud.importSuccess", { count: result.count }));
        api.getNotebooks().then(actions.setNotebooks).catch(console.error);
      } else {
        setPhase("error");
        setMessage(t("oppoCloud.importFailed"));
      }
    } catch (err: any) {
      setPhase("error");
      setMessage(err.message || t("oppoCloud.importFailed"));
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
        <Smartphone size={18} className="text-green-500" />
        <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {t("oppoCloud.title")}
        </h4>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          {t("oppoCloud.description")}
        </p>

        {/* 数据输入区 */}
        {(phase === "idle" || phase === "error") && (
          <div className="space-y-3">
            {/* 使用教程 */}
            <div>
              <button
                onClick={() => setShowHelp(!showHelp)}
                className="text-xs text-green-500 hover:text-green-600 dark:hover:text-green-400 font-medium mb-2"
              >
                {t("oppoCloud.howToExport")}
              </button>

              <AnimatePresence>
                {showHelp && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="p-3 rounded-lg bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800/30 text-xs text-zinc-600 dark:text-zinc-400 space-y-2">
                      <p className="font-medium text-green-700 dark:text-green-400">
                        {t("oppoCloud.helpTitle")}
                      </p>
                      <ol className="list-decimal list-inside space-y-1 ml-1">
                        <li>{t("oppoCloud.helpStep1")}</li>
                        <li>{t("oppoCloud.helpStep2")}</li>
                        <li>
                          {t("oppoCloud.helpStep3")}
                          <button
                            onClick={handleCopyScript}
                            className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
                          >
                            {copied ? (
                              <>
                                <CheckCircle size={10} />
                                {t("oppoCloud.copied")}
                              </>
                            ) : (
                              <>
                                <Copy size={10} />
                                {t("oppoCloud.copyScript")}
                              </>
                            )}
                          </button>
                        </li>
                        <li>{t("oppoCloud.helpStep4")}</li>
                        <li>{t("oppoCloud.helpStep5")}</li>
                      </ol>
                      <a
                        href="https://cloud.heytap.com/owork/mapp/sticky-notes"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300 mt-1"
                      >
                        {t("oppoCloud.openOppoCloud")}
                        <ExternalLink size={10} />
                      </a>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* JSON 输入 */}
            <div>
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 flex items-center gap-1 mb-1.5">
                <ClipboardPaste size={12} />
                {t("oppoCloud.jsonLabel")}
              </label>
              <textarea
                value={jsonInput}
                onChange={(e) => {
                  setJsonInput(e.target.value);
                  if (phase === "error") setPhase("idle");
                }}
                rows={4}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-700 dark:text-zinc-300 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 outline-none focus:ring-2 focus:ring-green-500/30 focus:border-green-500 resize-none font-mono"
                placeholder={t("oppoCloud.jsonPlaceholder")}
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
                  : "bg-green-500 hover:bg-green-600 text-white shadow-md hover:shadow-lg"
              }`}
            >
              <ClipboardPaste className="w-4 h-4 mr-2" />
              {t("oppoCloud.parseButton")}
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
                  className="text-xs text-green-500 hover:text-green-600 dark:hover:text-green-400 font-medium"
                >
                  {notes.every((n) => n.selected) ? t("dataManager.deselectAll") : t("dataManager.selectAll")}
                </button>
                <span className="text-xs text-zinc-400 dark:text-zinc-600">
                  {t("dataManager.selectedCount", { selected: selectedCount, total: notes.length })}
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
                className="w-full text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-3 py-1.5 outline-none focus:ring-2 focus:ring-green-500/30 focus:border-green-500"
              >
                <option value="">{t("oppoCloud.autoCreateNotebook")}</option>
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
                      ? "bg-green-50/50 dark:bg-green-500/5"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={note.selected}
                    onChange={() => toggleNote(note.id)}
                    className="w-3.5 h-3.5 rounded border-zinc-300 dark:border-zinc-600 text-green-500 focus:ring-green-500/30"
                  />
                  <FileText size={14} className="text-zinc-400 dark:text-zinc-500 flex-shrink-0" />
                  <span className="text-sm text-zinc-700 dark:text-zinc-300 truncate flex-1">
                    {note.title || t("oppoCloud.untitled")}
                  </span>
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
                  <Loader2 size={14} className="text-green-500 animate-spin" />
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
                  : "bg-green-500 hover:bg-green-600 text-white shadow-md hover:shadow-lg"
              }`}
            >
              {phase === "importing" ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t("oppoCloud.importing", { count: selectedCount })}
                </>
              ) : phase === "done" ? (
                <>
                  <CheckCircle className="w-4 h-4 mr-2" />
                  {t("oppoCloud.importSuccess", { count: importedCount })}
                </>
              ) : (
                <>
                  <CloudDownload className="w-4 h-4 mr-2" />
                  {t("oppoCloud.importButton", { count: selectedCount })}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
