import React, { useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Download, Upload, CheckCircle, Loader2, X, FileText,
  AlertCircle, Archive, Trash2, FileUp, FolderDown
} from "lucide-react";
import { exportAllNotes, exportSingleNote, ExportProgress } from "@/lib/exportService";
import {
  readMarkdownFiles, readMarkdownFromZip, importNotes,
  ImportFileInfo, ImportProgress
} from "@/lib/importService";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";
import { Notebook } from "@/types";

interface DataManagerProps {
  onClose: () => void;
}

export default function DataManager({ onClose }: DataManagerProps) {
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

    // 检查是否是 ZIP 文件
    const fileArray = Array.from(files);
    const zipFile = fileArray.find((f) => f.name.endsWith(".zip"));

    if (zipFile) {
      result = await readMarkdownFromZip(zipFile);
    } else {
      result = await readMarkdownFiles(files);
    }

    setImportFiles(result);
  };

  // 切换文件选择状态
  const toggleFileSelection = (index: number) => {
    setImportFiles((prev) =>
      prev.map((f, i) => (i === index ? { ...f, selected: !f.selected } : f))
    );
  };

  // 全选/取消全选
  const toggleAll = () => {
    const allSelected = importFiles.every((f) => f.selected);
    setImportFiles((prev) => prev.map((f) => ({ ...f, selected: !allSelected })));
  };

  // 执行导入
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
      // 刷新笔记本和笔记列表
      api.getNotebooks().then(actions.setNotebooks).catch(console.error);
      // 3秒后清空导入列表
      setTimeout(() => {
        setImportFiles([]);
        setImportProgress(null);
      }, 3000);
    }
  };

  // 清空导入列表
  const clearImportList = () => {
    setImportFiles([]);
    setImportProgress(null);
  };

  const selectedCount = importFiles.filter((f) => f.selected).length;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="w-full max-w-2xl max-h-[85vh] bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-zinc-800 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-zinc-800">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-zinc-100">数据管理</h2>
            <p className="text-sm text-gray-500 dark:text-zinc-400 mt-0.5">
              导入导出你的笔记数据，你的数据永远属于你自己
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* ===== 导出区域 ===== */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <FolderDown size={18} className="text-indigo-500" />
              <h3 className="text-base font-semibold text-gray-900 dark:text-zinc-100">导出备份</h3>
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50/50 dark:bg-zinc-800/30 p-4">
              <p className="text-sm text-gray-500 dark:text-zinc-400 mb-4">
                将所有笔记按笔记本分类导出为 Markdown 文件，打包成 ZIP 压缩包。
                含 YAML frontmatter 元数据，兼容 Obsidian、Typora 等工具。
              </p>

              {/* 导出进度 */}
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
                    <span className="text-sm text-gray-600 dark:text-zinc-400">
                      {exportProgress.message}
                    </span>
                  </div>
                  {exportProgress.phase === "packing" && (
                    <div className="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-1.5">
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
                    ? "bg-gray-100 dark:bg-zinc-800 text-gray-400 dark:text-zinc-600 cursor-not-allowed"
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
              <h3 className="text-base font-semibold text-gray-900 dark:text-zinc-100">导入笔记</h3>
            </div>

            <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50/50 dark:bg-zinc-800/30 p-4">
              <p className="text-sm text-gray-500 dark:text-zinc-400 mb-4">
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
                      : "border-gray-300 dark:border-zinc-700 hover:border-indigo-300 dark:hover:border-zinc-600 hover:bg-gray-50 dark:hover:bg-zinc-800/50"
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
                      isDragOver ? "text-indigo-500" : "text-gray-400 dark:text-zinc-500"
                    }`}
                  />
                  <p className="text-sm font-medium text-gray-600 dark:text-zinc-400">
                    拖拽文件到这里，或点击选择
                  </p>
                  <p className="text-xs text-gray-400 dark:text-zinc-600 mt-1">
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
                      <span className="text-xs text-gray-400 dark:text-zinc-600">
                        已选择 {selectedCount} / {importFiles.length} 个文件
                      </span>
                    </div>
                    <button
                      onClick={clearImportList}
                      className="p-1 rounded text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>

                  {/* 目标笔记本选择 */}
                  <div className="mb-3">
                    <label className="text-xs text-gray-500 dark:text-zinc-400 mb-1 block">导入到笔记本：</label>
                    <select
                      value={selectedNotebookId}
                      onChange={(e) => setSelectedNotebookId(e.target.value)}
                      className="w-full text-sm rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-700 dark:text-zinc-300 px-3 py-1.5 outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500"
                    >
                      <option value="">自动创建「导入的笔记」</option>
                      {state.notebooks.map((nb) => (
                        <option key={nb.id} value={nb.id}>
                          {nb.icon} {nb.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg border border-gray-200 dark:border-zinc-800 p-2">
                    {importFiles.map((file, idx) => (
                      <label
                        key={idx}
                        className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                          file.selected
                            ? "bg-indigo-50/50 dark:bg-indigo-500/5"
                            : "hover:bg-gray-50 dark:hover:bg-zinc-800/50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={file.selected}
                          onChange={() => toggleFileSelection(idx)}
                          className="w-3.5 h-3.5 rounded border-gray-300 dark:border-zinc-600 text-indigo-500 focus:ring-indigo-500/30"
                        />
                        <FileText size={14} className="text-gray-400 dark:text-zinc-500 flex-shrink-0" />
                        <span className="text-sm text-gray-700 dark:text-zinc-300 truncate flex-1">
                          {file.title}
                        </span>
                        <span className="text-xs text-gray-400 dark:text-zinc-600 flex-shrink-0">
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
                      <span className="text-sm text-gray-600 dark:text-zinc-400">
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
                        ? "bg-gray-100 dark:bg-zinc-800 text-gray-400 dark:text-zinc-600 cursor-not-allowed"
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
        </div>
      </motion.div>
    </motion.div>
  );
}
