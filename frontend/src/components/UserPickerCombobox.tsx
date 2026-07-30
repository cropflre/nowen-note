import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, X } from "lucide-react";

import { api } from "@/lib/api";
import type { UserPublicInfo } from "@/types";

interface Props {
  value: UserPublicInfo | null;
  onChange: (user: UserPublicInfo | null) => void;
  disabledUserLabels?: Record<string, string>;
  placeholder?: string;
  autoFocus?: boolean;
  idPrefix?: string;
}

const EMPTY_DISABLED_USER_LABELS: Record<string, string> = {};

function userName(user: UserPublicInfo): string {
  return user.displayName || user.username;
}

export default function UserPickerCombobox({
  value,
  onChange,
  disabledUserLabels = EMPTY_DISABLED_USER_LABELS,
  placeholder = "搜索用户名、显示名或邮箱",
  autoFocus = false,
  idPrefix = "user-picker",
}: Props) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<UserPublicInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [focusInput, setFocusInput] = useState(autoFocus);

  const selectableIndexes = useMemo(
    () => candidates
      .map((user, index) => ({ user, index }))
      .filter(({ user }) => !disabledUserLabels[user.id])
      .map(({ index }) => index),
    [candidates, disabledUserLabels],
  );

  useEffect(() => {
    if (!open || value) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setCandidates([]);
    setActiveIndex(-1);
    const timer = window.setTimeout(() => {
      api.searchUsers(query.trim() || undefined)
        .then((users) => {
          if (cancelled) return;
          setCandidates(users);
          setActiveIndex(users.findIndex((user) => !disabledUserLabels[user.id]));
        })
        .catch((nextError: any) => {
          if (cancelled) return;
          setCandidates([]);
          setError(nextError?.message || "加载人员失败，请重试");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, query.trim() ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [disabledUserLabels, open, query, value]);

  function selectUser(user: UserPublicInfo) {
    if (disabledUserLabels[user.id]) return;
    onChange(user);
    setOpen(false);
    setFocusInput(false);
    setActiveIndex(-1);
  }

  function moveActive(direction: 1 | -1) {
    if (selectableIndexes.length === 0) return;
    const currentPosition = selectableIndexes.indexOf(activeIndex);
    const nextPosition = currentPosition < 0
      ? (direction === 1 ? 0 : selectableIndexes.length - 1)
      : (currentPosition + direction + selectableIndexes.length) % selectableIndexes.length;
    setActiveIndex(selectableIndexes[nextPosition]);
  }

  function clearSelection() {
    onChange(null);
    setQuery("");
    setCandidates([]);
    setOpen(true);
    setFocusInput(true);
    setActiveIndex(-1);
  }

  const listboxId = `${idPrefix}-options`;

  return (
    <div className="relative min-w-0">
      {value ? (
        <div className="flex h-10 items-center gap-2 rounded-lg border border-accent-primary bg-app-bg px-2.5">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-primary/10 text-xs font-semibold text-accent-primary">
            {value.avatarUrl
              ? <img src={value.avatarUrl} alt="" className="h-full w-full object-cover" />
              : userName(value).slice(0, 1).toLocaleUpperCase()}
          </div>
          <div className="min-w-0 flex-1 truncate text-sm text-tx-primary">
            {userName(value)}
            {value.displayName && <span className="ml-1.5 text-xs text-tx-tertiary">@{value.username}</span>}
          </div>
          <button
            type="button"
            onClick={clearSelection}
            className="rounded p-1 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
            aria-label={`取消选择 ${userName(value)}`}
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="flex h-10 items-center gap-2 rounded-lg border border-app-border bg-app-bg px-3 focus-within:border-accent-primary focus-within:ring-2 focus-within:ring-accent-primary/15">
          <Search size={15} className="shrink-0 text-tx-tertiary" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCandidates([]);
              setActiveIndex(-1);
              setOpen(true);
            }}
            onFocus={() => {
              setOpen(true);
              setFocusInput(false);
            }}
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(true);
                moveActive(1);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(true);
                moveActive(-1);
                return;
              }
              if (event.key === "Escape" && open) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                const candidate = candidates[activeIndex];
                if (candidate) selectUser(candidate);
              }
            }}
            placeholder={placeholder}
            autoFocus={focusInput}
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={open && activeIndex >= 0
              ? `${idPrefix}-option-${candidates[activeIndex]?.id}`
              : undefined}
            className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary"
          />
          {loading && <Loader2 size={15} className="shrink-0 animate-spin text-tx-tertiary" />}
          {query && !loading && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setQuery("")}
              className="rounded p-1 text-tx-tertiary hover:bg-app-hover"
              aria-label="清空人员搜索"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {!value && open && (
        <div id={listboxId} role="listbox" className="absolute left-0 right-0 top-11 z-30 max-h-60 overflow-y-auto rounded-xl border border-app-border bg-app-surface py-1 shadow-xl">
          {loading && candidates.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-tx-tertiary">
              <Loader2 size={16} className="animate-spin" />正在加载人员
            </div>
          ) : error ? (
            <div className="px-3 py-6 text-center text-sm text-red-500">{error}</div>
          ) : candidates.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-tx-tertiary">没有找到匹配人员</div>
          ) : candidates.map((user, index) => {
            const unavailableLabel = disabledUserLabels[user.id];
            const unavailable = Boolean(unavailableLabel);
            return (
              <button
                key={user.id}
                id={`${idPrefix}-option-${user.id}`}
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                disabled={unavailable}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => { if (!unavailable) setActiveIndex(index); }}
                onClick={() => selectUser(user)}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50 ${activeIndex === index ? "bg-app-hover" : "hover:bg-app-hover"}`}
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-primary/10 text-xs font-semibold text-accent-primary">
                  {user.avatarUrl
                    ? <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
                    : userName(user).slice(0, 1).toLocaleUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-tx-primary">{userName(user)}</div>
                  <div className="truncate text-xs text-tx-tertiary">@{user.username}</div>
                </div>
                <span className={unavailable ? "text-xs text-tx-tertiary" : "text-xs font-medium text-accent-primary"}>
                  {unavailableLabel || "选择"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
