import React, { useState, useEffect, useRef } from "react";
import { Globe, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  parseServerUrl,
  normalizeServerBaseUrl,
  formatServerHost,
  type ServerAddressParts,
  type ServerScheme,
} from "@/lib/serverUrl";

/**
 * 登录 / 服务器连接页共用的地址输入组件。
 *
 * 新版设计：主输入框接受完整服务器地址（含 path），协议下拉作为无 scheme 时的默认值。
 * 用户可以直接粘贴 https://fnos.net/user:3001 这种带反代路径的地址。
 *
 * 旧版三段式 (protocol / host / port) 仍然兼容：
 *   - 局域网发现返回的 host:port 可以回填
 *   - 旧 localStorage 数据可以回填
 *   - parseServerUrl 会把 path 提取出来
 */

export interface ServerAddressInputProps {
  value: ServerAddressParts;
  onChange: (next: ServerAddressParts) => void;
  /** host blur 时触发——LoginPage 用它做"失焦自动测连接" */
  onHostBlur?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
  /** 右侧额外图标（连接状态） */
  rightSlot?: React.ReactNode;
  /** 主色调：emerald | indigo（两个调用页的配色不同） */
  accent?: "emerald" | "indigo";
}

const ACCENT_CLASS: Record<NonNullable<ServerAddressInputProps["accent"]>, string> = {
  emerald:
    "focus-within:ring-2 focus-within:ring-emerald-500/40 focus-within:border-emerald-500 dark:focus-within:border-emerald-500",
  indigo:
    "focus-within:ring-2 focus-within:ring-indigo-500/40 focus-within:border-indigo-500 dark:focus-within:border-indigo-500",
};

/**
 * 从 ServerAddressParts 拼出用户可编辑的显示文本。
 * 如果有 path，显示 host:port/path；否则显示 host。
 */
function partsToDisplayText(parts: ServerAddressParts): string {
  let text = formatServerHost(parts.host);
  if (parts.port) text += `:${parts.port}`;
  if (parts.path) text += parts.path;
  return text;
}

/**
 * 用户输入的文本可能是：
 *   - 纯 host:                  "192.168.1.10"
 *   - host:port:                "192.168.1.10:3001"
 *   - host/path:                "fnos.net/user:3001"
 *   - host:port/path:           "fnos.net:443/user:3001"
 *   - 完整 URL:                 "https://fnos.net/user:3001"
 *   - 完整 URL 带 API 子路径:  "https://fnos.net/user:3001/api/health"
 *
 * 尝试解析并返回更新后的 parts（含 path）。
 */
function parseUserInput(raw: string, defaultProtocol: ServerScheme): ServerAddressParts | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 如果包含 scheme，直接用 parseServerUrl（它已支持 path）
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = parseServerUrl(trimmed);
    if (!parsed.host) return null;
    return parsed;
  }

  // 无 scheme：拼上默认协议再解析
  const parsed = parseServerUrl(`${defaultProtocol}://${trimmed}`);
  if (!parsed.host) return null;
  // 保持用户选的协议，不要被 parseServerUrl 的默认值覆盖
  parsed.protocol = defaultProtocol;
  return parsed;
}

export default function ServerAddressInput({
  value,
  onChange,
  onHostBlur,
  autoFocus,
  disabled,
  rightSlot,
  accent = "indigo",
}: ServerAddressInputProps) {
  const { t } = useTranslation();

  // 内部编辑态：主输入框显示的文本
  // 从 value.parts 拼出显示文本
  const [displayText, setDisplayText] = useState(() => partsToDisplayText(value));
  // 标记是否正在编辑（编辑时不从外部 value 同步回 displayText）
  const editingRef = useRef(false);

  // 外部 value 变化时同步到 displayText（仅非编辑状态）
  useEffect(() => {
    if (!editingRef.current) {
      setDisplayText(partsToDisplayText(value));
    }
  }, [value.protocol, value.host, value.port, value.path]);

  const update = (patch: Partial<ServerAddressParts>) => onChange({ ...value, ...patch });

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    editingRef.current = true;
    const raw = e.target.value;
    setDisplayText(raw);

    // 实时尝试解析——如果用户粘贴了完整 URL，立即拆分
    const parsed = parseUserInput(raw, value.protocol);
    if (parsed) {
      onChange(parsed);
      // 如果解析成功且输入看起来是完整 URL（含 scheme 或 path），更新显示文本为归一化结果
      if (/^https?:\/\//i.test(raw.trim()) || raw.includes("/")) {
        setDisplayText(partsToDisplayText(parsed));
      }
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!text) return;
    const parsed = parseUserInput(text, value.protocol);
    if (parsed) {
      e.preventDefault();
      editingRef.current = true;
      onChange(parsed);
      setDisplayText(partsToDisplayText(parsed));
    }
  };

  const handleBlur = () => {
    editingRef.current = false;
    // blur 时最终归一化
    const parsed = parseUserInput(displayText, value.protocol);
    if (parsed && parsed.host) {
      onChange(parsed);
      setDisplayText(partsToDisplayText(parsed));
    }
    onHostBlur?.();
  };

  return (
    <div
      className={
        "relative flex items-stretch w-full border border-zinc-200 dark:border-zinc-700 rounded-xl " +
        "bg-zinc-50/50 dark:bg-zinc-800/50 transition-all overflow-hidden " +
        ACCENT_CLASS[accent]
      }
    >
      {/* Protocol select — 作为无 scheme 输入时的默认协议 */}
      <div className="relative flex items-center pl-3 pr-1 border-r border-zinc-200 dark:border-zinc-700">
        <Globe className="h-4 w-4 text-zinc-400 dark:text-zinc-500 mr-1.5" />
        <select
          value={value.protocol}
          disabled={disabled}
          onChange={(e) => {
            const newProtocol = e.target.value as ServerScheme;
            update({ protocol: newProtocol });
          }}
          aria-label={t("server.protocolLabel")}
          className={
            "appearance-none bg-transparent text-sm text-zinc-900 dark:text-zinc-100 " +
            "focus:outline-none pr-5 py-2.5 cursor-pointer disabled:cursor-not-allowed"
          }
        >
          <option value="http">http</option>
          <option value="https">https</option>
        </select>
        <ChevronDown className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500 absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>

      {/* :// 分隔 */}
      <span className="select-none flex items-center px-1.5 text-xs text-zinc-400 dark:text-zinc-500">
        ://
      </span>

      {/* 完整地址输入框 */}
      <input
        type="text"
        value={displayText}
        onChange={handleTextChange}
        onPaste={handlePaste}
        onBlur={handleBlur}
        placeholder={t("server.urlPlaceholder") || "example.com:3001 或 fnos.net/user:3001"}
        autoFocus={autoFocus}
        disabled={disabled}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        inputMode="url"
        className={
          "flex-1 min-w-0 bg-transparent py-2.5 pr-2 text-sm " +
          "text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 " +
          "focus:outline-none disabled:cursor-not-allowed"
        }
      />

      {/* 右侧状态槽 */}
      {rightSlot && (
        <div className="flex items-center pr-3 pl-1">{rightSlot}</div>
      )}
    </div>
  );
}