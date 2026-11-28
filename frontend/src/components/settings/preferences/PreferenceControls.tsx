import React, { useId, useRef } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Cloud, Loader2, MonitorSmartphone, ShieldCheck, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

/** Where a setting is stored: the account (synced), this device only, or the server (administrators). */
export type PreferenceScope = "account" | "device" | "admin";

const SCOPE_COPY: Record<PreferenceScope, { label: string; hint: string; icon: LucideIcon; tone: string }> = {
  account: {
    label: "preferences.scope.account",
    hint: "preferences.scope.accountHint",
    icon: Cloud,
    tone: "bg-indigo-500/10 text-indigo-600 ring-1 ring-indigo-500/20 dark:bg-indigo-400/14 dark:text-indigo-300",
  },
  device: {
    label: "preferences.scope.device",
    hint: "preferences.scope.deviceHint",
    icon: MonitorSmartphone,
    tone: "bg-sky-500/12 text-sky-700 ring-1 ring-sky-500/20 dark:bg-sky-400/14 dark:text-sky-300",
  },
  admin: {
    label: "preferences.scope.admin",
    hint: "preferences.scope.adminHint",
    icon: ShieldCheck,
    tone: "bg-amber-500/12 text-amber-700 ring-1 ring-amber-500/20 dark:bg-amber-400/14 dark:text-amber-300",
  },
};

export function ScopeBadge({ scope }: { scope: PreferenceScope }) {
  const { t } = useTranslation();
  const copy = SCOPE_COPY[scope];
  const Icon = copy.icon;
  return (
    <span
      data-preference-scope={scope}
      title={t(copy.hint)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
        copy.tone,
      )}
    >
      <Icon size={11} aria-hidden="true" />
      {t(copy.label)}
    </span>
  );
}

const rowHover = "transition-colors hover:bg-app-hover/65";
const rowFocus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary/50";

export function PreferenceGroup({
  title,
  scope,
  footer,
  children,
}: {
  title?: string;
  scope?: PreferenceScope;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={title ? headingId : undefined} className="space-y-2">
      {(title || scope) && (
        <div className="flex min-h-5 items-center justify-between gap-3 px-1">
          {title ? (
            <h4 id={headingId} className="text-xs font-semibold tracking-tight text-tx-secondary">{title}</h4>
          ) : <span />}
          {scope && <ScopeBadge scope={scope} />}
        </div>
      )}
      <div className="divide-y divide-app-border/65 overflow-hidden rounded-2xl border border-app-border/80 bg-app-elevated/80 shadow-xs backdrop-blur-sm">
        {children}
      </div>
      {footer && <p className="px-1.5 text-xs leading-5 text-tx-tertiary">{footer}</p>}
    </section>
  );
}

function RowText({
  titleId,
  descriptionId,
  title,
  description,
  scope,
  busy,
}: {
  titleId: string;
  descriptionId: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  scope?: PreferenceScope;
  busy?: boolean;
}) {
  return (
    <span className="block min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span id={titleId} className="text-sm font-medium text-tx-primary">{title}</span>
        {scope && <ScopeBadge scope={scope} />}
        {busy && <Loader2 size={12} className="animate-spin text-accent-primary" aria-hidden="true" />}
      </span>
      {description && (
        <span id={descriptionId} className="mt-0.5 block text-xs leading-5 text-tx-secondary">
          {description}
        </span>
      )}
    </span>
  );
}

interface RowBaseProps {
  /** Search target: matches `data-preference-id`. */
  anchorId?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Per-row scope, only when it differs from the group's scope. */
  scope?: PreferenceScope;
}

