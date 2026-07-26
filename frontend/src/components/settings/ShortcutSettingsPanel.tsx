import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Download,
  Keyboard,
  Lock,
  RotateCcw,
  Search,
  Upload,
  X,
} from "lucide-react";
import {
  SHORTCUT_CATEGORY_LABELS,
  SHORTCUT_COMMANDS,
  detectShortcutPlatform,
  detectShortcutSurface,
  findShortcutConflictsForCandidate,
  formatShortcutChord,
  formatShortcutForCommand,
  getDefaultShortcutChords,
  getShortcutChords,
  validateShortcutChord,
  type ShortcutCategory,
  type ShortcutChord,
} from "@/lib/shortcutRegistry";
import {
  SHORTCUT_OVERRIDES_CHANGED_EVENT,
  exportShortcutOverrides,
  hasShortcutOverride,
  importShortcutOverrides,
  resetAllShortcutOverrides,
  resetShortcutOverride,
  setShortcutOverride,
  shortcutChordFromKeyboardEvent,
} from "@/lib/shortcutOverrides";
import { cn } from "@/lib/utils";

const CATEGORY_ORDER: readonly ShortcutCategory[] = [
  "global", "navigation", "rich-text", "markdown", "desktop",
];

interface PendingBinding {
  commandId: string;
  chord: ShortcutChord;
  conflicts: ReturnType<typeof findShortcutConflictsForCandidate>;
}

