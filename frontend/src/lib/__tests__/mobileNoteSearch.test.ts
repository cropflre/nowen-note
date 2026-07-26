/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OPEN_COMMAND_PALETTE_EVENT,
  openMobileNoteSearch,
} from "@/lib/mobileNoteSearch";

describe("openMobileNoteSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes the mobile drawer before opening global note search", () => {
    const closeSidebar = vi.fn();
    const openSearch = vi.fn();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, openSearch);

    openMobileNoteSearch(closeSidebar);

    expect(closeSidebar).toHaveBeenCalledTimes(1);
    expect(openSearch).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(openSearch).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, openSearch);
  });
});
