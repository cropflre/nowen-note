import {
  BUNDLED_HOLIDAY_YEARS, HOLIDAY_MAX_BYTES, HOLIDAY_UPDATE_BASE,
  getHolidayDay, isHolidayYear, parseHolidayYear, type HolidayYear,
} from "./holidayCalendar";

export const HOLIDAY_ENABLED_KEY = "nowen.calendar.cn-holidays.enabled.v1";
export const HOLIDAY_CACHE_PREFIX = "nowen.calendar.cn-holidays.year.v1.";
const CHECK_PREFIX = "nowen.calendar.cn-holidays.checked.v1.";
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
type YearState = {
  data?: HolidayYear;
  origin: "builtin" | "cached" | "session";
  status: "idle" | "loading" | "updated" | "fallback";
  attemptedAt: number;
};

export function createHolidayCalendarStore() {
  let enabled = false;
  let storageError = false;
  let version = 0;
  const years = new Map<number, YearState>();
  const pending = new Map<number, Promise<void>>();
  const controllers = new Map<number, AbortController>();
  const listeners = new Set<() => void>();
  const emit = () => { version++; listeners.forEach((notify) => notify()); };
  const readEnabled = () => {
    try { enabled = localStorage.getItem(HOLIDAY_ENABLED_KEY) === "true"; }
    catch { storageError = true; }
  };
  readEnabled();

  function getYear(year: number): YearState {
    const existing = years.get(year);
    if (existing) return existing;
    const state: YearState = { data: BUNDLED_HOLIDAY_YEARS[year], origin: "builtin", status: "idle", attemptedAt: 0 };
    try {
      const checked = Number(localStorage.getItem(`${CHECK_PREFIX}${year}`));
      if (Number.isFinite(checked) && checked > 0 && checked <= Date.now()) state.attemptedAt = checked;
      const cached = localStorage.getItem(`${HOLIDAY_CACHE_PREFIX}${year}`);
      if (cached) {
        const data = parseHolidayYear(cached, year);
        if (!state.data || data.revision > state.data.revision) {
          state.data = data;
          state.origin = "cached";
        }
      }
    } catch { /* Ignore corrupt caches; the bundled year remains available. */ }
    years.set(year, state);
    return state;
  }

  function setEnabled(next: boolean) {
    enabled = next;
    try { localStorage.setItem(HOLIDAY_ENABLED_KEY, String(next)); }
    catch { storageError = true; }
    if (!next) cancelUpdates();
    emit();
  }

  function cancelUpdates() {
    controllers.forEach((controller, year) => {
      controller.abort();
      getYear(year).attemptedAt = 0;
      try { localStorage.removeItem(`${CHECK_PREFIX}${year}`); }
      catch { storageError = true; }
    });
  }

  async function download(year: number, signal: AbortSignal): Promise<HolidayYear> {
    const response = await fetch(`${HOLIDAY_UPDATE_BASE}cn-${year}.json`, {
      signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-cache",
    });
    if (!response.ok || Number(response.headers.get("content-length")) > HOLIDAY_MAX_BYTES || !response.body) throw new Error("Holiday update unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > HOLIDAY_MAX_BYTES) throw new Error("Holiday update too large");
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return parseHolidayYear(text + decoder.decode(), year);
  }

  function refresh(year: number, force = false): Promise<void> {
    if (!enabled || !isHolidayYear(year)) return Promise.resolve();
    const inFlight = pending.get(year);
    if (inFlight) return controllers.get(year)?.signal.aborted ? inFlight.then(() => refresh(year, force)) : inFlight;
    const state = getYear(year);
    const now = Date.now();
    if (!force && state.attemptedAt && now - state.attemptedAt < CHECK_INTERVAL) return Promise.resolve();
    state.attemptedAt = now;
    try { localStorage.setItem(`${CHECK_PREFIX}${year}`, String(now)); }
    catch { storageError = true; }
    state.status = "loading";
    const controller = new AbortController();
    controllers.set(year, controller);
    const timeout = setTimeout(() => controller.abort(), 8000);
    const request = (async () => {
      try {
        const data = await download(year, controller.signal);
        if (!enabled || controller.signal.aborted) return;
        // Another tab may have cached a newer revision while this request ran.
        try {
          const cached = localStorage.getItem(`${HOLIDAY_CACHE_PREFIX}${year}`);
          const latest = cached ? parseHolidayYear(cached, year) : undefined;
          if (latest && (!state.data || latest.revision > state.data.revision)) {
            state.data = latest;
            state.origin = "cached";
          }
        } catch { /* Keep the available in-memory data. */ }
        if (!state.data || data.revision > state.data.revision) {
          state.data = data;
          state.origin = "session";
          try {
            localStorage.setItem(`${HOLIDAY_CACHE_PREFIX}${year}`, JSON.stringify(data));
            state.origin = "cached";
          } catch { storageError = true; }
        }
        state.status = "updated";
      } catch {
        state.status = enabled ? "fallback" : "idle";
      } finally {
        clearTimeout(timeout);
        if (state.status === "loading") state.status = "idle";
        controllers.delete(year);
        pending.delete(year);
        emit();
      }
    })();
    pending.set(year, request);
    emit();
    return request;
  }

  function onStorage(event: StorageEvent) {
    if (event.key === null || event.key === HOLIDAY_ENABLED_KEY) {
      readEnabled();
      if (!enabled) cancelUpdates();
    }
    if (event.key === null || event.key?.startsWith(HOLIDAY_CACHE_PREFIX)) {
      // Do not replace a state while its update is in flight.
      for (const year of years.keys()) if (!pending.has(year)) years.delete(year);
    }
    emit();
  }

  return {
    subscribe(notify: () => void) {
      if (!listeners.size) {
        const previous = enabled;
        readEnabled();
        if (previous !== enabled) version++;
        window.addEventListener("storage", onStorage);
      }
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
        if (!listeners.size) window.removeEventListener("storage", onStorage);
      };
    },
    getSnapshot: () => version,
    get enabled() { return enabled; },
    get storageError() { return storageError; },
    getYear, setEnabled, refresh,
    getDay(dateKey: string) {
      if (!enabled) return undefined;
      const year = Number(dateKey.slice(0, 4));
      const data = getYear(year).data;
      return data ? getHolidayDay(dateKey, { [year]: data }) : undefined;
    },
  };
}

export const holidayCalendarStore = createHolidayCalendarStore();
