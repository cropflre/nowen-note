import React, { useState, useEffect, useCallback, useRef } from "react";
import { X, Upload, FolderOpen, Plus, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ui/confirm";

interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  fileCount: number;
}

interface PendingFile {
  file: File;
  id: string;
}

export default function FileUploadDialog({
  open,
  onClose,
  onUploaded,
  defaultFolderId,
}: {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
  defaultFolderId?: string | null;
}) {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(defaultFolderId ?? null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 加载文件夹列表
  const loadFolders = useCallback(async () => {
    try {
      const res = await api.attachmentFolders.list();
      setFolders(res.folders);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (open) {
      loadFolders();
      setSelectedFolderId(defaultFolderId ?? null);
      setPendingFiles([]);
    }
  }, [open, defaultFolderId, loadFolders]);

  // 选择文件
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newFiles: PendingFile[] = Array.from(files).map((f) => ({
      file: f,
      id: `${f.name}-${f.size}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }));
    setPendingFiles((prev) => [...prev, ...newFiles]);
    // 清空 input 以便重复选择同名文件
    e.target.value = "";
  }, []);

  // 移除待上传文件
  const removeFile = useCallback((id: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  // 新建文件夹
  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setCreatingFolder(true);
    try {
      const res = await api.attachmentFolders.create(name);
      setFolders((prev) => [...prev, { ...res, parentId: null }]);
      setSelectedFolderId(res.id);
      setNewFolderName("");
      toast.success(t("fileManager.folderCreated") || "文件夹已创建");
    } catch (e: any) {
      toast.error(e?.message || "创建失败");
    } finally {
      setCreatingFolder(false);
    }
  }, [newFolderName, t]);

  // 上传
  const handleUpload = useCallback(async () => {
    if (pendingFiles.length === 0) return;
    setUploading(true);
    let ok = 0;
    let fail = 0;
    for (const pf of pendingFiles) {
      try {
        await api.files.upload(pf.file, { folderId: selectedFolderId || undefined });
        ok++;
      } catch (e: any) {
        fail++;
        console.warn("[FileUploadDialog] upload failed:", pf.file.name, e);
      }
    }
    setUploading(false);
    if (ok > 0) {
      toast.success(`上传成功 ${ok} 个文件${fail > 0 ? `，${fail} 个失败` : ""}`);
      onUploaded();
      onClose();
    } else {
      toast.error("上传失败");
    }
  }, [pendingFiles, selectedFolderId, onUploaded, onClose]);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-app-elevated rounded-xl shadow-2xl border border-app-border overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <div className="flex items-center gap-2">
            <Upload size={16} className="text-accent-primary" />
            <span className="text-sm font-semibold text-tx-primary">{t("fileManager.uploadFiles") || "上传文件"}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-app-hover text-tx-tertiary">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* 目标文件夹 */}
          <div>
            <label className="block text-xs text-tx-tertiary mb-1.5">{t("fileManager.targetFolder") || "目标位置"}</label>
            <div className="flex items-center gap-2">
              <select
                value={selectedFolderId || ""}
                onChange={(e) => setSelectedFolderId(e.target.value || null)}
                className="flex-1 text-sm rounded-lg border border-app-border bg-app-bg text-tx-primary px-3 py-1.5 outline-none focus:ring-2 focus:ring-accent-primary/30"
              >
                <option value="">{t("fileManager.unarchived") || "未归档文件"}</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>{f.name} ({f.fileCount})</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setCreatingFolder(true)}
                className="p-1.5 rounded-md hover:bg-app-hover text-tx-tertiary hover:text-accent-primary transition-colors"
                title={t("fileManager.newFolder") || "新建文件夹"}
              >
                <Plus size={16} />
              </button>
            </div>
            {/* 新建文件夹输入 */}
            {creatingFolder && (
              <div className="flex items-center gap-2 mt-2">
                <input
                  autoFocus
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder(); if (e.key === "Escape") { setCreatingFolder(false); setNewFolderName(""); } }}
                  placeholder={t("fileManager.folderName") || "文件夹名称"}
                  className="flex-1 text-sm rounded-lg border border-app-border bg-app-bg text-tx-primary px-3 py-1.5 outline-none focus:ring-2 focus:ring-accent-primary/30"
                />
                <button
                  onClick={handleCreateFolder}
                  disabled={!newFolderName.trim()}
                  className="px-3 py-1.5 text-xs rounded-md bg-accent-primary text-white hover:opacity-90 disabled:opacity-50"
                >
                  {t("common.confirm") || "确定"}
                </button>
                <button
                  onClick={() => { setCreatingFolder(false); setNewFolderName(""); }}
                  className="px-3 py-1.5 text-xs rounded-md text-tx-secondary hover:bg-app-hover"
                >
                  {t("common.cancel") || "取消"}
                </button>
              </div>
            )}
          </div>

          {/* 选择文件 */}
          <div>
            <label className="block text-xs text-tx-tertiary mb-1.5">{t("fileManager.selectFiles") || "选择文件"}</label>
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-app-border rounded-lg p-6 text-center cursor-pointer hover:border-accent-primary/50 hover:bg-accent-primary/5 transition-colors"
            >
              <Upload size={24} className="mx-auto mb-2 text-tx-tertiary" />
              <p className="text-sm text-tx-secondary">{t("fileManager.dragOrClick") || "点击选择文件"}</p>
              <p className="text-xs text-tx-tertiary mt-1">{t("fileManager.supportMultiFiles") || "支持多文件"}</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>

          {/* 已选择文件列表 */}
          {pendingFiles.length > 0 && (
            <div className="space-y-1 max-h-40 overflow-y-auto rounded-lg border border-app-border p-2">
              {pendingFiles.map((pf) => (
                <div key={pf.id} className="flex items-center gap-2 text-xs py-1 px-2 rounded hover:bg-app-hover group">
                  <FolderOpen size={12} className="text-tx-tertiary shrink-0" />
                  <span className="truncate flex-1 text-tx-secondary">{pf.file.name}</span>
                  <span className="text-tx-tertiary shrink-0">{formatSize(pf.file.size)}</span>
                  <button
                    onClick={() => removeFile(pf.id)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-500/10 text-tx-tertiary hover:text-red-500 transition-all"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-app-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg text-tx-secondary hover:bg-app-hover transition-colors"
          >
            {t("common.cancel") || "取消"}
          </button>
          <button
            onClick={handleUpload}
            disabled={pendingFiles.length === 0 || uploading}
            className="px-4 py-2 text-sm rounded-lg bg-accent-primary text-white hover:opacity-90 disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {uploading ? (t("fileManager.uploading") || "上传中...") : `${t("fileManager.upload") || "上传"}${pendingFiles.length > 0 ? ` (${pendingFiles.length})` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
