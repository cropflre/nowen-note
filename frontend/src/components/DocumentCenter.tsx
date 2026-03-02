import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  FileText, Table, Presentation, Plus, Trash2, Edit2,
  Loader2, Check, Upload, Download, Search, X, ChevronDown,
  MoreHorizontal, CheckSquare, Square, ArrowLeft, AlertCircle,
  FileUp, RefreshCw, Menu
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { DocumentListItem, DocType } from "@/types";
import { cn } from "@/lib/utils";
import { useAppActions } from "@/store/AppContext";
import { useSiteSettings } from "@/hooks/useSiteSettings";

// 文档类型图标和颜色映射
const DOC_TYPE_CONFIG: Record<DocType, { icon: typeof FileText; color: string; label: string; labelEn: string }> = {
  word: { icon: FileText, color: "text-blue-500", label: "Word 文档", labelEn: "Word Document" },
  cell: { icon: Table, color: "text-green-500", label: "Excel 表格", labelEn: "Excel Spreadsheet" },
  slide: { icon: Presentation, color: "text-orange-500", label: "PPT 演示", labelEn: "PPT Presentation" },
};

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr + "Z");
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return date.toLocaleDateString();
}

// ========== ONLYOFFICE 编辑器组件 ==========
function OnlyOfficeEditor({
  documentId,
  onBack,
  title,
}: {
  documentId: string;
  onBack: () => void;
  title: string;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let destroyed = false;

    async function initEditor() {
      try {
        const { editorConfig, onlyofficeUrl } = await api.getDocumentEditorConfig(documentId);

        if (destroyed) return;

        // 动态加载 ONLYOFFICE API 脚本
        const apiUrl = `${onlyofficeUrl}/web-apps/apps/api/documents/api.js`;

        // 检查是否已加载
        if (!(window as any).DocsAPI) {
          await new Promise<void>((resolve, reject) => {
            // 移除旧的脚本
            const oldScript = document.getElementById("onlyoffice-api-script");
            if (oldScript) oldScript.remove();

            const script = document.createElement("script");
            script.id = "onlyoffice-api-script";
            script.src = apiUrl;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(t("documents.onlyofficeLoadFailed")));
            document.head.appendChild(script);
          });
        }

        if (destroyed) return;

        // 销毁旧编辑器
        if (editorRef.current) {
          try { editorRef.current.destroyEditor(); } catch {}
          editorRef.current = null;
        }

        // 创建编辑器
        editorRef.current = new (window as any).DocsAPI.DocEditor("onlyoffice-editor-container", {
          ...editorConfig,
          width: "100%",
          height: "100%",
          events: {
            onReady: () => {
              if (!destroyed) setLoading(false);
            },
            onError: (event: any) => {
              console.error("ONLYOFFICE error:", event);
              if (!destroyed) setError(t("documents.editorError"));
            },
          },
        });
      } catch (err: any) {
        if (!destroyed) {
          setError(err.message || t("documents.editorError"));
          setLoading(false);
        }
      }
    }

    initEditor();

    return () => {
      destroyed = true;
      if (editorRef.current) {
        try { editorRef.current.destroyEditor(); } catch {}
        editorRef.current = null;
      }
    };
  }, [documentId]);

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-app-border bg-app-surface/50 shrink-0">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md text-tx-secondary hover:text-tx-primary hover:bg-app-hover transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
        <span className="text-sm font-medium text-tx-primary truncate">{title}</span>
      </div>

      {/* 编辑器容器 */}
      <div className="flex-1 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-app-bg z-10">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-accent-primary" />
              <p className="text-sm text-tx-secondary">{t("documents.loadingEditor")}</p>
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-app-bg z-10">
            <div className="flex flex-col items-center gap-3 max-w-md text-center px-4">
              <AlertCircle className="w-10 h-10 text-red-500" />
              <p className="text-sm text-tx-primary font-medium">{t("documents.editorError")}</p>
              <p className="text-xs text-tx-secondary">{error}</p>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={onBack}
                  className="px-4 py-2 text-sm bg-app-hover text-tx-primary rounded-lg hover:bg-app-border transition-colors"
                >
                  {t("documents.backToList")}
                </button>
                <button
                  onClick={() => { setError(null); setLoading(true); }}
                  className="px-4 py-2 text-sm bg-accent-primary text-white rounded-lg hover:bg-accent-hover transition-colors"
                >
                  {t("documents.retry")}
                </button>
              </div>
            </div>
          </div>
        )}
        <div
          id="onlyoffice-editor-container"
          ref={containerRef}
          className="w-full h-full"
        />
      </div>
    </div>
  );
}

