import React, { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { FileUp, Upload, Loader2, CheckCircle, AlertCircle, X, Sparkles, BookOpen, Inbox } from "lucide-react";
import { importMemos, ImportProgress } from "@/lib/importService";
import { toast } from "@/lib/toast";

export interface MemosImportProps {
  workspaceId?: string;
  onImportComplete?: () => void;
}

export function MemosImport({ workspaceId, onImportComplete }: MemosImportProps) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [targetType, setTargetType] = useState<"diaries" | "notes">("diaries");
  const [isDragOver, setIsDragOver] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      const selectedFile = droppedFiles[0];
      const lower = selectedFile.name.toLowerCase();
      if (lower.endsWith(".json") || lower.endsWith(".zip")) {
        setFile(selectedFile);
        setProgress(null);
      } else {
        toast.error("只支持 Memos 导出的 .json 或 .zip 备份文件");
      }
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length > 0) {
      const selectedFile = selectedFiles[0];
      const lower = selectedFile.name.toLowerCase();
      if (lower.endsWith(".json") || lower.endsWith(".zip")) {
        setFile(selectedFile);
        setProgress(null);
      } else {
        toast.error("只支持 Memos 导出的 .json 或 .zip 备份文件");
      }
    }
    e.target.value = "";
  };

  const handleStartImport = async () => {
    if (!file) return;
    try {
      const res = await importMemos(
        file,
        targetType,
        (p) => setProgress(p),
        { workspaceId }
      );
      if (res.success) {
        toast.success(targetType === "diaries" ? `成功导入了 ${res.count} 条说说！` : `成功导入了 ${res.count} 条笔记！`);
        onImportComplete?.();
      }
    } catch (err: any) {
      setProgress({ phase: "error", current: 0, total: 0, message: err?.message || "导入失败" });
      toast.error(err?.message || "导入发生错误");
    }
  };

  const handleCancel = () => {
    setFile(null);
    setProgress(null);
  };

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4 mt-6">
      <div className="flex items-center gap-2 mb-3">
        <Inbox size={18} className="text-violet-500" />
        <h5 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Memos 0.18.0 数据导入
        </h5>
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4 leading-relaxed">
        支持从 Memos 导出的 <code className="px-1 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200">.json</code> 数据文件或包含资源附件的 <code className="px-1 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200">.zip</code> 备份文件。
      </p>

      {!file ? (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer ${
            isDragOver
              ? "border-violet-400 bg-violet-50/50 dark:bg-violet-500/5 dark:border-violet-500"
              : "border-zinc-300 dark:border-zinc-700 hover:border-violet-300 dark:hover:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.zip"
            onChange={handleFileSelect}
            className="hidden"
          />
          <Upload size={32} className={`mx-auto mb-3 ${isDragOver ? "text-violet-500" : "text-zinc-400 dark:text-zinc-500"}`} />
          <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
            将 Memos 备份文件拖到此处，或点击上传
          </p>
          <p className="text-xs text-zinc-400 dark:text-zinc-600 mt-1">
            支持 .json 或 .zip 格式
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-4">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-zinc-100 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <FileUp className="text-violet-500 shrink-0" size={16} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate max-w-[240px] sm:max-w-[400px]">
                  {file.name}
                </p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
            </div>
            {!progress && (
              <button
                onClick={handleCancel}
                className="p-1 rounded text-zinc-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                <X size={16} />
              </button>
            )}
          </div>

          {!progress ? (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-2 block">
                  导入目标类型
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setTargetType("diaries")}
                    className={`flex flex-col items-center p-3 rounded-xl border text-center transition-all ${
                      targetType === "diaries"
                        ? "border-violet-500 bg-violet-50/20 dark:bg-violet-500/5 text-violet-600 dark:text-violet-400 ring-2 ring-violet-500/20"
                        : "border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/30"
                    }`}
                  >
                    <Sparkles size={20} className="mb-1.5" />
                    <span className="text-xs font-semibold">导入为说说 (推荐)</span>
                    <span className="text-[10px] text-zinc-400 mt-1 leading-normal">
                      保留说说时间轴、图片附件与可见性控制，最贴近 Memos 体验
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setTargetType("notes")}
                    className={`flex flex-col items-center p-3 rounded-xl border text-center transition-all ${
                      targetType === "notes"
                        ? "border-violet-500 bg-violet-50/20 dark:bg-violet-500/5 text-violet-600 dark:text-violet-400 ring-2 ring-violet-500/20"
                        : "border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/30"
                    }`}
                  >
                    <BookOpen size={20} className="mb-1.5" />
                    <span className="text-xs font-semibold">导入为笔记</span>
                    <span className="text-[10px] text-zinc-400 mt-1 leading-normal">
                      自动创建 "Memos" 笔记本，转换为 Markdown 富文本笔记
                    </span>
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleCancel}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleStartImport}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-violet-600 hover:bg-violet-500 dark:bg-violet-500 dark:hover:bg-violet-400 active:scale-[0.98] transition-all shadow-sm shadow-violet-600/10"
                >
                  开始导入
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 py-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  {progress.phase === "reading" && "正在解析文件"}
                  {progress.phase === "uploading" && "正在导入中..."}
                  {progress.phase === "done" && "导入完成"}
                  {progress.phase === "error" && "导入失败"}
                </span>
                <span className="text-zinc-400 tabular-nums">
                  {progress.phase === "uploading" && `${progress.current} / ${progress.total}`}
                  {progress.phase === "done" && `共导入 ${progress.current} 条`}
                </span>
              </div>

              <div className="w-full h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    progress.phase === "error"
                      ? "bg-red-500"
                      : progress.phase === "done"
                      ? "bg-emerald-500"
                      : "bg-violet-500"
                  }`}
                  style={{
                    width:
                      progress.phase === "done"
                        ? "100%"
                        : progress.phase === "reading"
                        ? "10%"
                        : `${(progress.current / progress.total) * 100}%`,
                  }}
                />
              </div>

              <div className="flex items-center gap-1.5 text-xs">
                {progress.phase === "uploading" || progress.phase === "reading" ? (
                  <Loader2 size={13} className="animate-spin text-violet-500 shrink-0" />
                ) : progress.phase === "done" ? (
                  <CheckCircle size={13} className="text-emerald-500 shrink-0" />
                ) : (
                  <AlertCircle size={13} className="text-red-500 shrink-0" />
                )}
                <span
                  className={`truncate shrink-0 max-w-[90%] ${
                    progress.phase === "error"
                      ? "text-red-500"
                      : progress.phase === "done"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-zinc-500 dark:text-zinc-400"
                  }`}
                >
                  {progress.message}
                </span>
              </div>

              {(progress.phase === "done" || progress.phase === "error") && (
                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                  >
                    确定并返回
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
