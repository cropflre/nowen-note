import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  FileText, Table, Plus, Trash2, Edit2,
  Loader2, Check, Upload, Download, Search, X,
  CheckSquare, Square, ArrowLeft, Save,
  FileUp, Menu, Eye, Pencil
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { DocumentListItem, DocType } from "@/types";
import { cn } from "@/lib/utils";
import { useAppActions } from "@/store/AppContext";

// 文档类型图标和颜色映射（移除 slide）
const DOC_TYPE_CONFIG: Record<string, { icon: typeof FileText; color: string; label: string }> = {
  word: { icon: FileText, color: "text-blue-500", label: "Word" },
  cell: { icon: Table, color: "text-green-500", label: "Excel" },
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

// ========== Word 编辑器组件（mammoth 预览 + contenteditable 编辑） ==========
function WordEditor({
  documentId,
  title,
  onBack,
}: {
  documentId: string;
  title: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [htmlContent, setHtmlContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [modified, setModified] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function loadDocument() {
      try {
        setLoading(true);
        const arrayBuffer = await api.getDocumentContent(documentId);
        const mammoth = await import("mammoth");
        const result = await mammoth.convertToHtml({ arrayBuffer });
        setHtmlContent(result.value);
      } catch (err: any) {
        setError(err.message || t("documents.loadFailed"));
      } finally {
        setLoading(false);
      }
    }
    loadDocument();
  }, [documentId]);

  const handleSave = async () => {
    if (!editorRef.current) return;
    setSaving(true);
    try {
      const html = editorRef.current.innerHTML;
      // 将编辑后的 HTML 转为 docx 并保存
      const { Document, Packer, Paragraph, TextRun } = await import("docx");

      // 解析 HTML 为简单段落（保留基本格式）
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = html;
      const paragraphs: any[] = [];

      const processNode = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent || "";
          if (text.trim()) {
            paragraphs.push(new Paragraph({
              children: [new TextRun(text)],
            }));
          }
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as HTMLElement;
        const tag = el.tagName.toLowerCase();

        if (["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li"].includes(tag)) {
          const runs: any[] = [];
          const walkInline = (n: Node) => {
            if (n.nodeType === Node.TEXT_NODE) {
              const t = n.textContent || "";
              if (t) {
                const parent = n.parentElement;
                const bold = parent?.closest("strong,b") !== null;
                const italic = parent?.closest("em,i") !== null;
                const underline = parent?.closest("u") !== null;
                runs.push(new TextRun({ text: t, bold, italics: italic, underline: underline ? {} : undefined }));
              }
            } else if (n.nodeType === Node.ELEMENT_NODE) {
              const childEl = n as HTMLElement;
              const childTag = childEl.tagName.toLowerCase();
              if (["strong", "b", "em", "i", "u", "span", "a", "code"].includes(childTag)) {
                for (const child of Array.from(n.childNodes)) walkInline(child);
              } else {
                for (const child of Array.from(n.childNodes)) walkInline(child);
              }
            }
          };
          for (const child of Array.from(el.childNodes)) walkInline(child);

          if (runs.length === 0) {
            runs.push(new TextRun(""));
          }

          const heading = tag.match(/^h(\d)$/);
          paragraphs.push(new Paragraph({
            children: runs,
            heading: heading ? (`Heading${heading[1]}` as any) : undefined,
          }));
        } else if (["ul", "ol", "table", "thead", "tbody", "tr"].includes(tag)) {
          for (const child of Array.from(el.childNodes)) processNode(child);
        } else {
          // 其他块级元素也递归处理
          for (const child of Array.from(el.childNodes)) processNode(child);
        }
      };

      for (const child of Array.from(tempDiv.childNodes)) processNode(child);

      if (paragraphs.length === 0) {
        paragraphs.push(new Paragraph({ children: [new TextRun("")] }));
      }

      const doc = new Document({
        sections: [{ children: paragraphs }],
      });

      const blob = await Packer.toBlob(doc);
      await api.saveDocumentContent(documentId, blob);
      setModified(false);
    } catch (err: any) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-app-bg">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-accent-primary" />
          <p className="text-sm text-tx-secondary">{t("documents.loadingDocument")}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-app-bg">
        <div className="flex flex-col items-center gap-3 text-center px-4">
          <p className="text-sm text-red-500">{error}</p>
          <button onClick={onBack} className="px-4 py-2 text-sm bg-app-hover text-tx-primary rounded-lg">
            {t("documents.backToList")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-app-border bg-app-surface/50 shrink-0">
        <button onClick={onBack} className="p-1.5 rounded-md text-tx-secondary hover:text-tx-primary hover:bg-app-hover transition-colors">
          <ArrowLeft size={18} />
        </button>
        <span className="text-sm font-medium text-tx-primary truncate flex-1">{title}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setEditMode(!editMode)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors",
              editMode ? "bg-accent-primary/10 text-accent-primary font-medium" : "text-tx-secondary hover:text-tx-primary hover:bg-app-hover"
            )}
          >
            {editMode ? <Pencil size={14} /> : <Eye size={14} />}
            {editMode ? t("documents.editing") : t("documents.preview")}
          </button>
          {editMode && modified && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent-primary hover:bg-accent-hover disabled:opacity-50 rounded-md transition-colors"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? t("common.saving") : t("common.save")}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-white dark:bg-zinc-900">
        <div className="max-w-4xl mx-auto px-8 py-6">
          {editMode ? (
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              className="prose prose-sm dark:prose-invert max-w-none min-h-[60vh] outline-none
                prose-p:my-2 prose-headings:my-3
                prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
                prose-table:border-collapse prose-th:border prose-th:border-gray-300 prose-th:px-3 prose-th:py-2 prose-th:bg-gray-50
                prose-td:border prose-td:border-gray-300 prose-td:px-3 prose-td:py-2
                dark:prose-th:border-zinc-600 dark:prose-td:border-zinc-600 dark:prose-th:bg-zinc-800
                focus:ring-0"
              dangerouslySetInnerHTML={{ __html: htmlContent }}
              onInput={() => setModified(true)}
            />
          ) : (
            <div
              className="prose prose-sm dark:prose-invert max-w-none
                prose-p:my-2 prose-headings:my-3
                prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
                prose-table:border-collapse prose-th:border prose-th:border-gray-300 prose-th:px-3 prose-th:py-2 prose-th:bg-gray-50
                prose-td:border prose-td:border-gray-300 prose-td:px-3 prose-td:py-2
                dark:prose-th:border-zinc-600 dark:prose-td:border-zinc-600 dark:prose-th:bg-zinc-800"
              dangerouslySetInnerHTML={{ __html: htmlContent }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ========== Excel 编辑器组件（SheetJS 读取 + 可编辑表格） ==========
function ExcelEditor({
  documentId,
  title,
  onBack,
}: {
  documentId: string;
  title: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [sheetData, setSheetData] = useState<Record<string, string[][]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [modified, setModified] = useState(false);
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const workbookRef = useRef<any>(null);

  useEffect(() => {
    async function loadDocument() {
      try {
        setLoading(true);
        const arrayBuffer = await api.getDocumentContent(documentId);
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(arrayBuffer, { type: "array" });
        workbookRef.current = workbook;

        const names = workbook.SheetNames;
        setSheetNames(names);

        const data: Record<string, string[][]> = {};
        for (const name of names) {
          const sheet = workbook.Sheets[name];
          const json = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "" });
          // 确保至少有一些行列
          if (json.length === 0) json.push([""]);
          // 统一列数
          const maxCols = Math.max(...json.map(r => r.length), 1);
          data[name] = json.map(r => {
            while (r.length < maxCols) r.push("");
            return r.map(c => String(c ?? ""));
          });
        }
        setSheetData(data);
      } catch (err: any) {
        setError(err.message || t("documents.loadFailed"));
      } finally {
        setLoading(false);
      }
    }
    loadDocument();
  }, [documentId]);

  const currentData = sheetData[sheetNames[activeSheet]] || [];

  const handleCellEdit = (row: number, col: number, value: string) => {
    const sheetName = sheetNames[activeSheet];
    setSheetData(prev => {
      const newData = { ...prev };
      const rows = [...newData[sheetName]];
      rows[row] = [...rows[row]];
      rows[row][col] = value;
      newData[sheetName] = rows;
      return newData;
    });
    setModified(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();
      for (const name of sheetNames) {
        const rows = sheetData[name] || [];
        const ws = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, name);
      }
      const buffer = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      await api.saveDocumentContent(documentId, blob);
      setModified(false);
    } catch (err: any) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  // 添加行/列
  const addRow = () => {
    const sheetName = sheetNames[activeSheet];
    setSheetData(prev => {
      const newData = { ...prev };
      const rows = [...newData[sheetName]];
      const cols = rows[0]?.length || 1;
      rows.push(new Array(cols).fill(""));
      newData[sheetName] = rows;
      return newData;
    });
    setModified(true);
  };

  const addCol = () => {
    const sheetName = sheetNames[activeSheet];
    setSheetData(prev => {
      const newData = { ...prev };
      newData[sheetName] = newData[sheetName].map(r => [...r, ""]);
      return newData;
    });
    setModified(true);
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-app-bg">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-accent-primary" />
          <p className="text-sm text-tx-secondary">{t("documents.loadingDocument")}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-app-bg">
        <div className="flex flex-col items-center gap-3 text-center px-4">
          <p className="text-sm text-red-500">{error}</p>
          <button onClick={onBack} className="px-4 py-2 text-sm bg-app-hover text-tx-primary rounded-lg">
            {t("documents.backToList")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-app-border bg-app-surface/50 shrink-0">
        <button onClick={onBack} className="p-1.5 rounded-md text-tx-secondary hover:text-tx-primary hover:bg-app-hover transition-colors">
          <ArrowLeft size={18} />
        </button>
        <span className="text-sm font-medium text-tx-primary truncate flex-1">{title}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setEditMode(!editMode)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors",
              editMode ? "bg-accent-primary/10 text-accent-primary font-medium" : "text-tx-secondary hover:text-tx-primary hover:bg-app-hover"
            )}
          >
            {editMode ? <Pencil size={14} /> : <Eye size={14} />}
            {editMode ? t("documents.editing") : t("documents.preview")}
          </button>
          {editMode && (
            <>
              <button onClick={addRow} className="px-2 py-1.5 text-xs text-tx-secondary hover:text-tx-primary hover:bg-app-hover rounded-md">
                + {t("documents.addRow")}
              </button>
              <button onClick={addCol} className="px-2 py-1.5 text-xs text-tx-secondary hover:text-tx-primary hover:bg-app-hover rounded-md">
                + {t("documents.addCol")}
              </button>
            </>
          )}
          {editMode && modified && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent-primary hover:bg-accent-hover disabled:opacity-50 rounded-md transition-colors"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? t("common.saving") : t("common.save")}
            </button>
          )}
        </div>
      </div>

      {/* Sheet 标签 */}
      {sheetNames.length > 1 && (
        <div className="flex items-center gap-0.5 px-4 py-1.5 border-b border-app-border bg-app-surface/30 shrink-0 overflow-x-auto">
          {sheetNames.map((name, i) => (
            <button
              key={name}
              onClick={() => { setActiveSheet(i); setEditingCell(null); }}
              className={cn(
                "px-3 py-1 text-xs rounded-md transition-colors whitespace-nowrap",
                i === activeSheet
                  ? "bg-accent-primary/10 text-accent-primary font-medium"
                  : "text-tx-secondary hover:text-tx-primary hover:bg-app-hover"
              )}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {/* 表格 */}
      <div className="flex-1 overflow-auto">
        <table className="border-collapse text-xs w-full">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="bg-gray-100 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 px-1 py-1 text-center text-tx-tertiary font-normal w-10 min-w-[40px]">
                #
              </th>
              {(currentData[0] || [""]).map((_, ci) => (
                <th key={ci} className="bg-gray-100 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 px-2 py-1 text-center text-tx-tertiary font-normal min-w-[80px]">
                  {String.fromCharCode(65 + (ci % 26))}{ci >= 26 ? Math.floor(ci / 26) : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {currentData.map((row, ri) => (
              <tr key={ri}>
                <td className="bg-gray-50 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700 px-1 py-1 text-center text-tx-tertiary font-normal">
                  {ri + 1}
                </td>
                {row.map((cell, ci) => {
                  const isEditing = editingCell?.row === ri && editingCell?.col === ci;
                  return (
                    <td
                      key={ci}
                      className={cn(
                        "border border-gray-200 dark:border-zinc-700 px-2 py-1 text-tx-primary",
                        editMode && "cursor-pointer hover:bg-accent-primary/5",
                        isEditing && "bg-accent-primary/10 p-0"
                      )}
                      onClick={() => {
                        if (editMode && !isEditing) {
                          setEditingCell({ row: ri, col: ci });
                          setEditValue(cell);
                        }
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => {
                            handleCellEdit(ri, ci, editValue);
                            setEditingCell(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              handleCellEdit(ri, ci, editValue);
                              // 移到下一行
                              if (ri + 1 < currentData.length) {
                                setEditingCell({ row: ri + 1, col: ci });
                                setEditValue(currentData[ri + 1][ci] || "");
                              } else {
                                setEditingCell(null);
                              }
                            }
                            if (e.key === "Tab") {
                              e.preventDefault();
                              handleCellEdit(ri, ci, editValue);
                              if (ci + 1 < row.length) {
                                setEditingCell({ row: ri, col: ci + 1 });
                                setEditValue(row[ci + 1] || "");
                              } else {
                                setEditingCell(null);
                              }
                            }
                            if (e.key === "Escape") setEditingCell(null);
                          }}
                          className="w-full h-full px-2 py-1 text-xs outline-none bg-transparent border-2 border-accent-primary rounded-sm"
                        />
                      ) : (
                        <span className="block truncate max-w-[200px]">{cell}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ========== 文档中心主组件 ==========
export default function DocumentCenter() {
  const { t } = useTranslation();
  const actions = useAppActions();
  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [openDoc, setOpenDoc] = useState<{ id: string; title: string; docType: DocType } | null>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) {
        setShowCreateMenu(false);
      }
    }
    if (showCreateMenu) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showCreateMenu]);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const filteredDocs = searchQuery.trim()
    ? documents.filter((d) => d.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : documents;

  const handleCreate = async (docType: DocType) => {
    setShowCreateMenu(false);
    try {
      const doc = await api.createDocument({ docType });
      setDocuments((prev) => [doc as any, ...prev]);
      setOpenDoc({ id: doc.id, title: doc.title, docType: doc.docType });
    } catch (err: any) {
      console.error("Create failed:", err);
    }
  };

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
      if (openDoc && openDoc.id === editingId) {
        setOpenDoc({ ...openDoc, title: editTitle.trim() });
      }
    } catch (err) {
      console.error("Rename failed:", err);
    }
    setEditingId(null);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteDocument(id);
      setDocuments((prev) => prev.filter((d) => d.id !== id));
      if (openDoc?.id === id) setOpenDoc(null);
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

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

  // 打开文档编辑器
  if (openDoc) {
    if (openDoc.docType === "cell") {
      return (
        <ExcelEditor
          documentId={openDoc.id}
          title={openDoc.title}
          onBack={() => { setOpenDoc(null); loadDocuments(); }}
        />
      );
    }
    return (
      <WordEditor
        documentId={openDoc.id}
        title={openDoc.title}
        onBack={() => { setOpenDoc(null); loadDocuments(); }}
      />
    );
  }

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
                accept=".docx,.doc,.xlsx,.xls,.csv,.odt,.rtf,.txt"
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
                    {(["word", "cell"] as DocType[]).map((type) => {
                      const config = DOC_TYPE_CONFIG[type];
                      if (!config) return null;
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

      {/* 工具栏 */}
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
            <button onClick={() => setSearchQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-tx-tertiary hover:text-tx-secondary">
              <X size={12} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {["all", "word", "cell"].map((type) => (
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
              const config = DOC_TYPE_CONFIG[doc.docType] || DOC_TYPE_CONFIG.word;
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
                    } else {
                      setOpenDoc({ id: doc.id, title: doc.title, docType: doc.docType });
                    }
                  }}
                >
                  {batchMode && (
                    <div className="absolute top-2 left-2 z-10">
                      {isSelected ? (
                        <CheckSquare size={18} className="text-accent-primary" />
                      ) : (
                        <Square size={18} className="text-tx-tertiary" />
                      )}
                    </div>
                  )}

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
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            const buf = await api.getDocumentContent(doc.id);
                            const blob = new Blob([buf]);
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = doc.title;
                            a.click();
                            URL.revokeObjectURL(url);
                          } catch (err) {
                            console.error("Download failed:", err);
                          }
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

                  <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center mb-3",
                    doc.docType === "word" ? "bg-blue-50 dark:bg-blue-900/20" : "bg-green-50 dark:bg-green-900/20"
                  )}>
                    <Icon size={22} className={config.color} />
                  </div>

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
