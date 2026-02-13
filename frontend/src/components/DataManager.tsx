import React, { useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Download, Upload, CheckCircle, Loader2, FileText,
  AlertCircle, Trash2, FileUp, FolderDown, AlertTriangle
} from "lucide-react";
import { exportAllNotes, ExportProgress } from "@/lib/exportService";
import {
  readMarkdownFiles, readMarkdownFromZip, importNotes,
  ImportFileInfo, ImportProgress
} from "@/lib/importService";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";

export default function DataManager() {
  const { state } = useApp();
  const actions = useAppActions();

  // Export state
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  // Import state
  const [importFiles, setImportFiles] = useState<ImportFileInfo[]>([]);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 全量导出
  const handleExportAll = async () => {
    setIsExporting(true);
    setExportProgress(null);
    await exportAllNotes((p) => setExportProgress(p));
    setIsExporting(false);
  };

  // 拖拽处理
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    await processFiles(files);
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await processFiles(e.target.files);
    }
  };

  const processFiles = async (files: FileList) => {
    let result: ImportFileInfo[] = [];
    const fileArray = Array.from(files);
    const zipFile = fileArray.find((f) => f.name.endsWith(".zip"));

    if (zipFile) {
      result = await readMarkdownFromZip(zipFile);
    } else {
      result = await readMarkdownFiles(files);
    }

    setImportFiles(result);
  };

  const toggleFileSelection = (index: number) => {
    setImportFiles((prev) =>
      prev.map((f, i) => (i === index ? { ...f, selected: !f.selected } : f))
    );
  };

  const toggleAll = () => {
    const allSelected = importFiles.every((f) => f.selected);
    setImportFiles((prev) => prev.map((f) => ({ ...f, selected: !allSelected })));
  };

  const handleImport = async () => {
    setIsImporting(true);
    setImportProgress(null);
    const result = await importNotes(
      importFiles,
      selectedNotebookId || undefined,
      (p) => setImportProgress(p)
    );
    setIsImporting(false);

    if (result.success) {
      api.getNotebooks().then(actions.setNotebooks).catch(console.error);
      setTimeout(() => {
        setImportFiles([]);
        setImportProgress(null);
      }, 3000);
    }
  };

  const clearImportList = () => {
    setImportFiles([]);
    setImportProgress(null);
  };

  const selectedCount = importFiles.filter((f) => f.selected).length;

  // Danger Zone state
  const [showResetModal, setShowResetModal] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [isResetting, setIsResetting] = useState(false);
  const [resetError, setResetError] = useState("");
  const [shake, setShake] = useState(false);

  const handleFactoryReset = async () => {
    if (confirmText !== "RESET") {
      setResetError("请输入正确的校验词");
      setShake(true);
      setTimeout(() => setShake(false), 400);
      return;
    }

    setIsResetting(true);
    setResetError("");

    try {
      await api.factoryReset(confirmText);
      localStorage.clear();
      sessionStorage.clear();
      window.location.reload();
    } catch (err: any) {
      setResetError(err.message || "重置失败");
      setIsResetting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">数据管理</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
          导入导出你的笔记数据，你的数据永远属于你自己
        </p>
      </div>

      {/* ===== 导出区域 ===== */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <FolderDown size={18} className="text-indigo-500" />
          <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">导出备份</h4>
        </div>

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
            将所有笔记按笔记本分类导出为 Markdown 文件，打包成 ZIP 压缩包。
            含 YAML frontmatter 元数据，兼容 Obsidian、Typora 等工具。
          </p>

          {exportProgress && (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                {exportProgress.phase === "error" ? (
                  <AlertCircle size={16} className="text-red-500" />
                ) : exportProgress.phase === "done" ? (
                  <CheckCircle size={16} className="text-green-500" />
                ) : (
                  <Loader2 size={16} className="text-indigo-500 animate-spin" />
                )}
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  {exportProgress.message}
                </span>
              </div>
              {exportProgress.phase === "packing" && (
                <div className="w-full bg-zinc-200 dark:bg-zinc-700 rounded-full h-1.5">
                  <motion.div
                    className="bg-indigo-500 h-1.5 rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${exportProgress.current}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
              )}
            </div>
          )}

          <button
            onClick={handleExportAll}
            disabled={isExporting}
            className={`flex items-center justify-center w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-all ${
              isExporting
                ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 cursor-not-allowed"
                : exportProgress?.phase === "done"
                ? "bg-green-500 hover:bg-green-600 text-white shadow-md"
                : "bg-indigo-600 hover:bg-indigo-700 text-white shadow-md hover:shadow-lg"
            }`}
          >
            {isExporting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                正在导出...
              </>
            ) : exportProgress?.phase === "done" ? (
              <>
                <CheckCircle className="w-4 h-4 mr-2" />
                导出成功
              </>
            ) : (
              <>
                <Download className="w-4 h-4 mr-2" />
                全量导出为 ZIP
              </>
            )}
          </button>
        </div>
      </section>

      {/* ===== 导入区域 ===== */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <FileUp size={18} className="text-emerald-500" />
          <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">导入笔记</h4>
        </div>

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
            支持拖拽 Markdown (.md) 文件或 ZIP 压缩包。自动解析文件名作为标题，内容转换为富文本。
          </p>

          {/* Dropzone */}
          {importFiles.length === 0 && (
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
                isDragOver
                  ? "border-indigo-400 bg-indigo-50/50 dark:bg-indigo-500/5 dark:border-indigo-500"
                  : "border-zinc-300 dark:border-zinc-700 hover:border-indigo-300 dark:hover:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".md,.txt,.markdown,.zip"
                onChange={handleFileSelect}
                className="hidden"
              />
              <Upload
                size={32}
                className={`mx-auto mb-3 ${
                  isDragOver ? "text-indigo-500" : "text-zinc-400 dark:text-zinc-500"
                }`}
              />
              <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                拖拽文件到这里，或点击选择
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-600 mt-1">
                支持 .md、.txt、.zip 文件
              </p>
            </div>
          )}

          {/* 文件预览列表 */}
          {importFiles.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={toggleAll}
                    className="text-xs text-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 font-medium"
                  >
                    {importFiles.every((f) => f.selected) ? "取消全选" : "全选"}
                  </button>
                  <span className="text-xs text-zinc-400 dark:text-zinc-600">
                    已选择 {selectedCount} / {importFiles.length} 个文件
                  </span>
                </div>
                <button
                  onClick={clearImportList}
                  className="p-1 rounded text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {/* 目标笔记本选择 */}
              <div className="mb-3">
                <label className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 block">导入到笔记本：</label>
                <select
                  value={selectedNotebookId}
                  onChange={(e) => setSelectedNotebookId(e.target.value)}
                  className="w-full text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-3 py-1.5 outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500"
                >
                  <option value="">自动创建「导入的笔记」</option>
                  {state.notebooks.map((nb) => (
                    <option key={nb.id} value={nb.id}>
                      {nb.icon} {nb.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2">
                {importFiles.map((file, idx) => (
                  <label
                    key={idx}
                    className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                      file.selected
                        ? "bg-indigo-50/50 dark:bg-indigo-500/5"
                        : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={file.selected}
                      onChange={() => toggleFileSelection(idx)}
                      className="w-3.5 h-3.5 rounded border-zinc-300 dark:border-zinc-600 text-indigo-500 focus:ring-indigo-500/30"
                    />
                    <FileText size={14} className="text-zinc-400 dark:text-zinc-500 flex-shrink-0" />
                    <span className="text-sm text-zinc-700 dark:text-zinc-300 truncate flex-1">
                      {file.title}
                    </span>
                    <span className="text-xs text-zinc-400 dark:text-zinc-600 flex-shrink-0">
                      {(file.size / 1024).toFixed(1)} KB
                    </span>
                  </label>
                ))}
              </div>

              {/* 导入进度 */}
              {importProgress && (
                <div className="mt-3 flex items-center gap-2">
                  {importProgress.phase === "error" ? (
                    <AlertCircle size={14} className="text-red-500" />
                  ) : importProgress.phase === "done" ? (
                    <CheckCircle size={14} className="text-green-500" />
                  ) : (
                    <Loader2 size={14} className="text-indigo-500 animate-spin" />
                  )}
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">
                    {importProgress.message}
                  </span>
                </div>
              )}

              {/* 导入按钮 */}
              <button
                onClick={handleImport}
                disabled={isImporting || selectedCount === 0}
                className={`mt-3 flex items-center justify-center w-full py-2.5 px-4 rounded-lg font-medium text-sm transition-all ${
                  isImporting || selectedCount === 0
                    ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-600 cursor-not-allowed"
                    : importProgress?.phase === "done"
                    ? "bg-green-500 hover:bg-green-600 text-white shadow-md"
                    : "bg-emerald-600 hover:bg-emerald-700 text-white shadow-md hover:shadow-lg"
                }`}
              >
                {isImporting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    正在导入...
                  </>
                ) : importProgress?.phase === "done" ? (
                  <>
                    <CheckCircle className="w-4 h-4 mr-2" />
                    导入成功
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    导入 {selectedCount} 篇笔记
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ===== 危险区域 (Danger Zone) ===== */}
      <section className="mt-8 pt-6 border-t-2 border-dashed border-red-300/50 dark:border-red-900/40">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle size={18} className="text-red-500" />
          <h4 className="text-base font-bold text-red-600 dark:text-red-500">危险区域</h4>
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          该操作将永久删除系统内的所有笔记、待办事项、标签和笔记本，并将管理员账户恢复为初始状态（用户名: admin / 密码: admin123）。此操作不可逆！
        </p>

        <button
          onClick={() => { setShowResetModal(true); setConfirmText(""); setResetError(""); }}
          className="px-4 py-2 border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 font-medium rounded-lg transition-colors text-sm"
        >
          恢复出厂设置
        </button>

        {/* 二次确认模态框 */}
        <AnimatePresence>
          {showResetModal && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 bg-zinc-900/60 backdrop-blur-sm"
                onClick={() => !isResetting && setShowResetModal(false)}
              />

              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ type: "spring", duration: 0.4, bounce: 0 }}
                className="relative bg-white dark:bg-zinc-900 w-full max-w-md p-6 rounded-xl shadow-2xl border border-red-200 dark:border-red-900/50"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
                    <AlertTriangle size={20} className="text-red-600 dark:text-red-500" />
                  </div>
                  <h4 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                    确定要清空所有数据吗？
                  </h4>
                </div>

                <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-1">
                  这将会彻底擦除数据库中的所有内容，包括：
                </p>
                <ul className="text-sm text-zinc-500 dark:text-zinc-400 mb-4 list-disc list-inside space-y-0.5">
                  <li>所有笔记和笔记本</li>
                  <li>所有待办事项和标签</li>
                  <li>管理员密码将重置为 <code className="font-mono text-xs bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded">admin123</code></li>
                </ul>

                <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3">
                  请在下方输入{" "}
                  <span className="font-mono font-bold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-1.5 py-0.5 rounded">
                    RESET
                  </span>{" "}
                  以确认操作。
                </p>

                <motion.div
                  animate={shake ? { x: [-10, 10, -10, 10, 0] } : {}}
                  transition={{ duration: 0.4 }}
                >
                  <input
                    type="text"
                    value={confirmText}
                    onChange={(e) => {
                      setConfirmText(e.target.value);
                      setResetError("");
                    }}
                    placeholder="输入 RESET"
                    className={`w-full px-3 py-2 border rounded-lg bg-transparent text-zinc-900 dark:text-zinc-100 outline-none font-mono text-sm transition-colors ${
                      resetError
                        ? "border-red-500/50 focus:ring-2 focus:ring-red-500/30"
                        : "border-zinc-300 dark:border-zinc-700 focus:ring-2 focus:ring-red-500/30 focus:border-red-500"
                    }`}
                    autoFocus
                  />
                </motion.div>

                {resetError && (
                  <p className="text-sm text-red-500 mt-2">{resetError}</p>
                )}

                <div className="flex justify-end gap-3 mt-5">
                  <button
                    onClick={() => setShowResetModal(false)}
                    disabled={isResetting}
                    className="px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleFactoryReset}
                    disabled={isResetting || confirmText !== "RESET"}
                    className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg flex items-center transition-colors"
                  >
                    {isResetting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    确认销毁数据
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}
