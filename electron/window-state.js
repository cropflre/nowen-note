"use strict";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_MIN_WIDTH = 900;
const DEFAULT_MIN_HEIGHT = 600;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeStoredWindowState(raw, options = {}) {
  if (!raw || typeof raw !== "object") return null;
  if (![raw.x, raw.y, raw.width, raw.height].every(finiteNumber)) return null;
  if (raw.width <= 0 || raw.height <= 0) return null;

  const minWidth = options.minWidth || DEFAULT_MIN_WIDTH;
  const minHeight = options.minHeight || DEFAULT_MIN_HEIGHT;
  return {
    x: Math.round(raw.x),
    y: Math.round(raw.y),
    width: Math.max(minWidth, Math.round(raw.width)),
    height: Math.max(minHeight, Math.round(raw.height)),
    maximized: raw.maximized === true,
  };
}

function intersectionArea(bounds, workArea) {
  const left = Math.max(bounds.x, workArea.x);
  const top = Math.max(bounds.y, workArea.y);
  const right = Math.min(bounds.x + bounds.width, workArea.x + workArea.width);
  const bottom = Math.min(bounds.y + bounds.height, workArea.y + workArea.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function fitBoundsToWorkArea(bounds, workArea, centered) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const x = centered
    ? workArea.x + Math.round((workArea.width - width) / 2)
    : clamp(bounds.x, workArea.x, workArea.x + workArea.width - width);
  const y = centered
    ? workArea.y + Math.round((workArea.height - height) / 2)
    : clamp(bounds.y, workArea.y, workArea.y + workArea.height - height);
  return { x, y, width, height };
}

function resolveWindowBounds(storedState, workAreas, primaryWorkArea, options = {}) {
  const normalized = normalizeStoredWindowState(storedState, options);
  if (!normalized) {
    return {
      bounds: {
        width: options.defaultWidth || DEFAULT_WIDTH,
        height: options.defaultHeight || DEFAULT_HEIGHT,
      },
      maximized: false,
    };
  }

  const areas = Array.isArray(workAreas) ? workAreas.filter(Boolean) : [];
  const primary = primaryWorkArea || areas[0];
  if (!primary) {
    return {
      bounds: {
        x: normalized.x,
        y: normalized.y,
        width: normalized.width,
        height: normalized.height,
      },
      maximized: normalized.maximized,
    };
  }

  let target = null;
  let bestArea = 0;
  for (const workArea of areas) {
    const area = intersectionArea(normalized, workArea);
    if (area > bestArea) {
      bestArea = area;
      target = workArea;
    }
  }

  if (target) {
    return {
      bounds: {
        x: normalized.x,
        y: normalized.y,
        width: normalized.width,
        height: normalized.height,
      },
      maximized: normalized.maximized,
    };
  }

  const bounds = fitBoundsToWorkArea(normalized, primary, true);
  return { bounds, maximized: normalized.maximized };
}

function attachWindowStatePersistence(browserWindow, saveState, options = {}) {
  if (!browserWindow || typeof saveState !== "function") return () => {};
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 250;
  let timer = null;

  const persist = () => {
    timer = null;
    if (browserWindow.isDestroyed?.()) return;
    const bounds = browserWindow.getNormalBounds();
    const state = normalizeStoredWindowState({
      ...bounds,
      maximized: browserWindow.isMaximized?.() === true,
    });
    if (state) saveState(state);
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, debounceMs);
    timer.unref?.();
  };

  const persistImmediately = () => {
    if (timer) clearTimeout(timer);
    persist();
  };
  const clearPending = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  for (const eventName of ["move", "resize", "maximize", "unmaximize"]) {
    browserWindow.on(eventName, schedule);
  }
  browserWindow.on("close", persistImmediately);
  browserWindow.on("closed", clearPending);

  return () => {
    clearPending();
    for (const eventName of ["move", "resize", "maximize", "unmaximize"]) {
      browserWindow.removeListener?.(eventName, schedule);
    }
    browserWindow.removeListener?.("close", persistImmediately);
    browserWindow.removeListener?.("closed", clearPending);
  };
}

module.exports = {
  attachWindowStatePersistence,
  normalizeStoredWindowState,
  resolveWindowBounds,
};
