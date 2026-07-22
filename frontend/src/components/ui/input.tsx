import * as React from "react"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  emitSidebarSearchChange,
  emitSidebarSearchPending,
  getCurrentSidebarSearchPending,
  getCurrentSidebarSearchValue,
  normalizeSidebarSearchPending,
  normalizeSidebarSearchValue,
  SIDEBAR_SEARCH_PENDING_EVENT,
  SIDEBAR_SEARCH_SYNC_EVENT,
} from "@/lib/sidebarSearchBridge"

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const SIDEBAR_SEARCH_COMMIT_DELAY_MS = 220

const SIDEBAR_SEARCH_FOCUS_RESTORE_DELAY_MS = 60

type SearchNativeEvent = Event & {
  isComposing?: boolean
}

export function shouldForwardSidebarSearchChange(
  nativeEvent: SearchNativeEvent,
  composing: boolean,
): boolean {
  return !composing
    && nativeEvent.isComposing !== true
    && nativeEvent.isTrusted === true
}

export function shouldApplySidebarSearchSync(
  nextValue: string,
  pendingValue: string | null,
  hasPendingCommit: boolean,
  composing: boolean,
): boolean {
  if (composing) return false
  return !hasPendingCommit || pendingValue === nextValue
}

function normalizeInputValue(value: InputProps["value"] | InputProps["defaultValue"]): string {
  if (Array.isArray(value)) return value.join(",")
  return value == null ? "" : String(value)
}

