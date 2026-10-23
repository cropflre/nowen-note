import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_HOLIDAY_YEARS, getHolidayDay, isHolidayDateKey, parseHolidayYear, HOLIDAY_UPDATE_BASE } from "../holidayCalendar";
import { createHolidayCalendarStore, HOLIDAY_CACHE_PREFIX, HOLIDAY_ENABLED_KEY } from "../holidayCalendarStore";

const bundled = BUNDLED_HOLIDAY_YEARS[2026];
const update = () => ({ ...bundled, revision: 2, days: { ...bundled.days, "2026-10-08": { type: "holiday", name: "nationalDay" } } });
const respond = (data: unknown) => new Response(JSON.stringify(data));

describe("holiday date data", () => {
  it("matches all confirmed 2026 holiday intervals and adjusted working days", () => {
    for (const [start, end, name] of [
      ["01-01", "01-03", "newYear"], ["02-15", "02-23", "springFestival"], ["04-04", "04-06", "qingming"],
      ["05-01", "05-05", "labourDay"], ["06-19", "06-21", "dragonBoat"], ["09-25", "09-27", "midAutumn"], ["10-01", "10-07", "nationalDay"],
    ]) {
      for (let day = Number(start.slice(3)); day <= Number(end.slice(3)); day++) {
        expect(getHolidayDay(`2026-${start.slice(0, 2)}-${String(day).padStart(2, "0")}`, BUNDLED_HOLIDAY_YEARS)).toEqual({ type: "holiday", name });
      }
    }
    const workDays = Object.entries(bundled.days).filter(([, day]) => day.type === "makeup-workday").map(([key]) => key);
    expect(workDays).toEqual(["2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"]);
    expect(Object.keys(bundled.days)).toHaveLength(39);
    expect(getHolidayDay("2026-10-08", BUNDLED_HOLIDAY_YEARS)).toBeUndefined();
    expect(getHolidayDay("2027-10-01", BUNDLED_HOLIDAY_YEARS)).toBeUndefined();
  });

  it("uses strict date-only keys, including leap years", () => {
    expect(isHolidayDateKey("2028-02-29", 2028)).toBe(true);
    for (const key of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-10-00", "2026-10-1", "2026-10-01T00:00:00Z"]) {
      expect(isHolidayDateKey(key, 2026)).toBe(false);
    }
    expect(isHolidayDateKey("2026-10-01", 2027)).toBe(false);
  });

  it.each([
    { schemaVersion: 2 }, { region: "US" }, { year: 2027 }, { revision: 0 },
    { days: {} }, { days: { "2026-02-30": { type: "holiday", name: "newYear" } } },
    { days: { "2026-10-01": { type: "task", name: "nationalDay" } } },
    { days: { "2026-10-01": { type: "holiday", name: "<script>" } } },
    { sourceUrl: "javascript:alert(1)" }, { sourceUrl: "https://gov.cn.evil.test/notice" },
    { sourceUrl: "https://user:password@www.gov.cn/notice" },
  ])("rejects invalid updates: %j", (patch) => {
    expect(() => parseHolidayYear(JSON.stringify({ ...bundled, ...patch }), 2026)).toThrow();
  });
});

