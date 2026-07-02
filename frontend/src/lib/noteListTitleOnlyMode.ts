const STORAGE_KEY = "nowen.noteList.titleOnly";
const BODY_CLASS = "note-list-title-only";
const STYLE_ID = "nowen-note-list-title-only-style";
const BUTTON_ATTR = "data-note-list-title-only-toggle";

const VIRTUAL_ITEM_HEIGHT = 90;
const TITLE_ONLY_ITEM_HEIGHT = 38;
let initialized = false;

function readEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; } catch { return false; }
}

function writeEnabled(value: boolean) {
  try { localStorage.setItem(STORAGE_KEY, String(value)); } catch {}
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    body.${BODY_CLASS} div:has(> .note-card-title) ~ * { display: none !important; }
    body.${BODY_CLASS} [class*="pl-3.5"][class*="py-2.5"]:has(.note-card-title) { padding-top: 6px !important; padding-bottom: 6px !important; }
    body.${BODY_CLASS} .note-card-title { font-size: 13px !important; line-height: 18px !important; }
    button[${BUTTON_ATTR}="true"] { height: 26px; padding: 0 8px; border: 1px solid transparent; border-radius: 7px; font-size: 11px; line-height: 1; color: var(--color-text-tertiary, #71717a); background: transparent; cursor: pointer; transition: background-color .15s ease, color .15s ease, border-color .15s ease; }
    button[${BUTTON_ATTR}="true"]:hover { color: var(--color-text-secondary, #52525b); background: var(--color-hover, rgba(148, 163, 184, .14)); }
    body.${BODY_CLASS} button[${BUTTON_ATTR}="true"] { color: var(--color-accent-primary, #2563eb); background: color-mix(in srgb, var(--color-accent-primary, #2563eb) 12%, transparent); border-color: color-mix(in srgb, var(--color-accent-primary, #2563eb) 24%, transparent); }
  `;
  document.head.appendChild(style);
}

function applyBodyClass(enabled = readEnabled()) {
  document.body.classList.toggle(BODY_CLASS, enabled);
}

function updateToggleLabels() {
  const enabled = readEnabled();
  document.querySelectorAll<HTMLButtonElement>(`button[${BUTTON_ATTR}="true"]`).forEach((btn) => {
    btn.textContent = enabled ? "卡片" : "标题";
    btn.title = enabled ? "切换为卡片列表" : "只显示笔记标题";
    btn.setAttribute("aria-pressed", String(enabled));
  });
}

function patchVirtualLists() {
  const enabled = readEnabled();
  document.querySelectorAll<HTMLElement>('[data-note-list-scroll-viewport="virtual"]').forEach((viewport) => {
    const total = viewport.firstElementChild as HTMLElement | null;
    const inner = total?.firstElementChild as HTMLElement | null;
    if (!total || !inner) return;

    if (!enabled) {
      const originalHeight = Number(total.dataset.noteListOriginalHeight || "0");
      const patchedTop = Number(inner.dataset.noteListPatchedTop || "0");
      if (originalHeight > 0) total.style.setProperty("height", `${originalHeight}px`);
      if (patchedTop > 0) inner.style.setProperty("top", `${Math.round(patchedTop / TITLE_ONLY_ITEM_HEIGHT) * VIRTUAL_ITEM_HEIGHT}px`);
      delete total.dataset.noteListOriginalHeight;
      delete inner.dataset.noteListPatchedTop;
      return;
    }

    const rawHeight = Number.parseFloat(total.style.height || "0");
    if (!Number.isFinite(rawHeight) || rawHeight <= 0) return;
    const previousOriginalHeight = Number(total.dataset.noteListOriginalHeight || "0");
    const originalHeight = previousOriginalHeight > 0 && rawHeight !== previousOriginalHeight ? previousOriginalHeight : rawHeight;
    total.dataset.noteListOriginalHeight = String(originalHeight);
    total.style.setProperty("height", `${Math.max(0, Math.round(originalHeight / VIRTUAL_ITEM_HEIGHT)) * TITLE_ONLY_ITEM_HEIGHT}px`, "important");

    const rawTop = Number.parseFloat(inner.style.top || "0");
    const previousPatchedTop = Number(inner.dataset.noteListPatchedTop || "NaN");
    if (Number.isFinite(previousPatchedTop) && Math.abs(rawTop - previousPatchedTop) < 0.5) return;
    const patchedTop = Math.max(0, Math.round(rawTop / VIRTUAL_ITEM_HEIGHT)) * TITLE_ONLY_ITEM_HEIGHT;
    inner.dataset.noteListPatchedTop = String(patchedTop);
    inner.style.setProperty("top", `${patchedTop}px`, "important");
  });
}

function toggleMode() {
  const next = !readEnabled();
  writeEnabled(next);
  applyBodyClass(next);
  updateToggleLabels();
  patchVirtualLists();
}

function shouldUseSortButton(button: HTMLButtonElement): boolean {
  const title = (button.getAttribute("title") || button.getAttribute("aria-label") || "").trim().toLowerCase();
  return Boolean(title) && (title.includes("排序") || title.includes("sort"));
}

function ensureToolbarButtons() {
  Array.from(document.querySelectorAll<HTMLButtonElement>("button[title],button[aria-label]")).filter(shouldUseSortButton).forEach((sortButton) => {
    const toolbar = sortButton.parentElement;
    if (!toolbar || toolbar.querySelector(`button[${BUTTON_ATTR}="true"]`)) return;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.setAttribute(BUTTON_ATTR, "true");
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleMode();
    });
    sortButton.insertAdjacentElement("afterend", toggle);
  });
  updateToggleLabels();
}

export function initNoteListTitleOnlyMode() {
  if (initialized || typeof window === "undefined" || typeof document === "undefined") return;
  initialized = true;
  ensureStyle();
  applyBodyClass();

  const sync = () => {
    ensureToolbarButtons();
    patchVirtualLists();
  };
  sync();
  new MutationObserver(sync).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "title", "aria-label", "class"],
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    applyBodyClass();
    updateToggleLabels();
    patchVirtualLists();
  });
  window.addEventListener("resize", patchVirtualLists);
}

initNoteListTitleOnlyMode();
