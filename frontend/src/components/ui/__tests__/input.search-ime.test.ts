import { describe, expect, it } from "vitest"
import {
  shouldApplySidebarSearchSync,
  shouldForwardSidebarSearchChange,
  SIDEBAR_SEARCH_COMMIT_DELAY_MS,
} from "@/components/ui/input"
import {
  emitSidebarSearchChange,
  emitSidebarSearchPending,
  emitSidebarSearchSync,
  getCurrentSidebarSearchPending,
  getCurrentSidebarSearchValue,
  normalizeSidebarSearchPending,
  normalizeSidebarSearchValue,
} from "@/lib/sidebarSearchBridge"

type NativeEventShape = Parameters<typeof shouldForwardSidebarSearchChange>[0]

function eventOf(values: Partial<NativeEventShape>): NativeEventShape {
  return values as NativeEventShape
}

describe("sidebar search IME event routing", () => {
  it("does not forward intermediate composition input", () => {
    expect(shouldForwardSidebarSearchChange(
      eventOf({ isTrusted: true, isComposing: true }),
      true,
    )).toBe(false)
  })

  it("forwards normal trusted user input", () => {
    expect(shouldForwardSidebarSearchChange(
      eventOf({ isTrusted: true, isComposing: false }),
      false,
    )).toBe(true)
  })

  it("ignores untrusted programmatic synchronization from SearchCenter", () => {
    expect(shouldForwardSidebarSearchChange(
      eventOf({ isTrusted: false, isComposing: false }),
      false,
    )).toBe(false)
  })

  it("buffers ordinary input briefly instead of invalidating the app tree per keypress", () => {
    expect(SIDEBAR_SEARCH_COMMIT_DELAY_MS).toBeGreaterThanOrEqual(150)
    expect(SIDEBAR_SEARCH_COMMIT_DELAY_MS).toBeLessThanOrEqual(300)
  })

  it("does not let an older global sync overwrite a newer locally buffered value", () => {
    expect(shouldApplySidebarSearchSync("cod", "code", true, false)).toBe(false)
    expect(shouldApplySidebarSearchSync("code", "code", true, false)).toBe(true)
    expect(shouldApplySidebarSearchSync("external", null, false, false)).toBe(true)
    expect(shouldApplySidebarSearchSync("中文", "中文", true, true)).toBe(false)
  })

  it("reads only valid sidebar bridge payloads", () => {
    expect(normalizeSidebarSearchValue({ value: "我" })).toBe("我")
    expect(normalizeSidebarSearchValue({ value: "" })).toBe("")
    expect(normalizeSidebarSearchValue({ value: 1 })).toBeNull()
    expect(normalizeSidebarSearchValue(null)).toBeNull()

    expect(normalizeSidebarSearchPending({ pending: true })).toBe(true)
    expect(normalizeSidebarSearchPending({ pending: false })).toBe(false)
    expect(normalizeSidebarSearchPending({ pending: "yes" })).toBeNull()
    expect(normalizeSidebarSearchPending(null)).toBeNull()
  })

  it("retains the latest query and pending state for sidebar remounts", () => {
    emitSidebarSearchSync("移动端搜索")
    expect(getCurrentSidebarSearchValue()).toBe("移动端搜索")

    emitSidebarSearchPending(true)
    expect(getCurrentSidebarSearchPending()).toBe(true)
    emitSidebarSearchPending(false)
    expect(getCurrentSidebarSearchPending()).toBe(false)

    emitSidebarSearchChange("")
    expect(getCurrentSidebarSearchValue()).toBe("")
  })

  it("installs a spinner animation that combines centering and rotation", () => {
    emitSidebarSearchPending(true)
    const style = document.getElementById("nowen-sidebar-search-spinner-style")
    expect(style?.textContent).toContain("translateY(-50%) rotate(360deg)")
    expect(style?.textContent).toContain("nowen-sidebar-search-spin")
    emitSidebarSearchPending(false)
  })
})
