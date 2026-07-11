import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  Download,
  FileArchive,
  Image,
  Loader2,
  PackageCheck,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { api, getBaseUrl, withSudo } from "@/lib/api";
import { confirm as confirmDialog, prompt as promptDialog } from "@/components/ui/confirm";
import { toast } from "@/lib/toast";

const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const HOST_ATTR = "data-nowen-full-data-transfer-host";

type Operation = "export" | "import" | null;
type Notice = { type: "success" | "error" | "info"; text: string } | null;

type BackupUploadResult = {
  filename: string;
  size: number;
  type: "full" | "db-only";
};

type RestorePreview = {
  tables: Array<{ name: string; willClear: number; willInsert: number }>;
  files: { attachments: number; fonts: number; plugins: number };
  schemaVersion: number;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function isZipFile(file: File): Promise<boolean> {
  if (!/\.zip$/i.test(file.name)) return false;
  try {
    const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  } catch {
    return false;
  }
}

function extractDownloadFilename(response: Response, fallback: string): string {
  const disposition = response.headers.get("Content-Disposition") || "";
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) {
    try { return decodeURIComponent(utf8); } catch { /* use regular filename */ }
  }
  return disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallback;
}

async function downloadBackup(filename: string): Promise<{ filename: string; size: number }> {
  const token = localStorage.getItem("nowen-token");
  const response = await fetch(`${getBaseUrl()}/backups/${encodeURIComponent(filename)}/download`, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `下载完整备份失败（HTTP ${response.status}）`);
  }

  const blob = await response.blob();
  const downloadName = extractDownloadFilename(response, filename);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = downloadName;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { filename: downloadName, size: blob.size };
}

function findLegacyTransferSections(): {
  host: HTMLElement;
  exportSection: HTMLElement;
  importSection: HTMLElement;
} | null {
  const existing = document.querySelector<HTMLElement>(`[${HOST_ATTR}]`);
  if (existing?.isConnected) {
    const exportSection = existing.dataset.exportSectionId
      ? document.getElementById(existing.dataset.exportSectionId)
      : null;
    const importSection = existing.dataset.importSectionId
      ? document.getElementById(existing.dataset.importSectionId)
      : null;
    if (exportSection && importSection) return { host: existing, exportSection, importSection };
  }

  const input = document.querySelector<HTMLInputElement>(
    'input[type="file"][accept*=".data"][accept*=".sqlite"]',
  );
  if (!input) return null;

  const importSection = input.closest<HTMLElement>(".pt-3.border-t");
  const exportSection = importSection?.previousElementSibling instanceof HTMLElement
    ? importSection.previousElementSibling
    : null;
  const parent = importSection?.parentElement;
  if (!importSection || !exportSection || !parent) return null;

  if (!exportSection.id) exportSection.id = `nowen-legacy-data-export-${Date.now()}`;
  if (!importSection.id) importSection.id = `nowen-legacy-data-import-${Date.now()}`;

  exportSection.dataset.nowenOriginalDisplay = exportSection.style.display;
  importSection.dataset.nowenOriginalDisplay = importSection.style.display;
  exportSection.style.display = "none";
  importSection.style.display = "none";

  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "true");
  host.dataset.exportSectionId = exportSection.id;
  host.dataset.importSectionId = importSection.id;
  parent.insertBefore(host, exportSection);
  return { host, exportSection, importSection };
}

function restoreLegacySections(binding: ReturnType<typeof findLegacyTransferSections>): void {
  if (!binding) return;
  binding.exportSection.style.display = binding.exportSection.dataset.nowenOriginalDisplay || "";
  binding.importSection.style.display = binding.importSection.dataset.nowenOriginalDisplay || "";
  delete binding.exportSection.dataset.nowenOriginalDisplay;
  delete binding.importSection.dataset.nowenOriginalDisplay;
  binding.host.remove();
}

function useTransferHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const bindingRef = useRef<ReturnType<typeof findLegacyTransferSections>>(null);

  useEffect(() => {
    let frame = 0;
    const scan = () => {
      frame = 0;
      if (bindingRef.current?.host.isConnected) {
        bindingRef.current.exportSection.style.display = "none";
        bindingRef.current.importSection.style.display = "none";
        return;
      }
      bindingRef.current = findLegacyTransferSections();
      setHost(bindingRef.current?.host || null);
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(scan);
    };

    scan();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      restoreLegacySections(bindingRef.current);
      bindingRef.current = null;
    };
  }, []);

  return host;
}