function assignForwardedRef(
  ref: React.ForwardedRef<HTMLInputElement>,
  value: HTMLInputElement | null,
): void {
  if (typeof ref === "function") {
    ref(value)
  } else if (ref) {
    ref.current = value
  }
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      type,
      value,
      defaultValue,
      onChange,
      onCompositionStart,
      onCompositionEnd,
      onBlur,
      onKeyDown,
      ...props
    },
    ref,
  ) => {
    const isSidebarSearch = Object.prototype.hasOwnProperty.call(props, "data-sidebar-search")
    const inputRef = React.useRef<HTMLInputElement | null>(null)
    const composingRef = React.useRef(false)
    const awaitingCompositionCommitRef = React.useRef(false)
    const suppressTrustedDuplicateRef = React.useRef<string | null>(null)
    const pendingCommitTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
    const pendingValueRef = React.useRef<string | null>(null)
    const restoreFocusRef = React.useRef(false)
    const [sidebarValue, setSidebarValue] = React.useState(() =>
      isSidebarSearch
        ? getCurrentSidebarSearchValue()
        : normalizeInputValue(value ?? defaultValue),
    )
    const [searchPending, setSearchPending] = React.useState(() =>
      isSidebarSearch && getCurrentSidebarSearchPending(),
    )

    const setInputRef = React.useCallback((node: HTMLInputElement | null) => {
      inputRef.current = node
      assignForwardedRef(ref, node)
    }, [ref])

    const clearPendingCommitTimer = React.useCallback(() => {
      if (pendingCommitTimerRef.current === null) return
      clearTimeout(pendingCommitTimerRef.current)
      pendingCommitTimerRef.current = null
    }, [])

    const markSearchPending = React.useCallback((pending: boolean) => {
      setSearchPending(pending)
      emitSidebarSearchPending(pending)
    }, [])

    const restoreSidebarFocus = React.useCallback(() => {
      if (!restoreFocusRef.current || typeof window === "undefined") return
      window.setTimeout(() => {
        const input = inputRef.current
        if (!input?.isConnected) return
        const active = document.activeElement
        const searchCenterTookFocus = active instanceof HTMLElement
          && !!active.closest('[data-swipe-blocker="search-center"]')
        if (active === document.body || searchCenterTookFocus) {
          input.focus({ preventScroll: true })
          const length = input.value.length
          input.setSelectionRange(length, length)
        }
      }, SIDEBAR_SEARCH_FOCUS_RESTORE_DELAY_MS)
    }, [])

    const flushSidebarSearch = React.useCallback((nextValue?: string) => {
      clearPendingCommitTimer()
      const committedValue = nextValue ?? pendingValueRef.current
      pendingValueRef.current = null
      if (committedValue == null) return
      markSearchPending(false)
      emitSidebarSearchChange(committedValue)
      restoreSidebarFocus()
    }, [clearPendingCommitTimer, markSearchPending, restoreSidebarFocus])

    const scheduleSidebarSearch = React.useCallback((nextValue: string) => {
      clearPendingCommitTimer()
      pendingValueRef.current = nextValue
      markSearchPending(true)

      // Clearing search is an explicit navigation action and should feel immediate. Normal typing is
      // buffered so the giant Sidebar/AppContext tree is not invalidated for every single keypress.
      if (!nextValue) {
        flushSidebarSearch(nextValue)
        return
      }

      pendingCommitTimerRef.current = setTimeout(() => {
        pendingCommitTimerRef.current = null
        flushSidebarSearch(nextValue)
      }, SIDEBAR_SEARCH_COMMIT_DELAY_MS)
    }, [clearPendingCommitTimer, flushSidebarSearch, markSearchPending])

    React.useEffect(() => {
      if (!isSidebarSearch || typeof window === "undefined") return

      const handleSync = (event: Event) => {
        const nextValue = normalizeSidebarSearchValue((event as CustomEvent<unknown>).detail)
        if (nextValue == null) return
        if (!shouldApplySidebarSearchSync(
          nextValue,
          pendingValueRef.current,
          pendingCommitTimerRef.current !== null,
          composingRef.current,
        )) return

        awaitingCompositionCommitRef.current = false
        suppressTrustedDuplicateRef.current = null
        if (pendingValueRef.current === nextValue) {
          clearPendingCommitTimer()
          pendingValueRef.current = null
          markSearchPending(false)
        }
        setSidebarValue(nextValue)
      }

      const handlePending = (event: Event) => {
        const pending = normalizeSidebarSearchPending((event as CustomEvent<unknown>).detail)
        if (pending != null) setSearchPending(pending)
      }

      window.addEventListener(SIDEBAR_SEARCH_SYNC_EVENT, handleSync)
      window.addEventListener(SIDEBAR_SEARCH_PENDING_EVENT, handlePending)
      return () => {
        window.removeEventListener(SIDEBAR_SEARCH_SYNC_EVENT, handleSync)
        window.removeEventListener(SIDEBAR_SEARCH_PENDING_EVENT, handlePending)
      }
    }, [clearPendingCommitTimer, isSidebarSearch, markSearchPending])

    React.useEffect(() => () => {
      clearPendingCommitTimer()
      if (isSidebarSearch) emitSidebarSearchPending(false)
    }, [clearPendingCommitTimer, isSidebarSearch])

    const handleChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
      if (!isSidebarSearch) {
        onChange?.(event)
        return
      }

      const nextValue = event.currentTarget.value
      const nativeEvent = event.nativeEvent as SearchNativeEvent
      setSidebarValue(nextValue)

      // SearchCenter mirrors the visible sidebar field with an untrusted native input event. It may
      // update presentation, but it must never execute Sidebar's legacy navigation branch.
      if (!shouldForwardSidebarSearchChange(nativeEvent, composingRef.current)) return

      if (suppressTrustedDuplicateRef.current === nextValue) {
        suppressTrustedDuplicateRef.current = null
        awaitingCompositionCommitRef.current = false
        return
      }

      awaitingCompositionCommitRef.current = false
      restoreFocusRef.current = document.activeElement === event.currentTarget
      scheduleSidebarSearch(nextValue)
    }, [isSidebarSearch, onChange, scheduleSidebarSearch])

    const handleCompositionStart = React.useCallback((event: React.CompositionEvent<HTMLInputElement>) => {
      if (isSidebarSearch) {
        composingRef.current = true
        awaitingCompositionCommitRef.current = false
        suppressTrustedDuplicateRef.current = null
        clearPendingCommitTimer()
        pendingValueRef.current = null
        markSearchPending(false)
      }
      onCompositionStart?.(event)
    }, [clearPendingCommitTimer, isSidebarSearch, markSearchPending, onCompositionStart])

    const handleCompositionEnd = React.useCallback((event: React.CompositionEvent<HTMLInputElement>) => {
      if (isSidebarSearch) {
        const input = event.currentTarget
        composingRef.current = false
        awaitingCompositionCommitRef.current = true
        setSidebarValue(input.value)
        restoreFocusRef.current = document.activeElement === input

        // Most Chromium builds emit a final trusted input after compositionend. Some Android and
        // Windows IMEs do not, so schedule once in a microtask and suppress a late duplicate.
        void Promise.resolve().then(() => {
          if (!awaitingCompositionCommitRef.current || !input.isConnected) return
          awaitingCompositionCommitRef.current = false
          suppressTrustedDuplicateRef.current = input.value
          scheduleSidebarSearch(input.value)
        })
      }
      onCompositionEnd?.(event)
    }, [isSidebarSearch, onCompositionEnd, scheduleSidebarSearch])

    const handleBlur = React.useCallback((event: React.FocusEvent<HTMLInputElement>) => {
      if (isSidebarSearch && pendingCommitTimerRef.current !== null) {
        flushSidebarSearch(event.currentTarget.value)
      }
      onBlur?.(event)
    }, [flushSidebarSearch, isSidebarSearch, onBlur])

    const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
      if (isSidebarSearch && event.key === "Enter" && pendingCommitTimerRef.current !== null) {
        flushSidebarSearch(event.currentTarget.value)
      }
      onKeyDown?.(event)
    }, [flushSidebarSearch, isSidebarSearch, onKeyDown])

    const input = (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-app-border bg-app-surface px-3 py-1 text-sm text-tx-primary shadow-sm transition-colors placeholder:text-tx-tertiary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary disabled:cursor-not-allowed disabled:opacity-50",
          isSidebarSearch && "pr-8",
          className,
        )}
        ref={setInputRef}
        {...props}
        {...(isSidebarSearch
          ? { value: sidebarValue }
          : value !== undefined
            ? { value }
            : { defaultValue })}
        aria-busy={isSidebarSearch ? searchPending : props["aria-busy"]}
        onChange={handleChange}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
    )

    if (!isSidebarSearch) return input

    return (
      <>
        {input}
        {searchPending && (
          <Loader2
            data-sidebar-search-loading=""
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-accent-primary"
          />
        )}
      </>
    )
  },
)
Input.displayName = "Input"

export { Input }
