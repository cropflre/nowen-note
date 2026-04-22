import React, { useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Download, Upload, CheckCircle, Loader2, FileText,
  AlertCircle, Trash2, FileUp, FolderDown, AlertTriangle
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { exportAllNotes, ExportProgress } from "@/lib/exportService";
import {
  readMarkdownFiles, readMarkdownFromZip, importNotes,
  ImportFileInfo, ImportProgress
} from "@/lib/importService";
import { useApp, useAppActions } from "@/store/AppContext";
import { api, withSudo } from "@/lib/api";
import MiCloudImport from "@/components/MiCloudImport";
import OppoCloudImport from "@/components/OppoCloudImport";
import ICloudImport from "@/components/iCloudImport";

export default function DataManager() {
  const { t } = useTranslation();
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
  // 新增：是否"为每个文件创建以文件名命名的外层笔记本"
  const [perFileNotebook, setPerFileNotebook] = useState(false);
  // 新增：同名笔记本处理策略 - "merge" 合并 / "unique" 自动编号
  const [duplicateStrategy, setDuplicateStrategy] = useState<"merge" | "unique">("merge");
  // 当前导入批次是否包含 zip（zip 本身按目录派生笔记本，不需要 perFile 开关）
  const [hasZip, setHasZip] = useState(false);
  // 导出时是否把图片内嵌为 base64（默认 false：外置到 assets/ 目录，体积小、可读性好）
  const [exportInlineImages, setExportInlineImages] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 全量导出
  const handleExportAll = async () => {
    setIsExporting(true);
    setExportProgress(null);
    await exportAllNotes((p) => setExportProgress(p), { inlineImages: exportInlineImages });
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
      setHasZip(true);
      // zip 由其内部目录/zip 文件名派生笔记本，关闭 per-file
      setPerFileNotebook(false);
    } else {
      result = await readMarkdownFiles(files);
      setHasZip(false);
      // 散文件默认开启 per-file：以文件名作为笔记本名，而非统一落到"导入的笔记"
      setPerFileNotebook(true);
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
    // perFileNotebook 与 selectedNotebookId 互斥：只要选了具体笔记本，就不启用 per-file
    const usePerFile = !selectedNotebookId && perFileNotebook;
    const result = await importNotes(
      importFiles,
      selectedNotebookId || undefined,
      (p) => setImportProgress(p),
      {
        perFileNotebook: usePerFile,
        duplicateStrategy,
      }
    );
    setIsImporting(false);

    if (result.success) {
      api.getNotebooks().then(actions.setNotebooks).catch(console.error);
      setTimeout(() => {
        setImportFiles([]);
        setImportProgress(null);
        setHasZip(false);
      }, 3000);
    }
  };

  const clearImportList = () => {
    setImportFiles([]);
    setImportProgress(null);
    setHasZip(false);
  };

  const selectedCount = importFiles.filter((f) => f.selected).length;

  // Danger Zone state
  const [showResetModal, setShowResetModal] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [isResetting, setIsResetting] = useState(false);
  const [resetError, setResetError] = useState("");
  const [shake, setShake] = useState(false);
  // H2: factory-reset 需要 sudo 二次验证，复用同一个弹窗让管理员输入当前密码
  const [sudoPwd, setSudoPwd] = useState("");

  const handleFactoryReset = async () => {
    if (confirmText !== "RESET") {
      setResetError(t('dataManager.incorrectVerification'));
      setShake(true);
      setTimeout(() => setShake(false), 400);
      return;
    }
    if (!sudoPwd) {
      setResetError(t('dataManager.sudoPasswordRequired'));
      setShake(true);
      setTimeout(() => setShake(false), 400);
      return;
    }

    setIsResetting(true);
    setResetError("");

    try {
      // 先用当前密码换 sudo token；失败会抛出（密码错 / 429）
      const out = await withSudo(
        (tk) => api.factoryReset(confirmText, tk),
        () => sudoPwd,
      );
      if (!out) {
        setIsResetting(false);
        return;
      }
      localStorage.clear();
      sessionStorage.clear();
      window.location.reload();
    } catch (err: any) {
      setResetError(err.message || t('dataManager.resetFailed'));
      setIsResetting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">{t('dataManager.title')}</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
          {t('dataManager.description')}
        </p>
      </div>

      {/* ===== 导出区域 ===== */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <FolderDown size={18} className="text-indigo-500" />
          <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{t('dataManager.exportBackup')}</h4>
        </div>

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
            {t('dataManager.exportDescription')}
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

          {/* 导出选项：图片处理策略 */}
          <label className="flex items-start gap-2 mb-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={exportInlineImages}
              onChange={(e) => setExportInlineImages(e.target.checked)}
              disabled={isExporting}
              className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer"
            />
            <span className="text-sm">
              <span className="text-zinc-700 dark:text-zinc-300">
                {t('dataManager.exportInlineImages')}
              </span>
              <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                {t('dataManager.exportInlineImagesHint')}
              </span>
            </span>
          </label>

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
                {t('dataManager.exporting')}
              </>
            ) : exportProgress?.phase === "done" ? (
              <>
                <CheckCircle className="w-4 h-4 mr-2" />
                {t('dataManager.exportSuccess')}
              </>
            ) : (
              <>
                <Download className="w-4 h-4 mr-2" />
                {t('dataManager.exportAsZip')}
              </>
            )}
          </button>
        </div>
      </section>

      {/* ===== 导入区域 ===== */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <FileUp size={18} className="text-emerald-500" />
          <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{t('dataManager.importNotes')}</h4>
        </div>

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
            {t('dataManager.importDescription')}
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
                accept=".md,.txt,.markdown,.html,.htm,.zip,.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp"
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
                {t('dataManager.dropFilesHere')}
              </p>
              <p className="text-xs text-zinc-400 dark:text-zinc-600 mt-1">
                {t('dataManager.supportedFiles')}
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
                    {importFiles.every((f) => f.selected) ? t('dataManager.deselectAll') : t('dataManager.selectAll')}
                  </button>
                  <span className="text-xs text-zinc-400 dark:text-zinc-600">
                    {t('dataManager.selectedCount', { selected: selectedCount, total: importFiles.length })}
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
                <label className="text-xs text-zinc-500 dark:text-zinc-400 mb-1 block">{t('dataManager.importToNotebook')}</label>
                <select
                  value={selectedNotebookId}
                  onChange={(e) => setSelectedNotebookId(e.target.value)}
                  className="w-full text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-3 py-1.5 outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500"
                >
                  <option value="">{t('dataManager.autoCreateNotebook')}</option>
                  {state.notebooks.map((nb) => (
                    <option key={nb.id} value={nb.id}>
                      {nb.icon} {nb.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* 按文件名建笔记本 —— 仅对散文件生效 */}
              {!hasZip && (
                <div className="mb-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/40 p-3">
                  <label
                    className={`flex items-start gap-2.5 cursor-pointer ${
                      selectedNotebookId ? "opacity-50 cursor-not-allowed" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={perFileNotebook && !selectedNotebookId}
                      disabled={!!selectedNotebookId}
                      onChange={(e) => setPerFileNotebook(e.target.checked)}
                      className="mt-0.5 w-3.5 h-3.5 rounded border-zinc-300 dark:border-zinc-600 text-indigo-500 focus:ring-indigo-500/30"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-zinc-700 dark:text-zinc-300 font-medium">
                        {t('dataManager.perFileNotebook')}
                      </div>
                      <div className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
                        {t('dataManager.perFileNotebookHint')}
                      </div>
                    </div>
                  </label>

                  {/* 同名处理策略 —— 只有启用 perFile 时才显示 */}
                  {perFileNotebook && !selectedNotebookId && (
                    <div className="mt-2.5 pl-6 flex flex-col gap-1.5">
                      <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
                        <input
                          type="radio"
                          name="dup-strategy"
                          value="merge"
                          checked={duplicateStrategy === "merge"}
                          onChange={() => setDuplicateStrategy("merge")}
                          className="w-3.5 h-3.5 text-indigo-500 focus:ring-indigo-500/30"
                        />
                        {t('dataManager.duplicateMerge')}
                      </label>
                      <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
                        <input
                          type="radio"
                          name="dup-strategy"
                          value="unique"
                          checked={duplicateStrategy === "unique"}
                          onChange={() => setDuplicateStrategy("unique")}
                          className="w-3.5 h-3.5 text-indigo-500 focus:ring-indigo-500/30"
                        />
                        {t('dataManager.duplicateUnique')}
                      </label>
                    </div>
                  )}
                </div>
              )}

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
                    {t('dataManager.importing')}
                  </>
                ) : importProgress?.phase === "done" ? (
                  <>
                    <CheckCircle className="w-4 h-4 mr-2" />
                    {t('dataManager.importSuccess')}
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    {t('dataManager.importButton', { count: selectedCount })}
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ===== 小米云服务导入 ===== */}
      <MiCloudImport />

      {/* ===== OPPO 云便签导入 ===== */}
      <OppoCloudImport />

      {/* ===== iPhone 备忘录导入 ===== */}
      <ICloudImport />

      {/* ===== 危险区域 (Danger Zone) ===== */}
      <section className="mt-8 pt-6 border-t-2 border-dashed border-red-300/50 dark:border-red-900/40">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle size={18} className="text-red-500" />
          <h4 className="text-base font-bold text-red-600 dark:text-red-500">{t('dataManager.dangerZone')}</h4>
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          {t('dataManager.dangerDescription')}
        </p>

        <button
          onClick={() => { setShowResetModal(true); setConfirmText(""); setResetError(""); setSudoPwd(""); }}
          className="px-4 py-2 border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 font-medium rounded-lg transition-colors text-sm"
        >
          {t('dataManager.factoryReset')}
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
                    {t('dataManager.resetConfirmTitle')}
                  </h4>
                </div>

                <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-1">
                  {t('dataManager.resetConfirmDesc')}
                </p>
                <ul className="text-sm text-zinc-500 dark:text-zinc-400 mb-4 list-disc list-inside space-y-0.5">
                  <li>{t('dataManager.resetItem1')}</li>
                  <li>{t('dataManager.resetItem2')}</li>
                  <li>{t('dataManager.resetItem3')}</li>
                </ul>

                <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3">
                  {t('dataManager.resetInputHint')}
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
                    placeholder={t('dataManager.resetInputPlaceholder')}
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

                {/* H2: 二次密码验证（sudo） */}
                <div className="mt-4">
                  <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">
                    {t('dataManager.sudoPasswordLabel')}
                  </label>
                  <input
                    type="password"
                    value={sudoPwd}
                    onChange={(e) => {
                      setSudoPwd(e.target.value);
                      setResetError("");
                    }}
                    placeholder={t('dataManager.sudoPasswordPlaceholder')}
                    autoComplete="current-password"
                    className="w-full px-3 py-2 border rounded-lg bg-transparent text-zinc-900 dark:text-zinc-100 outline-none text-sm transition-colors border-zinc-300 dark:border-zinc-700 focus:ring-2 focus:ring-red-500/30 focus:border-red-500"
                  />
                  <p className="text-[11px] text-zinc-400 mt-1">
                    {t('dataManager.sudoPasswordHint')}
                  </p>
                </div>

                <div className="flex justify-end gap-3 mt-5">
                  <button
                    onClick={() => { setShowResetModal(false); setSudoPwd(""); }}
                    disabled={isResetting}
                    className="px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={handleFactoryReset}
                    disabled={isResetting || confirmText !== "RESET" || !sudoPwd}
                    className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg flex items-center transition-colors"
                  >
                    {isResetting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                    {t('dataManager.confirmDestroy')}
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
