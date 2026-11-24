import React from "react";
import { CaseSensitive, LayoutTemplate, Languages, List, ListChecks, Puzzle, Quote, Sparkles, Type, Wand2, type LucideIcon } from "lucide-react";

// Host allowlist from the contribution contract; unknown keys fall back to the generic extension icon.
const ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles, wand: Wand2, quote: Quote, list: List, case: CaseSensitive,
  template: LayoutTemplate, translate: Languages, summary: ListChecks, text: Type,
};

export function EditorActionIcon({ icon, size = 15, className }: { icon?: string; size?: number; className?: string }) {
  const Icon = (icon && ICONS[icon]) || Puzzle;
  return <Icon size={size} className={className} aria-hidden />;
}