// ========== 文档中心主组件 ==========
export default function DocumentCenter() {
  const { t } = useTranslation();
  const actions = useAppActions();
  const { siteConfig } = useSiteSettings();
  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [editingDocId, setEditingDocId] = useState<string | null>(null);
  const [editingDocTitle, setEditingDocTitle] = useState("");
  const [onlyofficeAvailable, setOnlyofficeAvailable] = useState<boolean | null>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 加载文档列表
  const loadDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const docs = await api.getDocuments(filter);
      setDocuments(docs);
    } catch (err) {
      console.error("Failed to load documents:", err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { loadDocuments(); }, [loadDocuments]);

  // 检查 ONLYOFFICE 可用性
  useEffect(() => {
    api.getOnlyOfficeStatus()
      .then((res) => setOnlyofficeAvailable(res.available))
      .catch(() => setOnlyofficeAvailable(false));
  }, []);

  // 点击外部关闭创建菜单
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) {
        setShowCreateMenu(false);
      }
    }
    if (showCreateMenu) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showCreateMenu]);

  // 聚焦重命名输入框
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  // 搜索过滤
  const filteredDocs = searchQuery.trim()
    ? documents.filter((d) => d.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : documents;

  // 创建文档
  const handleCreate = async (docType: DocType) => {
    setShowCreateMenu(false);
    try {
      const doc = await api.createDocument({ docType });
      setDocuments((prev) => [doc as any, ...prev]);
      // 如果 ONLYOFFICE 可用，直接打开编辑
      if (onlyofficeAvailable) {
        setEditingDocId(doc.id);
        setEditingDocTitle(doc.title);
      }
    } catch (err: any) {
      console.error("Create failed:", err);
    }
  };

  // 上传文档
  const handleUpload = async (files: FileList) => {
    for (const file of Array.from(files)) {
      try {
        const doc = await api.uploadDocument(file);
        setDocuments((prev) => [doc as any, ...prev]);
      } catch (err: any) {
        console.error("Upload failed:", err);
      }
    }
  };

  // 重命名
  const handleRename = async () => {
    if (!editingId || !editTitle.trim()) {
      setEditingId(null);
      return;
    }
    try {
      await api.updateDocument(editingId, { title: editTitle.trim() });
      setDocuments((prev) =>
        prev.map((d) => (d.id === editingId ? { ...d, title: editTitle.trim() } : d))
      );
      // 如果正在编辑这个文档，同步标题
      if (editingDocId === editingId) {
        setEditingDocTitle(editTitle.trim());
      }
    } catch (err) {
      console.error("Rename failed:", err);
    }
    setEditingId(null);
  };

  // 删除
  const handleDelete = async (id: string) => {
    try {
      await api.deleteDocument(id);
      setDocuments((prev) => prev.filter((d) => d.id !== id));
      if (editingDocId === id) {
        setEditingDocId(null);
      }
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  // 批量删除
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    try {
      await api.batchDeleteDocuments(Array.from(selectedIds));
      setDocuments((prev) => prev.filter((d) => !selectedIds.has(d.id)));
      setSelectedIds(new Set());
      setBatchMode(false);
    } catch (err) {
      console.error("Batch delete failed:", err);
    }
  };

  // 选择/取消选择
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === filteredDocs.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredDocs.map((d) => d.id)));
    }
  };

  // 如果正在编辑文档，显示 ONLYOFFICE 编辑器
  if (editingDocId) {
    return (
      <OnlyOfficeEditor
        documentId={editingDocId}
        title={editingDocTitle}
        onBack={() => {
          setEditingDocId(null);
          loadDocuments(); // 刷新列表（可能已保存）
        }}
      />
    );
  }

  // 文档列表视图
  return (
    <div className="flex-1 flex flex-col h-full bg-app-bg">
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border bg-app-surface/50 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => actions.setMobileSidebar(true)}
            className="p-1.5 -ml-1.5 rounded-md text-tx-secondary hover:bg-app-hover md:hidden"
          >
            <Menu size={22} />
          </button>
          <h2 className="text-base font-semibold text-tx-primary">{t("documents.title")}</h2>
          <span className="text-xs text-tx-tertiary">
            {t("documents.totalCount", { count: documents.length })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {batchMode ? (
            <>
              <button
                onClick={selectAll}
                className="px-3 py-1.5 text-xs text-tx-secondary hover:text-tx-primary hover:bg-app-hover rounded-md transition-colors"
              >
                {selectedIds.size === filteredDocs.length ? t("documents.deselectAll") : t("documents.selectAll")}
              </button>
              <button
                onClick={handleBatchDelete}
                disabled={selectedIds.size === 0}
                className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-40 rounded-md transition-colors"
              >
                {t("documents.deleteSelected", { count: selectedIds.size })}
              </button>
              <button
                onClick={() => { setBatchMode(false); setSelectedIds(new Set()); }}
                className="px-3 py-1.5 text-xs text-tx-secondary hover:text-tx-primary hover:bg-app-hover rounded-md transition-colors"
              >
                {t("common.cancel")}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-2 rounded-md text-tx-secondary hover:text-tx-primary hover:bg-app-hover transition-colors"
                title={t("documents.upload")}
              >
                <Upload size={16} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".docx,.doc,.xlsx,.xls,.csv,.pptx,.ppt,.odt,.rtf,.txt"
                className="hidden"
                multiple
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    handleUpload(e.target.files);
                    e.target.value = "";
                  }
                }}
              />
              <div className="relative" ref={createMenuRef}>
                <button
                  onClick={() => setShowCreateMenu(!showCreateMenu)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent-primary hover:bg-accent-hover rounded-md transition-colors"
                >
                  <Plus size={14} />
                  {t("documents.create")}
                </button>
                {showCreateMenu && (
                  <div className="absolute right-0 top-full mt-1 w-48 py-1 bg-white dark:bg-zinc-900 rounded-lg shadow-xl border border-app-border z-50">
                    {(["word", "cell", "slide"] as DocType[]).map((type) => {
                      const config = DOC_TYPE_CONFIG[type];
                      const Icon = config.icon;
                      return (
                        <button
                          key={type}
                          onClick={() => handleCreate(type)}
                          className="w-full flex items-center gap-3 px-3 py-2 text-sm text-tx-secondary hover:text-tx-primary hover:bg-app-hover transition-colors"
                        >
                          <Icon size={16} className={config.color} />
                          {t(`documents.type_${type}`)}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 工具栏：搜索 + 筛选 */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-app-border shrink-0">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-tertiary" size={14} />
          <input
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-app-bg border border-app-border rounded-md outline-none focus:border-accent-primary text-tx-primary placeholder:text-tx-tertiary"
            placeholder={t("documents.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-tx-tertiary hover:text-tx-secondary"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {["all", "word", "cell", "slide"].map((type) => (
            <button
              key={type}
              onClick={() => setFilter(type)}
              className={cn(
                "px-2.5 py-1 text-xs rounded-md transition-colors",
                filter === type
                  ? "bg-accent-primary/10 text-accent-primary font-medium"
                  : "text-tx-secondary hover:text-tx-primary hover:bg-app-hover"
              )}
            >
              {type === "all" ? t("documents.filterAll") : t(`documents.type_${type}`)}
            </button>
          ))}
        </div>
        {!batchMode && documents.length > 0 && (
          <button
            onClick={() => setBatchMode(true)}
            className="px-2.5 py-1 text-xs text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover rounded-md transition-colors"
          >
            {t("documents.batchManage")}
          </button>
        )}
      </div>

      {/* ONLYOFFICE 状态提示 */}
      {onlyofficeAvailable === false && (
        <div className="mx-4 mt-3 flex items-center gap-2 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <AlertCircle size={14} />
          <span>{t("documents.onlyofficeUnavailable")}</span>
        </div>
      )}

      {/* 文档列表 */}
      <div className="flex-1 overflow-auto px-4 py-3">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-tx-tertiary" />
          </div>
        ) : filteredDocs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-tx-tertiary">
            <FileText size={48} className="mb-3 opacity-30" />
            <p className="text-sm">{t("documents.empty")}</p>
            <p className="text-xs mt-1">{t("documents.createFirst")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {filteredDocs.map((doc) => {
              const config = DOC_TYPE_CONFIG[doc.docType];
              const Icon = config.icon;
              const isSelected = selectedIds.has(doc.id);
              const isEditing = editingId === doc.id;

              return (
                <div
                  key={doc.id}
                  className={cn(
                    "group relative flex flex-col p-4 rounded-xl border transition-all cursor-pointer",
                    isSelected
                      ? "border-accent-primary bg-accent-primary/5"
                      : "border-app-border bg-app-surface hover:border-accent-primary/50 hover:shadow-sm"
                  )}
                  onClick={() => {
                    if (batchMode) {
                      toggleSelect(doc.id);
                    } else if (onlyofficeAvailable) {
                      setEditingDocId(doc.id);
                      setEditingDocTitle(doc.title);
                    }
                  }}
                >
                  {/* 批量选择复选框 */}
                  {batchMode && (
                    <div className="absolute top-2 left-2 z-10">
                      {isSelected ? (
                        <CheckSquare size={18} className="text-accent-primary" />
                      ) : (
                        <Square size={18} className="text-tx-tertiary" />
                      )}
                    </div>
                  )}

                  {/* 操作按钮 */}
                  {!batchMode && (
                    <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingId(doc.id);
                          setEditTitle(doc.title);
                        }}
                        className="p-1 rounded text-tx-tertiary hover:text-tx-primary hover:bg-app-hover transition-colors"
                        title={t("common.rename")}
                      >
                        <Edit2 size={13} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          // 下载
                          const a = document.createElement("a");
                          a.href = `/api/documents/${doc.id}/file`;
                          a.download = doc.title;
                          a.click();
                        }}
                        className="p-1 rounded text-tx-tertiary hover:text-tx-primary hover:bg-app-hover transition-colors"
                        title={t("documents.download")}
                      >
                        <Download size={13} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(doc.id);
                        }}
                        className="p-1 rounded text-tx-tertiary hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        title={t("common.delete")}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}

                  {/* 图标 */}
                  <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center mb-3",
                    doc.docType === "word" ? "bg-blue-50 dark:bg-blue-900/20" :
                    doc.docType === "cell" ? "bg-green-50 dark:bg-green-900/20" :
                    "bg-orange-50 dark:bg-orange-900/20"
                  )}>
                    <Icon size={22} className={config.color} />
                  </div>

                  {/* 标题 */}
                  {isEditing ? (
                    <input
                      ref={editInputRef}
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRename();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onBlur={handleRename}
                      onClick={(e) => e.stopPropagation()}
                      className="text-sm font-medium text-tx-primary bg-transparent border border-accent-primary/50 rounded px-1 py-0.5 outline-none mb-1"
                    />
                  ) : (
                    <h3 className="text-sm font-medium text-tx-primary truncate mb-1" title={doc.title}>
                      {doc.title}
                    </h3>
                  )}

                  {/* 元信息 */}
                  <div className="flex items-center gap-2 text-[10px] text-tx-tertiary mt-auto">
                    <span>{t(`documents.type_${doc.docType}`)}</span>
                    <span>·</span>
                    <span>{formatFileSize(doc.fileSize)}</span>
                    <span>·</span>
                    <span>{formatTime(doc.updatedAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
