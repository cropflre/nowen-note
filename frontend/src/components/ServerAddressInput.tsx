import React, { useEffect, useRef, useState } from "react";
import { Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  buildServerUrl,
  isLanServerHostname,
  parseServerUrl,
  type ServerAddressParts,
} from "@/lib/serverUrl";

/**
 * Login and connection pages share this address field. Users paste the full
 * address they already use (scheme, host, port and reverse-proxy path). Keep
 * what the user actually typed while it has focus; commit the canonical URL
 * only on blur. Rewriting controlled input text on each keystroke makes the
 * caret jump (notably during https:// and path entry).
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
  emerald: "focus:ring-emerald-500/40 focus:border-emerald-500",
  indigo: "focus:ring-indigo-500/40 focus:border-indigo-500",
};

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

/**
 * An explicit http:// or https:// is always kept. Without a scheme, a public
 * domain name defaults to HTTPS; LAN names, loopback and IP addresses keep the
 * existing HTTP default.
 */
export function parseServerAddressInput(raw: string): ServerAddressParts | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = parseServerUrl(trimmed);
    return parsed.host ? parsed : null;
  }
  const parsed = parseServerUrl(`http://${trimmed}`);
  if (!parsed.host) return null;
  const hostname = parsed.host.replace(/^\[|\]$/g, "");
  const publicDomain = !isIpLiteral(hostname) && !isLanServerHostname(hostname);
  return publicDomain ? { ...parsed, protocol: "https" } : parsed;
}

export default function ServerAddressInput({
  value, onChange, onHostBlur, autoFocus, disabled, rightSlot, accent = "indigo",
}: ServerAddressInputProps) {
  const { t } = useTranslation();
  const [displayText, setDisplayText] = useState(() => buildServerUrl(value));
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) setDisplayText(buildServerUrl(value));
  }, [value.protocol, value.host, value.port, value.path]);

  const handleTextChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const raw = event.currentTarget.value;
    editingRef.current = true;
    // Do not normalize the rendered text here: preserve caret position,
    // selection, incomplete URLs, IME composition and middle-of-string edits.
    setDisplayText(raw);
    onChange(parseServerAddressInput(raw) ?? { ...value, host: "", port: "", path: "" });
  };

  const handleBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    editingRef.current = false;
    const parsed = parseServerAddressInput(event.currentTarget.value);
    onChange(parsed ?? { ...value, host: "", port: "", path: "" });
    if (parsed) {
      setDisplayText(buildServerUrl(parsed));
      onHostBlur?.(parsed);
    }
  };

  return (
    <div className="relative">
      <Globe className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
      <input
        type="text"
        value={displayText}
        onChange={handleTextChange}
        onBlur={handleBlur}
        placeholder={t("server.urlPlaceholder")}
        aria-label={t("server.addressLabel")}
        autoFocus={autoFocus}
        disabled={disabled}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="url"
        spellCheck={false}
        inputMode="url"
        className={
          `block w-full pl-10 ${rightSlot ? "pr-10" : "pr-3"} py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl ` +
          "bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 " +
          "dark:placeholder-zinc-500 focus:outline-none focus:ring-2 text-sm disabled:cursor-not-allowed " +
          ACCENT_CLASS[accent]
        }
      />
      {rightSlot && <div className="absolute inset-y-0 right-0 flex items-center pr-3" aria-live="polite">{rightSlot}</div>}
    </div>
  );
}