/** The whole row toggles the switch; the switch keeps native checkbox keyboard behavior. */
export function SwitchRow({
  anchorId,
  title,
  description,
  scope,
  checked,
  onChange,
  disabled,
  busy,
}: RowBaseProps & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const inactive = disabled || busy;
  return (
    <label
      data-preference-id={anchorId}
      className={cn(
        "flex min-h-[3.5rem] items-center gap-4 px-4 py-3",
        inactive ? "cursor-not-allowed" : cn("cursor-pointer", rowHover),
        disabled && "opacity-60",
      )}
    >
      <RowText titleId={titleId} descriptionId={descriptionId} title={title} description={description} scope={scope} busy={busy} />
      <span className="relative inline-flex shrink-0 items-center">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={inactive}
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          onChange={(event) => onChange(event.target.checked)}
          className="peer sr-only"
        />
        <span className="h-6 w-11 rounded-full bg-app-border transition-colors peer-checked:bg-gradient-to-r peer-checked:from-sky-500 peer-checked:to-indigo-500 peer-focus-visible:ring-2 peer-focus-visible:ring-accent-primary peer-focus-visible:ring-offset-1" />
        <span className="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
}

/** Single choice with radio semantics: Tab enters the group, arrow keys move and select. */
function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  labelledBy,
  describedBy,
}: {
  value: T;
  options: ReadonlyArray<ChoiceOption<T>>;
  onChange: (value: T) => void;
  labelledBy?: string;
  describedBy?: string;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  const selectAt = (index: number) => {
    const wrapped = (index + options.length) % options.length;
    onChange(options[wrapped].value);
    buttons.current[wrapped]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      Home: 0,
      End: options.length - 1,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    selectAt(moves[event.key]);
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="grid shrink-0 auto-cols-fr grid-flow-col gap-1 rounded-xl border border-app-border/75 bg-app-bg/75 p-1 max-sm:w-full"
    >
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={option.value}
            ref={(element) => { buttons.current[index] = element; }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              "min-h-8 whitespace-nowrap rounded-lg px-3 text-xs font-medium transition-all active:scale-95",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50",
              selected
                ? "bg-app-surface font-semibold text-accent-primary shadow-xs ring-1 ring-app-border/75"
                : "text-tx-secondary hover:text-tx-primary",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function SegmentedRow<T extends string>({
  anchorId,
  title,
  description,
  scope,
  value,
  options,
  onChange,
}: RowBaseProps & {
  value: T;
  options: ReadonlyArray<ChoiceOption<T>>;
  onChange: (value: T) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <div data-preference-id={anchorId} className="flex flex-col gap-2.5 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
      <RowText titleId={titleId} descriptionId={descriptionId} title={title} description={description} scope={scope} />
      <SegmentedControl
        value={value}
        options={options}
        onChange={onChange}
        labelledBy={titleId}
        describedBy={description ? descriptionId : undefined}
      />
    </div>
  );
}

/** Used when the options are too long for a segmented control. */
export function SelectRow<T extends string>({
  anchorId,
  title,
  description,
  scope,
  value,
  options,
  onChange,
}: RowBaseProps & {
  value: T;
  options: ReadonlyArray<ChoiceOption<T>>;
  onChange: (value: T) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <div data-preference-id={anchorId} className="flex flex-col gap-2.5 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
      <RowText titleId={titleId} descriptionId={descriptionId} title={title} description={description} scope={scope} />
      <div className="relative shrink-0 max-sm:w-full">
        <select
          value={value}
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          onChange={(event) => onChange(event.target.value as T)}
          className={cn(
            "h-9 w-full cursor-pointer appearance-none rounded-xl border border-app-border/80 bg-app-surface pl-3 pr-8 text-sm text-tx-primary outline-none transition-all sm:w-auto sm:min-w-[9.5rem]",
            "hover:border-accent-primary/40 focus-visible:border-accent-primary focus-visible:ring-2 focus-visible:ring-accent-primary/20",
          )}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-tx-tertiary" />
      </div>
    </div>
  );
}

/** A row that opens another page or settings tab. */
export function LinkRow({
  anchorId,
  icon: Icon,
  title,
  description,
  scope,
  trailing,
  onClick,
  onKeyDown,
  dataAttributes,
}: RowBaseProps & {
  icon?: LucideIcon;
  trailing?: React.ReactNode;
  onClick: () => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  dataAttributes?: Record<`data-${string}`, string>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const trailingId = useId();
  const describedBy = [description ? descriptionId : "", trailing ? trailingId : ""].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      data-preference-id={anchorId}
      onClick={onClick}
      onKeyDown={onKeyDown}
      aria-labelledby={titleId}
      aria-describedby={describedBy || undefined}
      className={cn("group flex min-h-[3.5rem] w-full items-center gap-3 px-4 py-3 text-left", rowHover, rowFocus)}
      {...dataAttributes}
    >
      {Icon && (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500/14 via-cyan-400/12 to-indigo-500/14 text-sky-600 ring-1 ring-sky-500/20 transition-transform duration-200 group-hover:-rotate-6 group-hover:scale-105 dark:text-sky-300">
          <Icon size={16} aria-hidden="true" />
        </span>
      )}
      <RowText titleId={titleId} descriptionId={descriptionId} title={title} description={description} scope={scope} />
      {trailing && (
        <span id={trailingId} className="shrink-0 rounded-full bg-accent-primary/10 px-2.5 py-0.5 text-xs font-medium text-accent-primary">
          {trailing}
        </span>
      )}
      <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-tx-tertiary transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-accent-primary" />
    </button>
  );
}

/** Low-frequency options stay folded until needed. */
export function DisclosureRow({
  anchorId,
  title,
  summary,
  open,
  onOpenChange,
  children,
}: {
  anchorId?: string;
  title: string;
  summary?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const panelId = useId();
  return (
    <div data-preference-id={anchorId}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpenChange(!open)}
        className={cn("flex min-h-[3.5rem] w-full items-center gap-3 px-4 py-3 text-left", rowHover, rowFocus)}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-tx-primary">{title}</span>
          {summary && <span className="mt-0.5 block truncate text-xs text-tx-secondary">{summary}</span>}
        </span>
        <ChevronDown size={16} aria-hidden="true" className={cn("shrink-0 text-tx-tertiary transition-transform duration-200", open && "rotate-180 text-accent-primary")} />
      </button>
      {open && (
        <div id={panelId} className="divide-y divide-app-border/65 border-t border-app-border/65 bg-app-bg/50">
          {children}
        </div>
      )}
    </div>
  );
}

export function SubpageHeader({
  title,
  description,
  scope,
  onBack,
  headingRef,
}: {
  title: string;
  description?: string;
  scope?: PreferenceScope;
  onBack: () => void;
  headingRef: React.Ref<HTMLHeadingElement>;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        aria-label={t("preferences.backLabel")}
        data-preferences-back=""
        className="inline-flex min-h-8 items-center gap-1 rounded-full border border-app-border/75 bg-app-elevated/80 px-3 py-1 text-xs font-medium text-tx-secondary shadow-xs transition-all hover:border-accent-primary/35 hover:bg-app-surface hover:text-tx-primary active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
      >
        <ChevronLeft size={14} aria-hidden="true" />
        {t("preferences.back")}
      </button>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 ref={headingRef} tabIndex={-1} className="text-lg font-bold tracking-tight text-tx-primary outline-none">{title}</h3>
          {scope && <ScopeBadge scope={scope} />}
        </div>
        {description && <p className="mt-1 text-xs leading-5 text-tx-secondary">{description}</p>}
      </div>
    </div>
  );
}
