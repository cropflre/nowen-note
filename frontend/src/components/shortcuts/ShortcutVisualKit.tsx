import { useState, type ReactNode } from "react";
import type { ShortcutChord, ShortcutPlatform } from "@/lib/shortcutRegistry";
import { cn } from "@/lib/utils";
import { chordToKeycapTokens } from "./shortcutVisualMeta";
import "./shortcut-keycaps.css";

export interface KeycapProps {
  children: ReactNode;
  size?: "sm" | "md";
  variant?: "default" | "modifier" | "active" | "recording" | "saved" | "ghost";
  pressed?: boolean;
  interactive?: boolean;
  pop?: boolean;
  className?: string;
  onClick?: () => void;
  title?: string;
}

export function Keycap({
  children,
  size = "md",
  variant = "default",
  pressed = false,
  interactive = false,
  pop = false,
  className,
  onClick,
  title,
}: KeycapProps) {
  const [booped, setBooped] = useState(false);

  const handleClick = () => {
    if (interactive) {
      setBooped(true);
      window.setTimeout(() => setBooped(false), 150);
    }
    onClick?.();
  };

  return (
    <kbd
      onClick={onClick || interactive ? handleClick : undefined}
      title={title}
      className={cn(
        "nowen-keycap",
        size === "sm" && "nowen-keycap--sm",
        variant === "modifier" && "nowen-keycap--modifier",
        variant === "active" && "nowen-keycap--active",
        variant === "recording" && "nowen-keycap--recording",
        variant === "saved" && "nowen-keycap--saved",
        variant === "ghost" && "nowen-keycap--ghost",
        (interactive || Boolean(onClick)) && "nowen-keycap--interactive",
        (pressed || booped) && "nowen-keycap--pressed",
        pop && "nowen-keycap-pop",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export interface ShortcutChordCapsProps {
  chord?: ShortcutChord;
  platform: ShortcutPlatform;
  emptyText?: string;
  size?: "sm" | "md";
  state?: "idle" | "active" | "recording" | "saved";
  pressedTokens?: ReadonlySet<string>;
  interactive?: boolean;
  pop?: boolean;
  onClick?: () => void;
  title?: string;
  className?: string;
}

export function ShortcutChordCaps({
  chord,
  platform,
  emptyText = "未绑定",
  size = "md",
  state = "idle",
  pressedTokens,
  interactive = false,
  pop = false,
  onClick,
  title,
  className,
}: ShortcutChordCapsProps) {
  if (!chord || chord.length === 0) {
    return (
      <span
        onClick={onClick}
        title={title}
        className={cn(
          "inline-flex items-center",
          onClick && "cursor-pointer",
          className,
        )}
      >
        <Keycap size={size} variant="ghost" interactive={Boolean(onClick)} className="px-2.5">
          {emptyText}
        </Keycap>
      </span>
    );
  }

  const tokens = chordToKeycapTokens(chord, platform);
  const showPlus = platform !== "macos";

  return (
    <span
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex flex-wrap items-center gap-1 pb-[3px]",
        onClick && "cursor-pointer",
        className,
      )}
    >
      {tokens.map((token, index) => {
        const isPressed = pressedTokens?.has(token.raw) ?? false;
        const variant = state === "recording"
          ? "recording"
          : state === "saved"
            ? "saved"
            : state === "active" || isPressed
              ? "active"
              : token.isModifier
                ? "modifier"
                : "default";

        return (
          <span key={`${token.raw}-${index}`} className="inline-flex items-center gap-1">
            {showPlus && index > 0 && (
              <span className="text-[10px] font-semibold text-tx-tertiary select-none">+</span>
            )}
            <Keycap
              size={size}
              variant={variant}
              pressed={isPressed}
              interactive={interactive || Boolean(onClick)}
              pop={pop}
            >
              {token.label}
            </Keycap>
          </span>
        );
      })}
    </span>
  );
}

/**
 * Playful animated double-keycap emblem used in headers.
 */
export function PlayfulKeycapEmblem({ platform }: { platform: ShortcutPlatform }) {
  const [pressedKey, setPressedKey] = useState<"mod" | "k" | null>(null);
  const modLabel = platform === "macos" ? "⌘" : "Ctrl";

  return (
    <div
      className="group relative flex h-11 w-11 shrink-0 select-none items-center justify-center rounded-2xl border border-app-border bg-app-surface shadow-sm"
      title="点一下试试机械键帽手感"
    >
      <div className="flex items-end gap-0.5 pb-[2px]">
        <Keycap
          size="sm"
          variant="modifier"
          interactive
          pressed={pressedKey === "mod"}
          onClick={() => {
            setPressedKey("mod");
            window.setTimeout(() => setPressedKey(null), 160);
          }}
          className="!h-5 !min-w-[1.2rem] !px-1 !text-[10px] -rotate-6 group-hover:-rotate-12"
        >
          {modLabel === "Ctrl" ? "⌃" : modLabel}
        </Keycap>
        <Keycap
          size="sm"
          variant="active"
          interactive
          pressed={pressedKey === "k"}
          onClick={() => {
            setPressedKey("k");
            window.setTimeout(() => setPressedKey(null), 160);
          }}
          className="!h-6 !min-w-[1.3rem] !px-1 !text-[11px] rotate-6 group-hover:rotate-12"
        >
          K
        </Keycap>
      </div>
    </div>
  );
}
