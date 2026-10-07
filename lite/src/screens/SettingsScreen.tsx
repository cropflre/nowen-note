/**
 * 设置 —— 按「分组」重新组织。
 *
 * 之前是一长条流水账，找一个开关要滚半天。现在分成五组，每组做一件事：
 *
 *   账号       当前是谁、连的哪台服务器、怎么退出
 *   外观       主题、界面语言、编辑器字号
 *   笔记展示   哪些笔记本的笔记要出现在扁平列表里
 *   同步与缓存 本地缓存预加载（启动秒出）、占用与清理
 *   关于       版本、时区自检
 *
 * 分组顺序按「改动频率」排：账号几乎不动，外观/展示是常调的。
 *
 * 刻意不放的东西（这些正是主 App「功能互相干扰」的来源）：
 * 插件、工作区、协同、AI 开关、离线同步引擎。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getClient } from "../api/client";
import { checkAccount, displayServer, type AccountStatus } from "../api/account";
import { getServerUrl, setServerUrl } from "../auth/auth";
import {
  getHiddenNotebookIds,
  setHiddenNotebookIds,
  setNotebookVisible,
} from "../lib/notebookPrefs";
import {
  applyTheme,
  getThemePreference,
  setThemePreference,
  THEME_OPTIONS,
  type ThemePreference,
} from "../lib/theme";
import { countVisibleNotes, flattenNotebooks, type FlatNotebook } from "../lib/notebookTree";
import { LANGS, setLang, useI18n, type Lang } from "../lib/i18n";
import {
  FONT_SIZES,
  getEditorFontSize,
  setEditorFontSize,
  type FontSize,
} from "../lib/editorFontSize";
import {
  clearCache,
  formatBytes,
  getCacheStats,
  getPreloadCount,
  isPreloadEnabled,
  PRELOAD_COUNTS,
  setPreloadCount,
  setPreloadEnabled,
  type CacheStats,
} from "../lib/preloadCache";
import { Segmented } from "../shell/Segmented";
import { isBadgeEnabled, setBadgeEnabled, useConnStatus, probeConnection } from "../lib/connStatus";
import {
  clearConflicts,
  dismissAllConflicts,
  useConflicts,
} from "../lib/conflictLog";
import {
  getUiStyle,
  setUiStyle,
  UI_STYLE_OPTIONS,
  type UiStyle,
} from "../lib/uiStyle";
import { TopBar } from "../App";
import type { Notebook } from "../../sdk/types";

/** 统一的分组容器，免得每组各写一遍标题样式 */
function Section({
  title,
  desc,
  children,
  testId,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section className="settings-group" data-testid={testId}>
      <h2 className="settings-group-title">{title}</h2>
      {desc ? <p className="settings-group-desc">{desc}</p> : null}
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

export function SettingsScreen({ onLoggedOut }: { onLoggedOut: () => void }) {
  const { lang, t } = useI18n();
  const cancelledRef = useRef(false);

  // ---- 账号 ----
  const [server, setServer] = useState(getServerUrl());
  const [serverSaved, setServerSaved] = useState(false);
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [checking, setChecking] = useState(false);

  // ---- 外观 ----
  const [theme, setTheme] = useState<ThemePreference>(() => getThemePreference());
  const [systemDark, setSystemDark] = useState(
    () => applyTheme(getThemePreference()) === "dark",
  );
  const [fontSize, setFontSizeState] = useState<FontSize>(() => getEditorFontSize());
  const [uiStyle, setUiStyleState] = useState<UiStyle>(() => getUiStyle());

  // ---- 笔记展示 ----
  const [notebooks, setNotebooks] = useState<FlatNotebook[] | null>(null);
  const [nbKeyword, setNbKeyword] = useState("");
  const [hidden, setHidden] = useState<string[]>(() => getHiddenNotebookIds());
  const [noteError, setNoteError] = useState<string | null>(null);

  // ---- 缓存 ----
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);
  const [preloadOn, setPreloadOn] = useState(() => isPreloadEnabled());
  const [preloadCount, setPreloadCountState] = useState(() => getPreloadCount());
  const [badgeOn, setBadgeOn] = useState(() => isBadgeEnabled());
  const conn = useConnStatus();
  const allConflicts = useConflicts();
  const openConflicts = allConflicts.filter((c) => c.resolvedAt === null);
  const [deviceId] = useState(() => {
    // 稳定的"这台设备"标识（只存本机，用来在诊断里区分是谁在连）
    try {
      let id = localStorage.getItem("nowen-lite.device-id");
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("nowen-lite.device-id", id);
      }
      return id;
    } catch {
      return "—";
    }
  });

  // ---- 时区自检 ----
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const timezoneName = Intl.DateTimeFormat().resolvedOptions().timeZone || "(?)";
  const offsetMin = -now.getTimezoneOffset();
  const timezoneOffset = `UTC${offsetMin >= 0 ? "+" : "−"}${p2(Math.floor(Math.abs(offsetMin) / 60))}:${p2(Math.abs(offsetMin) % 60)}`;
  const localNow = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
  // ⚠️ 不要拿 getTime() 再加减偏移：getTime() 是绝对时刻，getUTC* 取出来本来就是 UTC
  const utcNow = `${now.getUTCFullYear()}-${p2(now.getUTCMonth() + 1)}-${p2(now.getUTCDate())} ${p2(now.getUTCHours())}:${p2(now.getUTCMinutes())}`;

  const refreshCacheStats = useCallback(async () => {
    setCacheStats(await getCacheStats());
  }, []);

  const runAccountCheck = useCallback(async () => {
    setChecking(true);
    try {
      const status = await checkAccount();
      if (!cancelledRef.current) setAccount(status);
    } finally {
      if (!cancelledRef.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void runAccountCheck();
    return () => {
      cancelledRef.current = true;
    };
  }, [runAccountCheck]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await getClient().listNotebooks();
        if (!cancelled) setNotebooks(flattenNotebooks(list as Notebook[]));
      } catch (err) {
        if (!cancelled) setNoteError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refreshCacheStats();
  }, [refreshCacheStats]);

  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visibleCount = notebooks ? notebooks.filter((nb) => !hiddenSet.has(nb.id)).length : 0;
  // ⚠️ 不能直接把可见笔记本的 noteCount 相加：它是【递归】的（父含子），会重复计算
  const noteTotal = notebooks ? countVisibleNotes(notebooks, hiddenSet) : 0;
  const emptyNotebooks = notebooks ? notebooks.filter((nb) => nb.noteCount === 0) : [];
  const emptyHidden =
    emptyNotebooks.length > 0 && emptyNotebooks.every((nb) => hiddenSet.has(nb.id));

  const shownNotebooks = useMemo(() => {
    if (!notebooks) return null;
    const kw = nbKeyword.trim().toLowerCase();
    const list = kw ? notebooks.filter((nb) => nb.name.toLowerCase().includes(kw)) : notebooks;
    return [...list].sort((a, b) => b.noteCount - a.noteCount || a.name.localeCompare(b.name));
  }, [notebooks, nbKeyword]);

  function changeTheme(next: ThemePreference) {
    setTheme(next);
    setThemePreference(next);
    setSystemDark(applyTheme(next) === "dark");
  }

  function changeFontSize(next: FontSize) {
    setFontSizeState(next);
    setEditorFontSize(next);
  }

  function changeLang(next: Lang) {
    setLang(next);
  }

  function toggleNotebook(id: string, nextVisible: boolean) {
    setNotebookVisible(id, nextVisible);
    setHidden(getHiddenNotebookIds());
  }

  async function doClearCache() {
    setCacheBusy(true);
    try {
      await clearCache();
      await refreshCacheStats();
      setCacheCleared(true);
      setTimeout(() => setCacheCleared(false), 2500);
    } finally {
      setCacheBusy(false);
    }
  }

  return (
    <>
      <TopBar title={t("settings.title")} />
      <div className="app-content app-content--padded">
        {/* ================= 账号 ================= */}
        <Section title={t("settings.group.account")} testId="group-account">
          {/* 登录状态与服务端连接【分开显示】—— 它们的处置完全不同：
              会话失效要重新登录；连不上服务端只是网络问题，不能据此断言会话废了 */}
          <div
            className="status-row"
            data-state={checking && !account ? "checking" : (account?.login ?? "checking")}
            data-testid="login-status"
          >
            <span className="status-dot" aria-hidden="true" />
            <span className="status-label">{t("settings.loginState")}</span>
            <span className="status-value" data-testid="account-name">
              {!account && checking
                ? t("settings.checking")
                : account?.login === "ok"
                  ? `${t("settings.stateOk")} · ${account.displayName || account.username || ""}`
                  : account?.login === "expired"
                    ? t("settings.stateExpired")
                    : t("settings.stateOffline")}
            </span>
          </div>

          <div
            className="status-row"
            data-state={account?.server === "ok" ? "ok" : account ? "fail" : "checking"}
            data-testid="server-status"
          >
            <span className="status-dot" aria-hidden="true" />
            <span className="status-label">{t("settings.serverState")}</span>
            <span className="status-value" data-testid="server-state">
              {!account
                ? t("settings.checking")
                : account.server === "ok"
                  ? `${t("settings.serverOk")} · ${displayServer()}${account.version ? ` · v${account.version}` : ""}`
                  : t("settings.serverFail")}
            </span>
          </div>

          {account?.login === "expired" ? (
            <p className="status-hint" data-testid="login-hint">
              {t("settings.stateExpiredHint")}
            </p>
          ) : null}
          {account?.login === "offline" ? (
            <p className="status-hint" data-testid="login-hint">
              {t("settings.stateOfflineHint")}
            </p>
          ) : null}
          {account?.server === "fail" ? (
            <p className="status-hint" data-testid="server-hint">
              {t("settings.serverFailHintLong")}
            </p>
          ) : null}

          <div className="settings-actions">
            <button
              className="btn btn-secondary"
              onClick={() => void runAccountCheck()}
              disabled={checking}
              data-testid="recheck-account"
            >
              {checking ? t("settings.checking") : t("settings.recheck")}
            </button>
            {account ? (
              <span className="status-time">
                {t("settings.checkedAt", {
                  time: new Date(account.checkedAt).toTimeString().slice(0, 5),
                })}
              </span>
            ) : null}
          </div>

          <div className="settings-divider" />

          <div className="settings-field">
            <label className="settings-row-label" htmlFor="server-url">
              {t("settings.serverLabel")}
            </label>
            <div className="settings-input-row">
              <input
                id="server-url"
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder={t("settings.serverPlaceholder")}
                value={server}
                onChange={(e) => {
                  setServer(e.target.value);
                  setServerSaved(false);
                }}
              />
              <button
                className="btn"
                onClick={() => {
                  setServerUrl(server);
                  setServerSaved(true);
                }}
                data-testid="save-server"
              >
                {serverSaved ? t("common.saved") : t("common.save")}
              </button>
            </div>
            <p className="settings-row-hint">{t("settings.serverHint")}</p>
          </div>

          <button className="btn btn-danger" onClick={onLoggedOut} data-testid="logout">
            {account?.login === "expired" ? t("settings.relogin") : t("settings.logout")}
          </button>
        </Section>

        {/* ================= 外观 ================= */}
        <Section
          title={t("settings.group.appearance")}
          desc={t("settings.themeDesc")}
          testId="appearance-section"
        >
          {/* 界面风格放在最前：它是最直观、最该先选的一项 */}
          <span className="settings-row-label">{t("settings.uiStyle")}</span>
          <Segmented
            value={uiStyle}
            options={UI_STYLE_OPTIONS.map((o) => ({
              id: o.id,
              label: t(o.labelKey),
              icon: o.icon,
            }))}
            onChange={(next) => {
              setUiStyleState(next);
              setUiStyle(next);
            }}
            ariaLabel={t("settings.uiStyle")}
            testId="ui-style-switch"
          />
          <div className="theme-note">{t("settings.uiStyleDesc")}</div>

          <div className="settings-divider" />

          <div className="settings-row">
            <span className="settings-row-label">{t("settings.connBadge")}</span>
            <button
              type="button"
              className="toggle"
              role="switch"
              aria-checked={badgeOn}
              data-on={badgeOn}
              data-testid="conn-badge-toggle"
              aria-label={t("settings.connBadge")}
              onClick={() => {
                const next = !badgeOn;
                setBadgeOn(next);
                setBadgeEnabled(next);
              }}
            >
              <span className="toggle-knob" />
            </button>
          </div>
          <div className="theme-note">{t("settings.connBadgeDesc")}</div>

          <span className="settings-row-label">{t("settings.theme")}</span>
          <Segmented
            value={theme}
            options={THEME_OPTIONS.map((o) => ({
              ...o,
              label:
                o.id === "light"
                  ? t("settings.light")
                  : o.id === "dark"
                    ? t("settings.dark")
                    : t("settings.auto"),
            }))}
            onChange={changeTheme}
            ariaLabel={t("settings.theme")}
            testId="theme-switch"
          />
          <div className="theme-note" data-testid="theme-note">
            {theme === "auto"
              ? t("settings.themeAuto", {
                  system: systemDark ? t("settings.dark") : t("settings.light"),
                })
              : theme === "dark"
                ? t("settings.themeDark")
                : t("settings.themeLight")}
          </div>

          <div className="settings-divider" />

          <span className="settings-row-label">{t("settings.language")}</span>
          <Segmented
            value={lang}
            options={LANGS.map((l) => ({ id: l.id, label: l.label, icon: l.short }))}
            onChange={changeLang}
            ariaLabel={t("settings.language")}
            testId="lang-switch"
          />
          <div className="theme-note">{t("settings.languageDesc")}</div>

          <div className="settings-divider" />

          <span className="settings-row-label">{t("settings.fontSize")}</span>
          <div className="fontsize-row" role="group" aria-label={t("settings.fontSize")}>
            {FONT_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                className="fontsize-btn"
                data-size={size}
                aria-pressed={fontSize === size}
                onClick={() => changeFontSize(size)}
              >
                {size === 0 ? t("settings.fontSizeDefault") : size}
              </button>
            ))}
          </div>
          <div className="theme-note">{t("settings.fontSizeDesc")}</div>
        </Section>

        {/* ================= 笔记展示 ================= */}
        <Section
          title={t("settings.group.notes")}
          desc={t("settings.notebooksDesc")}
          testId="group-notes"
        >
          {noteError ? <div className="notice">{noteError}</div> : null}
          {!notebooks && !noteError ? <div className="loading">{t("common.loading")}</div> : null}

          {notebooks && notebooks.length > 0 ? (
            <>
              <div className="settings-summary" data-testid="notebooks-summary">
                {t("settings.notebooksSummary", {
                  visible: visibleCount,
                  total: notebooks.length,
                  notes: noteTotal,
                })}
                {emptyNotebooks.length > 0
                  ? t("settings.notebooksEmptyCount", { n: emptyNotebooks.length })
                  : ""}
              </div>

              {notebooks.length > 12 ? (
                <div className="searchbar glass settings-search">
                  <span className="search-icon" aria-hidden="true">
                    🔍
                  </span>
                  <input
                    type="text"
                    placeholder={t("settings.notebookSearch", { n: notebooks.length })}
                    value={nbKeyword}
                    onChange={(e) => setNbKeyword(e.target.value)}
                  />
                  {nbKeyword ? (
                    <button
                      className="search-clear"
                      onClick={() => setNbKeyword("")}
                      aria-label={t("common.clear")}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div className="settings-actions">
                <button
                  className="btn btn-secondary"
                  disabled={emptyNotebooks.length === 0}
                  onClick={() => {
                    setHiddenNotebookIds(
                      emptyHidden
                        ? hidden.filter((id) => !emptyNotebooks.some((nb) => nb.id === id))
                        : [...hidden, ...emptyNotebooks.map((nb) => nb.id)],
                    );
                    setHidden(getHiddenNotebookIds());
                  }}
                >
                  {emptyHidden
                    ? t("settings.showEmpty")
                    : t("settings.hideEmpty", { n: emptyNotebooks.length })}
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={hidden.length === 0}
                  onClick={() => {
                    setHiddenNotebookIds([]);
                    setHidden(getHiddenNotebookIds());
                  }}
                >
                  {t("settings.showAll")}
                </button>
              </div>

              <div className="card glass" style={{ margin: "0 0 4px" }}>
                <ul className="list">
                  {(shownNotebooks ?? []).map((nb) => {
                    const on = !hiddenSet.has(nb.id);
                    return (
                      <li key={nb.id}>
                        <button
                          type="button"
                          className="list-item toggle-row"
                          role="switch"
                          aria-checked={on}
                          onClick={() => toggleNotebook(nb.id, !on)}
                        >
                          <span className="li-icon" style={{ marginLeft: nb.depth * 14 }}>
                            {nb.icon}
                          </span>
                          <span className="li-main">
                            <span className="li-title">{nb.name}</span>
                            <span className="li-sub">
                              {t("notes.pickerCount", { n: nb.noteCount })}
                            </span>
                          </span>
                          <span className="toggle" data-on={on} aria-hidden="true">
                            <span className="toggle-knob" />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {shownNotebooks && shownNotebooks.length === 0 ? (
                  <div className="empty">{t("settings.notebookNoMatch", { kw: nbKeyword })}</div>
                ) : null}
              </div>
            </>
          ) : null}
        </Section>

        {/* ================= 同步与缓存 ================= */}
        <Section title={t("settings.group.sync")} testId="group-cache">
          {/* 数据来源：照标准版的两张单选卡片（不同步仅此设备 / 我的 Nowen Server）。
              Lite 没有本地优先同步引擎，所以「仅此设备」如实标注 Not implemented，
              而不是做一个假的开关。 */}
          <span className="settings-row-label">{t("sync.modeTitle")}</span>
          {[
            {
              id: "offline",
              title: t("sync.modeOffline"),
              desc: t("sync.modeOfflineDesc"),
              active: false,
              disabled: true,
            },
            {
              id: "live",
              title: t("sync.modeLive"),
              desc: t("sync.modeLiveDesc"),
              active: true,
              disabled: false,
            },
          ].map((m) => (
            <div className="sync-mode" key={m.id} data-active={m.active} data-disabled={m.disabled} data-testid={`sync-mode-${m.id}`}>
              <span className="sync-radio" aria-hidden="true" />
              <span className="sync-mode-main">
                <span className="sync-mode-title">
                  {m.active ? "✅" : "🖥"} {m.title}
                </span>
                <span className="sync-mode-desc">{m.desc}</span>
              </span>
            </div>
          ))}

          <div className="settings-divider" />
          <div className="theme-note">{t("settings.cacheDesc")}</div>
          <div className="settings-row">
            <span className="settings-row-label">{t("settings.cacheEnable")}</span>
            <button
              type="button"
              className="toggle"
              role="switch"
              aria-checked={preloadOn}
              data-on={preloadOn}
              data-testid="preload-toggle"
              aria-label={t("settings.cacheEnable")}
              onClick={() => {
                const next = !preloadOn;
                setPreloadOn(next);
                setPreloadEnabled(next);
                void refreshCacheStats();
              }}
            >
              <span className="toggle-knob" />
            </button>
          </div>

          <div className="settings-row settings-row--stack">
            <span className="settings-row-label">{t("settings.cacheCount")}</span>
            <div className="fontsize-row" role="group" aria-label={t("settings.cacheCount")}>
              {PRELOAD_COUNTS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className="fontsize-btn"
                  data-count={n}
                  aria-pressed={preloadCount === n}
                  disabled={!preloadOn}
                  onClick={() => {
                    setPreloadCountState(n);
                    setPreloadCount(n);
                    void refreshCacheStats();
                  }}
                >
                  {n === 0 ? t("common.off") : n}
                </button>
              ))}
            </div>
            <span className="settings-row-hint">{t("settings.cacheCountHint")}</span>
          </div>

          <div className="settings-row">
            <span className="settings-row-label">{t("settings.cacheUsage")}</span>
            <span className="settings-row-value" data-testid="cache-usage">
              {cacheStats
                ? cacheStats.noteCount === 0
                  ? t("settings.cacheEmpty")
                  : t("settings.cacheUsageValue", {
                      notes: cacheStats.noteCount,
                      size: formatBytes(cacheStats.bytes),
                    })
                : "—"}
            </span>
          </div>

          <div className="settings-divider" />

          {/* 同步诊断 —— 照标准版那张表；数值都取真实来源，没有的写「—」而不是编一个 */}
          <div className="diag-head">
            <span className="settings-row-label">☁️ {t("sync.diagnostics")}</span>
            <button
              type="button"
              className="diag-refresh"
              onClick={() => {
                void probeConnection();
                void refreshCacheStats();
              }}
              data-testid="diag-refresh"
            >
              ↻ {t("sync.refresh")}
            </button>
          </div>
          <div className="diag-grid" data-testid="sync-diagnostics">
            <span>{t("sync.deviceId")}</span>
            <b title={deviceId}>{deviceId.length > 13 ? `${deviceId.slice(0, 13)}…` : deviceId}</b>
            <span>{t("sync.server")}</span>
            <b>{displayServer()}</b>

            <span>{t("sync.localCursor")}</span>
            <b>{cacheStats ? cacheStats.noteCount : t("sync.none")}</b>
            <span>{t("sync.pending")}</span>
            <b>0</b>

            <span>{t("sync.conflicts")}</span>
            <b data-testid="diag-conflicts">{openConflicts.length}</b>
            <span>{t("sync.lastSync")}</span>
            <b>
              {cacheStats?.listAt
                ? new Date(cacheStats.listAt).toTimeString().slice(0, 5)
                : t("sync.none")}
            </b>

            <span>{t("sync.lastPing")}</span>
            <b data-testid="diag-last-ping">
              {conn.at ? new Date(conn.at).toTimeString().slice(0, 5) : t("sync.none")}
            </b>
            <span>{t("sync.lastError")}</span>
            <b data-testid="diag-last-error">
              {conn.state === "fail" ? t("conn.fail") : t("sync.noError")}
            </b>
          </div>

          {/* 冲突：标准版也有这一块。Lite 的冲突来自 409 版本校验，
              记在本机台账里（见 lib/conflictLog.ts） */}
          <div className="settings-divider" />
          <div className="diag-head">
            <span className="settings-row-label">⚠️ {t("conflict.title")}</span>
            {openConflicts.length > 0 ? (
              <button
                type="button"
                className="diag-refresh"
                onClick={() => dismissAllConflicts()}
                data-testid="conflict-dismiss-all"
              >
                {t("conflict.dismissAll")}
              </button>
            ) : null}
          </div>
          {openConflicts.length === 0 ? (
            <div className="theme-note" data-testid="conflict-empty">
              {t("conflict.empty")}
            </div>
          ) : (
            <ul className="conflict-list" data-testid="conflict-list">
              {openConflicts.slice(0, 8).map((c) => (
                <li key={c.id} className="conflict-item">
                  <a className="conflict-title" href={`#/note/${c.noteId}`}>
                    {c.noteTitle}
                  </a>
                  <span className="conflict-meta">
                    {t("conflict.versions", { local: c.localVersion, server: c.serverVersion })} ·{" "}
                    {new Date(c.at).toTimeString().slice(0, 5)}
                  </span>
                </li>
              ))}
              {openConflicts.length > 8 ? (
                <li className="conflict-more">{t("conflict.more", { n: openConflicts.length - 8 })}</li>
              ) : null}
            </ul>
          )}
          {allConflicts.length > 0 ? (
            <button
              className="btn btn-secondary"
              onClick={() => clearConflicts()}
              data-testid="conflict-clear"
            >
              {t("conflict.clear")}
            </button>
          ) : null}

          <button
            className="btn btn-secondary"
            onClick={() => void doClearCache()}
            disabled={cacheBusy}
            data-testid="clear-cache"
          >
            {cacheBusy
              ? t("settings.cacheBusy")
              : cacheCleared
                ? t("settings.cacheCleared")
                : t("settings.cacheClear")}
          </button>
        </Section>

        {/* ================= 关于 ================= */}
        <Section title={t("settings.group.about")} testId="group-about">
          <div className="settings-row">
            <span className="settings-row-label">{t("settings.about")}</span>
            <span className="settings-row-value">{t("settings.aboutVersion")}</span>
          </div>
          <p className="settings-row-hint">{t("settings.aboutDesc")}</p>
          <p className="settings-row-hint">{t("settings.aboutTech")}</p>

          <div className="settings-divider" />

          <span className="settings-row-label">{t("settings.tzTitle")}</span>
          <p className="settings-row-hint">{t("settings.tzDesc")}</p>
          <div className="tz-grid" data-testid="timezone-info">
            <span>{t("settings.tzName")}</span>
            <b data-testid="tz-name">{timezoneName}</b>
            <span>{t("settings.tzOffset")}</span>
            <b data-testid="tz-offset">{timezoneOffset}</b>
            <span>{t("settings.tzLocal")}</span>
            <b data-testid="tz-local">{localNow}</b>
            <span>{t("settings.tzUtc")}</span>
            <b data-testid="tz-utc">{utcNow}</b>
          </div>
        </Section>
      </div>
    </>
  );
}