function NoticeBox({ notice }: { notice: Notice }) {
  if (!notice) return null;
  const styles = notice.type === "success"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-300"
    : notice.type === "error"
      ? "border-red-200 bg-red-50 text-red-600 dark:border-red-900/50 dark:bg-red-500/10 dark:text-red-300"
      : "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/50 dark:bg-blue-500/10 dark:text-blue-300";
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5 ${styles}`}>
      {notice.type === "success" ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
      <span className="break-all">{notice.text}</span>
    </div>
  );
}

function FullDataTransferPanel() {
  const [busy, setBusy] = useState<Operation>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sudoTokenRef = useRef<string | null>(null);

  const askPassword = useCallback(() => promptDialog({
    title: "验证管理员身份",
    description: "完整数据导出与恢复包含所有用户数据、账号信息和附件，请输入当前管理员密码。",
    type: "password",
    placeholder: "管理员密码",
    confirmText: "验证",
    cancelText: "取消",
    danger: true,
  }), []);

  const handleExport = useCallback(async () => {
    setBusy("export");
    setNotice({ type: "info", text: "正在创建数据库一致性快照并收集全部图片、附件、字体和插件…" });
    try {
      const out = await withSudo(
        (sudoToken) => api.backup.create("full", sudoToken, "数据管理：完整数据手动导出"),
        askPassword,
        sudoTokenRef.current,
      );
      if (!out) {
        setNotice(null);
        return;
      }
      sudoTokenRef.current = out.sudoToken;
      const downloaded = await downloadBackup(out.result.filename);
      const text = `完整备份已下载：${downloaded.filename}（${formatBytes(downloaded.size)}）`;
      setNotice({ type: "success", text });
      toast.success(text, 5000);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setNotice({ type: "error", text: `完整数据导出失败：${text}` });
    } finally {
      setBusy(null);
    }
  }, [askPassword]);

  const handleFileSelected = useCallback(async (file: File | null | undefined) => {
    setNotice(null);
    if (!file) return;
    if (file.size <= 0 || file.size > MAX_ARCHIVE_BYTES) {
      setSelectedFile(null);
      setNotice({ type: "error", text: `完整备份文件必须大于 0 且不超过 ${formatBytes(MAX_ARCHIVE_BYTES)}。` });
      return;
    }
    if (!(await isZipFile(file))) {
      setSelectedFile(null);
      setNotice({ type: "error", text: "请选择由 nowen-note 导出的完整备份 ZIP，旧 .data 文件不包含图片，不能在此入口恢复。" });
      return;
    }
    setSelectedFile(file);
  }, []);

  const handleImport = useCallback(async () => {
    if (!selectedFile) return;
    const firstConfirm = await confirmDialog({
      title: "导入完整系统备份？",
      description:
        `文件：${selectedFile.name}\n大小：${formatBytes(selectedFile.size)}\n\n` +
        "系统会先上传并校验备份包。真正恢复前还会展示数据库和文件数量，并自动创建当前系统的完整安全备份。",
      confirmText: "上传并预检",
      cancelText: "取消",
      danger: true,
    });
    if (!firstConfirm) return;

    setBusy("import");
    setNotice({ type: "info", text: "正在上传并校验完整备份包…" });
    try {
      const uploaded = await withSudo(
        (sudoToken) => api.backup.upload(selectedFile, sudoToken, "数据管理：外部完整数据导入"),
        askPassword,
        sudoTokenRef.current,
      );
      if (!uploaded) {
        setNotice(null);
        return;
      }
      sudoTokenRef.current = uploaded.sudoToken;
      const imported = uploaded.result as BackupUploadResult;
      if (imported.type !== "full") throw new Error("所选文件不是完整备份包");

      const previewResult = await api.backup.restore(imported.filename, true);
      if (!previewResult.success || !previewResult.dryRun) {
        throw new Error(previewResult.error || "完整备份预检失败");
      }
      const preview = previewResult.dryRun as RestorePreview;
      const totalClear = preview.tables.reduce((sum, row) => sum + row.willClear, 0);
      const totalInsert = preview.tables.reduce((sum, row) => sum + row.willInsert, 0);

      const restoreConfirmed = await confirmDialog({
        title: "确认覆盖当前全部数据？",
        description:
          `备份：${imported.filename}\n` +
          `数据库：将清空 ${totalClear.toLocaleString()} 行，恢复 ${totalInsert.toLocaleString()} 行\n` +
          `文件：${preview.files.attachments} 个附件/图片、${preview.files.fonts} 个字体、${preview.files.plugins} 个插件\n` +
          `Schema：v${preview.schemaVersion}\n\n` +
          "继续后会先生成一份当前系统的完整安全备份，再整体替换数据库和文件目录。恢复完成后必须重启后端或桌面客户端。",
        confirmText: "自动备份并恢复",
        cancelText: "暂不恢复",
        danger: true,
      });
      if (!restoreConfirmed) {
        setNotice({ type: "info", text: `备份包已安全导入备份仓库，但尚未恢复：${imported.filename}` });
        return;
      }

      setNotice({ type: "info", text: "正在创建恢复前完整安全备份，请不要关闭页面…" });
      const restored = await withSudo(
        async (sudoToken) => {
          const safety = await api.backup.create("full", sudoToken, `恢复 ${imported.filename} 前的自动安全备份`);
          const result = await api.backup.restore(imported.filename, false, sudoToken);
          return { safety, result };
        },
        askPassword,
        sudoTokenRef.current,
      );
      if (!restored) return;
      sudoTokenRef.current = restored.sudoToken;
      if (!restored.result.result.success) {
        throw new Error(restored.result.result.error || "完整数据恢复失败");
      }

      const successText = `完整数据恢复完成；恢复前安全备份为 ${restored.result.safety.filename}。请立即重启后端或桌面客户端。`;
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setNotice({ type: "success", text: successText });
      toast.success(successText, 8000);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setNotice({ type: "error", text: `完整数据导入失败：${text}` });
    } finally {
      setBusy(null);
    }
  }, [askPassword, selectedFile]);

  return (
    <div className="space-y-4">
      <div className="border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <div className="mb-2 flex items-center gap-2">
          <DatabaseBackup size={14} className="text-violet-500" />
          <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">导出完整系统数据</span>
          <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">推荐</span>
        </div>
        <p className="mb-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          生成一个可完整恢复的 ZIP，包含数据库中全部用户与业务数据，以及全部本地图片、附件、自定义字体、插件和登录密钥。
        </p>
        <div className="mb-2 grid grid-cols-2 gap-2 text-[11px] text-zinc-500 sm:grid-cols-4 dark:text-zinc-400">
          <span className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1.5 dark:bg-zinc-900"><DatabaseBackup size={12} /> 全部数据库</span>
          <span className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1.5 dark:bg-zinc-900"><Image size={12} /> 图片与附件</span>
          <span className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1.5 dark:bg-zinc-900"><PackageCheck size={12} /> 字体与插件</span>
          <span className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1.5 dark:bg-zinc-900"><ShieldCheck size={12} /> 账号与密钥</span>
        </div>
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={busy !== null}
          className="flex w-full items-center justify-center rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-violet-700 disabled:cursor-wait disabled:opacity-55"
        >
          {busy === "export" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
          {busy === "export" ? "正在生成完整备份…" : "下载完整备份 ZIP"}
        </button>
      </div>

      <div className="border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <div className="mb-2 flex items-center gap-2">
          <FileArchive size={14} className="text-amber-500" />
          <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">导入完整系统数据</span>
        </div>
        <p className="mb-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          恢复完整备份 ZIP 中的数据库、图片和全部文件。写入前会预检内容，并自动创建当前系统的完整安全备份。
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(event) => void handleFileSelected(event.target.files?.[0])}
        />
        {!selectedFile ? (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy !== null}
            className="flex w-full items-center justify-center rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:border-amber-400 hover:text-amber-600 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400"
          >
            <Upload className="mr-2 h-4 w-4" />
            选择完整备份 ZIP
          </button>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-200">
              <FileArchive size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate" title={selectedFile.name}>{selectedFile.name}</span>
              <span className="shrink-0 tabular-nums">{formatBytes(selectedFile.size)}</span>
              <button type="button" className="shrink-0 underline" onClick={() => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}>重选</button>
            </div>
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={busy !== null}
              className="flex w-full items-center justify-center rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-amber-700 disabled:cursor-wait disabled:opacity-55"
            >
              {busy === "import" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <AlertTriangle className="mr-2 h-4 w-4" />}
              {busy === "import" ? "正在校验或恢复…" : "预检并恢复全部数据"}
            </button>
          </div>
        )}
      </div>

      <NoticeBox notice={notice} />
      <p className="text-[11px] leading-5 text-zinc-400 dark:text-zinc-500">
        完整备份不包含运行日志、缓存、临时文件和历史备份副本；这些不属于可恢复的业务数据。旧 `.data` 仅包含 SQLite 数据库，无法恢复图片，已不再作为此处默认格式。
      </p>
    </div>
  );
}

export default function SystemFullDataTransferBridge() {
  const host = useTransferHost();
  return host ? createPortal(<FullDataTransferPanel />, host) : null;
}