describe("holiday update store", () => {
  beforeEach(() => { localStorage.clear(); vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("makes no requests and hides all markers until enabled", async () => {
    const store = createHolidayCalendarStore();
    await store.refresh(2026, true);
    expect(fetch).not.toHaveBeenCalled();
    expect(store.getDay("2026-10-01")).toBeUndefined();
    store.setEnabled(true);
    expect(store.getDay("2026-10-01")?.type).toBe("holiday");
    expect(localStorage.getItem(HOLIDAY_ENABLED_KEY)).toBe("true");
  });

  it("deduplicates requests, restricts the URL and credentials, and restores newer cached data after restart", async () => {
    const store = createHolidayCalendarStore();
    store.setEnabled(true);
    vi.mocked(fetch).mockResolvedValue(respond(update()));
    const first = store.refresh(2026);
    expect(store.refresh(2026)).toBe(first);
    await first;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`${HOLIDAY_UPDATE_BASE}cn-2026.json`, expect.objectContaining({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }));
    expect(store.getDay("2026-10-08")?.type).toBe("holiday");
    const restarted = createHolidayCalendarStore();
    expect(restarted.getYear(2026).origin).toBe("cached");
    expect(restarted.getDay("2026-10-08")?.type).toBe("holiday");
    await restarted.refresh(2026);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("replaces the whole year so deleted dates do not linger, and never downgrades revisions", async () => {
    localStorage.setItem(`${HOLIDAY_CACHE_PREFIX}2026`, JSON.stringify(update()));
    const store = createHolidayCalendarStore();
    store.setEnabled(true);
    vi.mocked(fetch).mockResolvedValue(respond({ ...bundled, revision: 3 }));
    await store.refresh(2026);
    expect(store.getDay("2026-10-08")).toBeUndefined();
    vi.mocked(fetch).mockResolvedValue(respond(update()));
    await store.refresh(2026, true);
    expect(store.getYear(2026).data?.revision).toBe(3);
    expect(store.getDay("2026-10-08")).toBeUndefined();
  });

  it("ignores corrupt and older caches in favour of bundled data", () => {
    localStorage.setItem(`${HOLIDAY_CACHE_PREFIX}2026`, "broken");
    expect(createHolidayCalendarStore().getYear(2026).data).toEqual(bundled);
    localStorage.setItem(`${HOLIDAY_CACHE_PREFIX}2026`, JSON.stringify({ ...update(), revision: 1 }));
    expect(createHolidayCalendarStore().getYear(2026).data).toEqual(bundled);
  });

  it.each(["offline", "404", "invalid", "large", "large-stream"])("keeps cached dates when update fails (%s)", async (failure) => {
    localStorage.setItem(`${HOLIDAY_CACHE_PREFIX}2026`, JSON.stringify(update()));
    const store = createHolidayCalendarStore();
    store.setEnabled(true);
    if (failure === "offline") vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    if (failure === "404") vi.mocked(fetch).mockResolvedValue(new Response("", { status: 404 }));
    if (failure === "invalid") vi.mocked(fetch).mockResolvedValue(respond({ ...bundled, days: {} }));
    if (failure === "large") vi.mocked(fetch).mockResolvedValue(new Response("{}", { headers: { "content-length": "65537" } }));
    if (failure === "large-stream") vi.mocked(fetch).mockResolvedValue(new Response(" ".repeat(65537)));
    await store.refresh(2026);
    expect(store.getYear(2026).status).toBe("fallback");
    expect(store.getDay("2026-10-08")?.type).toBe("holiday");
    expect(JSON.parse(localStorage.getItem(`${HOLIDAY_CACHE_PREFIX}2026`)!).revision).toBe(2);
  });

  it("retries automatically after a day and allows explicit earlier retries", async () => {
    vi.useFakeTimers();
    const store = createHolidayCalendarStore();
    store.setEnabled(true);
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    await store.refresh(2026);
    await store.refresh(2026);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await store.refresh(2026);
    await store.refresh(2026, true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("bounds request time and retains bundled data on timeout", async () => {
    vi.useFakeTimers();
    const store = createHolidayCalendarStore();
    store.setEnabled(true);
    vi.mocked(fetch).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const request = store.refresh(2026);
    await vi.advanceTimersByTimeAsync(8000);
    await request;
    expect(store.getYear(2026).status).toBe("fallback");
    expect(store.getDay("2026-10-01")?.type).toBe("holiday");
  });

  it("ignores a late response after disabling the layer", async () => {
    const store = createHolidayCalendarStore();
    store.setEnabled(true);
    let complete!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const request = store.refresh(2026);
    store.setEnabled(false);
    complete(respond(update()));
    await request;
    expect(store.getYear(2026).data?.revision).toBe(1);
    expect(store.getDay("2026-10-01")).toBeUndefined();
    expect(localStorage.getItem(`${HOLIDAY_CACHE_PREFIX}2026`)).toBeNull();
  });

  it("does not invent holidays for an unavailable year", async () => {
    const store = createHolidayCalendarStore();
    store.setEnabled(true);
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 404 }));
    await store.refresh(2027);
    expect(store.getYear(2027).data).toBeUndefined();
    expect(store.getDay("2027-10-01")).toBeUndefined();
  });

  it("preserves a newer revision cached by another tab during a download", async () => {
    const store = createHolidayCalendarStore();
    store.setEnabled(true);
    let complete!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const request = store.refresh(2026);
    localStorage.setItem(`${HOLIDAY_CACHE_PREFIX}2026`, JSON.stringify({ ...bundled, revision: 3 }));
    complete(respond(update()));
    await request;
    expect(store.getYear(2026).data?.revision).toBe(3);
    expect(JSON.parse(localStorage.getItem(`${HOLIDAY_CACHE_PREFIX}2026`)!).revision).toBe(3);
  });

  it("shares settings with another tab and fetches again after a cancelled request", async () => {
    const store = createHolidayCalendarStore();
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    try {
      localStorage.setItem(HOLIDAY_ENABLED_KEY, "true");
      window.dispatchEvent(new StorageEvent("storage", { key: HOLIDAY_ENABLED_KEY, newValue: "true" }));
      expect(store.enabled).toBe(true);
      expect(notify).toHaveBeenCalled();
      let complete!: (response: Response) => void;
      vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
      const cancelled = store.refresh(2026);
      store.setEnabled(false);
      store.setEnabled(true);
      vi.mocked(fetch).mockResolvedValue(respond(update()));
      const resumed = store.refresh(2026);
      complete(respond(bundled));
      await cancelled;
      await resumed;
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(store.getYear(2026).data?.revision).toBe(2);
    } finally { unsubscribe(); }
  });

  it("can retrieve a later confirmed year without changing task data or bundling predictions", async () => {
    const store = createHolidayCalendarStore();
    store.setEnabled(true);
    const data = { ...bundled, year: 2027, days: { "2027-01-01": { type: "holiday", name: "newYear" } } };
    vi.mocked(fetch).mockResolvedValue(respond(data));
    await store.refresh(2027);
    expect(store.getDay("2027-01-01")?.type).toBe("holiday");
    expect(store.getYear(2027).origin).toBe("cached");
  });

  it("continues in memory when browser persistence is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const store = createHolidayCalendarStore();
    store.setEnabled(true);
    vi.mocked(fetch).mockResolvedValue(respond(update()));
    await store.refresh(2026);
    expect(store.storageError).toBe(true);
    expect(store.getYear(2026).origin).toBe("session");
    expect(store.getDay("2026-10-08")?.type).toBe("holiday");
  });
});
