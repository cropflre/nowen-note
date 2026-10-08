import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  parseServerUrl,
  formatServerHost,
  type ServerAddressParts,
  type ServerScheme,
} from "@/lib/serverUrl";

/**
 * Login and connection pages share this address field. Keep what the user
 * actually typed while it has focus; commit the canonical host/port/path
 * representation only on blur. Rewriting controlled input text on each
 * keystroke makes the caret jump (notably during https:// and path entry).
 */
export interface ServerAddressInputProps {
  value: ServerAddressParts;
  onChange: (next: ServerAddressParts) => void;
  /** Receives the freshly parsed address, not potentially stale React state. */
  onHostBlur?: (resolved: ServerAddressParts) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  rightSlot?: React.ReactNode;
  accent?: "emerald" | "indigo";
}

const ACCENT_CLASS: Record<NonNullable<ServerAddressInputProps["accent"]>, string> = {
  emerald: "focus-within:border-emerald-500 dark:focus-within:border-emerald-400",
  indigo: "focus-within:border-indigo-500 dark:focus-within:border-indigo-400",
};
const SCHEMES: ServerScheme[] = ["http", "https"];

function partsToDisplayText(parts: ServerAddressParts): string {
  let text = formatServerHost(parts.host);
  if (parts.port) text += `:${parts.port}`;
  if (parts.path) text += parts.path;
  return text;
}

function parseUserInput(raw: string, defaultProtocol: ServerScheme): ServerAddressParts | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = parseServerUrl(trimmed);
    return parsed.host ? parsed : null;
  }
  const parsed = parseServerUrl(`${defaultProtocol}://${trimmed}`);
  if (!parsed.host) return null;
  return { ...parsed, protocol: defaultProtocol };
}

export default function ServerAddressInput({
  value, onChange, onHostBlur, autoFocus, disabled, rightSlot, accent = "indigo",
}: ServerAddressInputProps) {
  const { t } = useTranslation();
  const [displayText, setDisplayText] = useState(() => partsToDisplayText(value));
  const [protocolOpen, setProtocolOpen] = useState(false);
  const editingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const protocolRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!editingRef.current) setDisplayText(partsToDisplayText(value));
  }, [value.protocol, value.host, value.port, value.path]);

  useEffect(() => {
    if (!protocolOpen) return;
    const onOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setProtocolOpen(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProtocolOpen(false);
        protocolRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onOutsideClick);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onOutsideClick);
      document.removeEventListener("keydown", onEscape);
    };
  }, [protocolOpen]);

  const chooseProtocol = (protocol: ServerScheme) => {
    // An explicitly typed scheme is replaced when the user selects another one.
    const typed = parseUserInput(inputRef.current?.value ?? displayText, value.protocol);
    const next = { ...(typed ?? value), protocol };
    editingRef.current = false;
    setDisplayText(partsToDisplayText(next));
    onChange(next);
    setProtocolOpen(false);
    inputRef.current?.focus();
  };

  const handleTextChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const raw = event.currentTarget.value;
    editingRef.current = true;
    // Do not normalize the rendered text here: preserve caret position,
    // selection, incomplete URLs, IME composition and middle-of-string edits.
    setDisplayText(raw);
    const parsed = parseUserInput(raw, value.protocol);
    if (parsed) onChange(parsed);
    else if (!raw.trim()) onChange({ ...value, host: "", port: "", path: "" });
  };

  const handleBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    editingRef.current = false;
    const parsed = parseUserInput(event.currentTarget.value, value.protocol);
    const next = parsed ?? { ...value, host: "", port: "", path: "" };
    onChange(next);
    if (parsed) setDisplayText(partsToDisplayText(parsed));
    // Do not probe the server just because the user opened the protocol menu.
    if (!(event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget))) {
      if (parsed) onHostBlur?.(next);
    }
  };

  return (
    <div
      ref={rootRef}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest("button, input, [role='listbox']")) inputRef.current?.focus();
      }}
      className={
        "relative isolate flex w-full items-stretch rounded-xl border border-zinc-200 " +
        "bg-zinc-50/50 transition-colors focus-within:z-20 dark:border-zinc-700 dark:bg-zinc-800/50 " +
        ACCENT_CLASS[accent]
      }
    >
      <div className="relative flex shrink-0 items-center border-r border-zinc-200 dark:border-zinc-700">
        <button
          ref={protocolRef}
          type="button"
          disabled={disabled}
          aria-label={t("server.protocolLabel")}
          aria-haspopup="listbox"
          aria-expanded={protocolOpen}
          onClick={() => setProtocolOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setProtocolOpen(true);
            }
          }}
          className={
            "flex h-full min-h-10 items-center gap-1.5 rounded-l-[11px] px-3 " +
            "text-sm text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:outline-none " +
            "focus-visible:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 " +
            "dark:text-zinc-200 dark:hover:bg-zinc-700/70 dark:focus-visible:bg-zinc-700/70"
          }
        >
          <Globe className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
          <span>{value.protocol}</span>
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${protocolOpen ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
        {protocolOpen && !disabled && (
          <div
            role="listbox"
            aria-label={t("server.protocolLabel")}
            className={
              "absolute left-0 top-full z-50 mt-1.5 min-w-32 overflow-hidden rounded-xl " +
              "border border-zinc-200 bg-white p-1 shadow-lg shadow-zinc-900/10 " +
              "dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/30"
            }
          >
            {SCHEMES.map((protocol) => (
              <button
                key={protocol}
                type="button"
                role="option"
                aria-selected={value.protocol === protocol}
                onClick={() => chooseProtocol(protocol)}
                className={
                  "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm " +
                  "text-zinc-700 hover:bg-zinc-100 focus-visible:outline-none focus-visible:bg-zinc-100 " +
                  "dark:text-zinc-200 dark:hover:bg-zinc-800 dark:focus-visible:bg-zinc-800"
                }
              >
                <span>{protocol}://</span>
                {value.protocol === protocol && <Check className="h-4 w-4 text-indigo-500" aria-hidden="true" />}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="flex shrink-0 select-none items-center px-1.5 text-xs text-zinc-400 dark:text-zinc-500" aria-hidden="true">://</span>
      <input
        ref={inputRef}
        type="text"
        value={displayText}
        onFocus={() => { editingRef.current = true; }}
        onChange={handleTextChange}
        onBlur={handleBlur}
        placeholder={t("server.urlPlaceholder") || "example.com:3001 或 fnos.net/user:3001"}
        aria-label={t("server.addressLabel")}
        autoFocus={autoFocus}
        disabled={disabled}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="url"
        spellCheck={false}
        inputMode="url"
        className={
          "min-w-0 flex-1 rounded-r-xl bg-transparent py-2.5 pr-2 text-sm " +
          "text-zinc-900 caret-indigo-600 placeholder-zinc-400 focus:outline-none " +
          "disabled:cursor-not-allowed dark:text-zinc-100 dark:caret-indigo-400 dark:placeholder-zinc-500"
        }
      />
      {rightSlot && <div className="flex items-center py-1 pl-1 pr-3" aria-live="polite">{rightSlot}</div>}
    </div>
  );
}