export default function ShortcutSettingsPanel() {
  const platform = detectShortcutPlatform();
  const surface = detectShortcutSurface();
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingBinding | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener(SHORTCUT_OVERRIDES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(SHORTCUT_OVERRIDES_CHANGED_EVENT, refresh);
  }, []);

  const availableCommands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return SHORTCUT_COMMANDS
      .filter((command) => command.availableIn.includes(surface))
      .filter((command) => !needle || [
        command.label,
        command.description,
        SHORTCUT_CATEGORY_LABELS[command.category],
      ].join(" ").toLowerCase().includes(needle));
  }, [query, revision, surface]);

  const groups = useMemo(() => CATEGORY_ORDER
    .map((category) => ({
      category,
      commands: availableCommands.filter((command) => command.category === category),
    }))
    .filter((group) => group.commands.length > 0), [availableCommands]);

  const applyBinding = (commandId: string, chord: ShortcutChord) => {
    setShortcutOverride(commandId, platform, [chord]);
    setRecordingId(null);
    setPending(null);
    setMessage({ kind: "success", text: "快捷键已保存，仅应用于当前设备和平台。" });
  };

  useEffect(() => {
    if (!recordingId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        setRecordingId(null);
        return;
      }
      const chord = shortcutChordFromKeyboardEvent(event, platform);
      if (!chord) {
        setMessage({ kind: "error", text: "请按下包含 Ctrl/Cmd、Alt 或 Shift 的完整组合键。" });
        return;
      }
      const invalidReason = validateShortcutChord(chord, platform, surface, recordingId);
      if (invalidReason) {
        setMessage({ kind: "error", text: invalidReason });
        return;
      }
      const conflicts = findShortcutConflictsForCandidate(recordingId, chord, platform);
      if (conflicts.length > 0) {
        setPending({ commandId: recordingId, chord, conflicts });
        setRecordingId(null);
        return;
      }
      applyBinding(recordingId, chord);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [platform, recordingId, surface]);

  const resolveConflictsAndApply = () => {
    if (!pending) return;
    const locked = pending.conflicts.filter((conflict) => !conflict.customizable);
    if (locked.length > 0) {
      setMessage({ kind: "error", text: "该组合键与不可修改的系统命令冲突，请选择其他键位。" });
      setPending(null);
      return;
    }
    for (const conflict of pending.conflicts) {
      setShortcutOverride(conflict.commandId, platform, []);
    }
    applyBinding(pending.commandId, pending.chord);
  };

  const exportConfig = () => {
    const blob = new Blob([exportShortcutOverrides()], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `nowen-shortcuts-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importConfig = async (file: File) => {
    try {
      const validCommandIds = new Set(SHORTCUT_COMMANDS.map((command) => command.id));
      const customizableCommandIds = new Set(
        SHORTCUT_COMMANDS.filter((command) => command.customizable).map((command) => command.id),
      );
      const count = importShortcutOverrides(await file.text(), {
        validCommandIds,
        customizableCommandIds,
        validateChord: (chord, importPlatform, commandId) => (
          validateShortcutChord(chord, importPlatform, surface, commandId)
        ),
      });
      setMessage({ kind: "success", text: `已导入 ${count} 项快捷键配置。` });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "快捷键配置导入失败" });
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const platformLabel = platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux";

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2">
          <Keyboard size={20} className="text-accent-primary" />
          <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">快捷键</h3>
        </div>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          当前编辑 {platformLabel} {surface === "desktop" ? "桌面端" : "Web 端"}键位。配置仅保存在本机，并按平台隔离。
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <Search size={15} className="text-zinc-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索命令或分类…"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
        <div className="flex gap-2">
          <button onClick={exportConfig} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
            <Download size={14} />导出
          </button>
          <button onClick={() => importRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
            <Upload size={14} />导入
          </button>
          <button
            onClick={() => {
              if (!confirm(`恢复 ${platformLabel} 的全部默认快捷键？`)) return;
              resetAllShortcutOverrides(platform);
              setMessage({ kind: "success", text: "已恢复当前平台的全部默认快捷键。" });
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800"
          >
            <RotateCcw size={14} />全部默认
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importConfig(file);
            }}
          />
        </div>
      </div>

      {message && (
        <div className={cn(
          "flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-xs",
          message.kind === "success"
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
        )}>
          <span>{message.text}</span>
          <button onClick={() => setMessage(null)} aria-label="关闭提示"><X size={14} /></button>
        </div>
      )}

      <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        Electron 原生菜单仍可点击，但可自定义命令的键盘触发已统一交给应用注册表，修改后无需重启。
      </div>

      <div className="space-y-5">
        {groups.map((group) => (
          <section key={group.category}>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {SHORTCUT_CATEGORY_LABELS[group.category]}
            </h4>
            <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
              {group.commands.map((command, index) => {
                const current = getShortcutChords(command.id, platform, surface);
                const defaults = getDefaultShortcutChords(command.id, platform, surface);
                const overridden = hasShortcutOverride(command.id, platform);
                const currentLabel = current[0] ? formatShortcutChord(current[0], platform) : "未绑定";
                const defaultLabel = defaults[0] ? formatShortcutChord(defaults[0], platform) : "无默认键位";
                return (
                  <div key={command.id} className={cn("px-4 py-3", index > 0 && "border-t border-zinc-200 dark:border-zinc-800")}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {command.label}
                          {!command.customizable && <Lock size={12} className="text-zinc-400" />}
                          {overridden && <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-600 dark:text-indigo-300">已修改</span>}
                        </div>
                        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{command.description}</p>
                        <p className="mt-1 text-[11px] text-zinc-400">默认：{defaultLabel}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <kbd className={cn(
                          "min-w-24 rounded-md border px-2 py-1.5 text-center font-mono text-xs",
                          recordingId === command.id
                            ? "border-indigo-500 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"
                            : "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200",
                        )}>
                          {recordingId === command.id ? "请按组合键…" : currentLabel}
                        </kbd>
                        {command.customizable ? (
                          <>
                            <button
                              onClick={() => {
                                setMessage(null);
                                setRecordingId(recordingId === command.id ? null : command.id);
                              }}
                              className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs dark:border-zinc-700"
                            >
                              {recordingId === command.id ? "取消" : "录制"}
                            </button>
                            <button
                              onClick={() => setShortcutOverride(command.id, platform, [])}
                              className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs dark:border-zinc-700"
                            >清空</button>
                            <button
                              disabled={!overridden}
                              onClick={() => resetShortcutOverride(command.id, platform)}
                              className="rounded-md border border-zinc-200 p-1.5 text-zinc-500 disabled:opacity-30 dark:border-zinc-700"
                              title="恢复默认"
                            ><RotateCcw size={14} /></button>
                          </>
                        ) : (
                          <span className="text-[11px] text-zinc-400">系统保留</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {groups.length === 0 && <div className="py-10 text-center text-sm text-zinc-400">没有匹配的命令</div>}

      {pending && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/45" onClick={() => setPending(null)} />
          <div className="relative w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 text-amber-500" size={20} />
              <div>
                <h4 className="font-semibold">快捷键冲突</h4>
                <p className="mt-1 text-sm text-zinc-500">
                  {formatShortcutChord(pending.chord, platform)} 已被以下命令占用：
                </p>
                <ul className="mt-2 space-y-1 text-sm">
                  {pending.conflicts.map((conflict) => (
                    <li key={`${conflict.surface}:${conflict.commandId}`}>
                      {SHORTCUT_COMMANDS.find((command) => command.id === conflict.commandId)?.label ?? conflict.commandId}
                      <span className="ml-1 text-xs text-zinc-400">({conflict.surface})</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setPending(null)} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">取消</button>
              <button
                onClick={resolveConflictsAndApply}
                disabled={pending.conflicts.some((conflict) => !conflict.customizable)}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white disabled:opacity-40"
              >解除旧绑定并应用</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
