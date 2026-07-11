import * as React from "react"
import { cn } from "@/lib/utils"

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const SIDEBAR_SEARCH_IME_COMMIT = "__nowenSidebarSearchImeCommit"

type SearchNativeEvent = Event & {
  isComposing?: boolean
  [SIDEBAR_SEARCH_IME_COMMIT]?: boolean
}

export function shouldForwardSidebarSearchChange(
  nativeEvent: SearchNativeEvent,
  composing: boolean,
): boolean {
  if (composing || nativeEvent.isComposing === true) return false
  if (nativeEvent[SIDEBAR_SEARCH_IME_COMMIT] === true) return true
  return nativeEvent.isTrusted === true
}

function normalizeInputValue(value: InputProps["value"] | InputProps["defaultValue"]): string {
  if (Array.isArray(value)) return value.join(",")
  return value == null ? "" : String(value)
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
      ...props
    },
    ref,
  ) => {
    const isSidebarSearch = Object.prototype.hasOwnProperty.call(props, "data-sidebar-search")
    const composingRef = React.useRef(false)
    const awaitingCompositionCommitRef = React.useRef(false)
    const suppressTrustedDuplicateRef = React.useRef<string | null>(null)
    const [sidebarValue, setSidebarValue] = React.useState(() =>
      normalizeInputValue(value ?? defaultValue),
    )

    React.useEffect(() => {
      if (!isSidebarSearch || composingRef.current) return
      setSidebarValue(normalizeInputValue(value ?? defaultValue))
    }, [defaultValue, isSidebarSearch, value])

    const handleChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
      if (!isSidebarSearch) {
        onChange?.(event)
        return
      }

      const nextValue = event.currentTarget.value
      const nativeEvent = event.nativeEvent as SearchNativeEvent
      setSidebarValue(nextValue)

      // SearchCenter synchronizes the mounted sidebar input with an untrusted input event.
      // It must update only the visible value: forwarding it to Sidebar's onChange would
      // turn an empty query into viewMode="all" and make the search page disappear.
      if (!shouldForwardSidebarSearchChange(nativeEvent, composingRef.current)) {
        if (nativeEvent.isTrusted === false) {
          suppressTrustedDuplicateRef.current = null
        }
        return
      }

      if (
        nativeEvent.isTrusted === true
        && suppressTrustedDuplicateRef.current === nextValue
      ) {
        suppressTrustedDuplicateRef.current = null
        awaitingCompositionCommitRef.current = false
        return
      }

      awaitingCompositionCommitRef.current = false
      onChange?.(event)
    }, [isSidebarSearch, onChange])

    const handleCompositionStart = React.useCallback((event: React.CompositionEvent<HTMLInputElement>) => {
      if (isSidebarSearch) {
        composingRef.current = true
        awaitingCompositionCommitRef.current = false
        suppressTrustedDuplicateRef.current = null
      }
      onCompositionStart?.(event)
    }, [isSidebarSearch, onCompositionStart])

    const handleCompositionEnd = React.useCallback((event: React.CompositionEvent<HTMLInputElement>) => {
      if (isSidebarSearch) {
        const input = event.currentTarget
        const compositionEvent = event
        composingRef.current = false
        awaitingCompositionCommitRef.current = true
        setSidebarValue(input.value)

        // Chromium normally emits one final trusted input event after compositionend.
        // Some Windows IME / Electron combinations do not, and React's value tracker can
        // also ignore a synthetic DOM input whose value did not change. Commit through the
        // original controlled callback as a Promise microtask fallback. A later trusted
        // duplicate with the same value is suppressed.
        void Promise.resolve().then(() => {
          if (!awaitingCompositionCommitRef.current || !input.isConnected) return
          awaitingCompositionCommitRef.current = false
          suppressTrustedDuplicateRef.current = input.value
          const commitEvent = {
            target: input,
            currentTarget: input,
            nativeEvent: {
              isTrusted: false,
              isComposing: false,
              [SIDEBAR_SEARCH_IME_COMMIT]: true,
            },
            type: "change",
            bubbles: true,
            cancelable: true,
            defaultPrevented: false,
            eventPhase: compositionEvent.eventPhase,
            isTrusted: false,
            timeStamp: compositionEvent.timeStamp,
            preventDefault: () => compositionEvent.preventDefault(),
            isDefaultPrevented: () => compositionEvent.isDefaultPrevented(),
            stopPropagation: () => compositionEvent.stopPropagation(),
            isPropagationStopped: () => compositionEvent.isPropagationStopped(),
            persist: () => undefined,
          } as unknown as React.ChangeEvent<HTMLInputElement>
          onChange?.(commitEvent)
        })
      }
      onCompositionEnd?.(event)
    }, [isSidebarSearch, onChange, onCompositionEnd])

    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-app-border bg-app-surface px-3 py-1 text-sm text-tx-primary shadow-sm transition-colors placeholder:text-tx-tertiary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
        {...(isSidebarSearch
          ? { value: sidebarValue }
          : value !== undefined
            ? { value }
            : { defaultValue })}
        onChange={handleChange}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
      />
    )
  },
)
Input.displayName = "Input"

export { Input }
