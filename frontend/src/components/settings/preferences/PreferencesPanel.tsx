import React, { useEffect, useId, useRef, useState } from "react";
import { AppWindow, Bot, Globe, PanelLeft, PenLine, Search, Settings2, ShieldCheck, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useUserPreferences, type UserPreferences } from "@/hooks/useUserPreferences";
import { isAndroidNativeRuntime, isMobileLocalMode } from "@/lib/mobileLocalMode";
import { isMobileSyncEnabled } from "@/lib/mobileSyncStatus";
import { useAIConnectionAvailable } from "@/lib/aiConnection";
import { NAVIGATION_MODULE_IDS, TASK_CENTER_OPTIONAL_MODULE_IDS } from "@/lib/navigationVisibility";
import { NavigationModulesGroup, TaskCenterModulesGroup } from "./NavigationModuleSettings";
import {
  navigationModuleAnchor,
  taskCenterModuleAnchor,
  useNavigationModuleLabels,
  useTaskCenterModuleLabels,
} from "./navigationModules";
import {
  DisclosureRow,
  LinkRow,
  PreferenceGroup,
  SegmentedRow,
  SelectRow,
  SubpageHeader,
  SwitchRow,
  type ChoiceOption,
  type PreferenceScope,
} from "./PreferenceControls";
import {
  searchPreferences,
  type PreferenceDisclosure,
  type PreferenceSearchEntry,
  type PreferencesPage,
  type RelatedSettingsTab,
} from "./preferenceSearch";
import { revealSettingsTarget } from "./revealSettingsTarget";
import { useDesktopMenuBarPreference, useDeviceLayoutPreferences, useLayoutSurface } from "./useDeviceLayoutPreferences";

export interface PreferencesPanelProps {
  isAdmin: boolean;
  /** Labels of the settings tabs that now hold options moved out of this page. */
  relatedTabLabels: Record<RelatedSettingsTab, string>;
  onOpenRelatedSetting: (tab: RelatedSettingsTab, section: string) => void;
}

function useItemCopy() {
  const { t } = useTranslation();
  const item = (title: string, description: string, keywords: string) => ({ title, description, keywords });
  return {
    enableNoteTabs: item(
      t("preferences.items.enableNoteTabs.title"),
      t("preferences.items.enableNoteTabs.description"),
      t("preferences.items.enableNoteTabs.keywords"),
    ),
    markdownDefaultViewMode: item(
      t("preferences.items.markdownDefaultViewMode.title"),
      t("preferences.items.markdownDefaultViewMode.description"),
      t("preferences.items.markdownDefaultViewMode.keywords"),
    ),
    remoteImagePasteMode: item(
      t("preferences.items.remoteImagePasteMode.title"),
      t("preferences.items.remoteImagePasteMode.description"),
      t("preferences.items.remoteImagePasteMode.keywords"),
    ),
    outlineDefaultOpen: item(
      t("preferences.items.outlineDefaultOpen.title"),
      t("preferences.items.outlineDefaultOpen.description"),
      t("preferences.items.outlineDefaultOpen.keywords"),
    ),
    codeBlockWordWrap: item(
      t("preferences.items.codeBlockWordWrap.title"),
      t("preferences.items.codeBlockWordWrap.description"),
      t("preferences.items.codeBlockWordWrap.keywords"),
    ),
    codeBlockCollapseMode: item(
      t("preferences.items.codeBlockCollapseMode.title"),
      t("preferences.items.codeBlockCollapseMode.description"),
      t("preferences.items.codeBlockCollapseMode.keywords"),
    ),
    lockOnOpen: item(
      t("preferences.items.lockOnOpen.title"),
      t("preferences.items.lockOnOpen.description"),
      t("preferences.items.lockOnOpen.keywords"),
    ),
    showTemplateManagement: item(
      t("preferences.items.showTemplateManagement.title"),
      t("preferences.items.showTemplateManagement.description"),
      t("preferences.items.showTemplateManagement.keywords"),
    ),
    noteTitleAsAppTitle: item(
      t("preferences.items.noteTitleAsAppTitle.title"),
      t("preferences.items.noteTitleAsAppTitle.description"),
      t("preferences.items.noteTitleAsAppTitle.keywords"),
    ),
    showNoteListDividers: item(
      t("preferences.items.showNoteListDividers.title"),
      t("preferences.items.showNoteListDividers.description"),
      t("preferences.items.showNoteListDividers.keywords"),
    ),
    mobileRailHidden: item(
      t("preferences.items.mobileRailHidden.title"),
      t("preferences.items.mobileRailHidden.description"),
      t("preferences.items.mobileRailHidden.keywords"),
    ),
    mobileKnowledgeTreeMode: item(
      t("preferences.items.mobileKnowledgeTreeMode.title"),
      t("preferences.items.mobileKnowledgeTreeMode.description"),
      t("preferences.items.mobileKnowledgeTreeMode.keywords"),
    ),
    mobileKnowledgeTreeCompact: item(
      t("preferences.items.mobileKnowledgeTreeCompact.title"),
      t("preferences.items.mobileKnowledgeTreeCompact.description"),
      t("preferences.items.mobileKnowledgeTreeCompact.keywords"),
    ),
    desktopKnowledgeTreeMode: item(
      t("preferences.items.desktopKnowledgeTreeMode.title"),
      t("preferences.items.desktopKnowledgeTreeMode.description"),
      t("preferences.items.desktopKnowledgeTreeMode.keywords"),
    ),
    desktopHideMenuBar: item(
      t("settings.hideDesktopMenuBar"),
      t("settings.hideDesktopMenuBarDesc"),
      t("preferences.items.desktopHideMenuBar.keywords"),
    ),
    journalPrivacy: item(
      t("settings.journalPrivacyTitle"),
      t("preferences.items.journalPrivacy.description"),
      t("preferences.items.journalPrivacy.keywords"),
    ),
    aiMemoryArchive: item(
      t("aiMemory.title"),
      t("preferences.items.aiMemoryArchive.description"),
      t("preferences.items.aiMemoryArchive.keywords"),
    ),
    webUi: item(
      t("preferences.items.webUi.title"),
      t("preferences.items.webUi.description"),
      t("preferences.items.webUi.keywords"),
    ),
  };
}

type Transition = { reveal?: string; focus?: string };

export default function PreferencesPanel({ isAdmin, relatedTabLabels, onOpenRelatedSetting }: PreferencesPanelProps) {
  const { t } = useTranslation();
  const { prefs, setPref } = useUserPreferences();
  const copy = useItemCopy();
  const surface = useLayoutSurface();
  const device = useDeviceLayoutPreferences();
  const menuBar = useDesktopMenuBarPreference();
  const navigationLabels = useNavigationModuleLabels();
  const aiAvailable = useAIConnectionAvailable();
  const navigationModules = NAVIGATION_MODULE_IDS.filter((id) => id !== "ai-chat" || aiAvailable);
  const taskCenterLabels = useTaskCenterModuleLabels();

  const localMode = isMobileLocalMode();
  // Mirrors useUserPreferences: Android uploads account preferences only while sync is on.
  const syncOff = !localMode && isAndroidNativeRuntime() && !isMobileSyncEnabled();
  const accountScope: PreferenceScope = localMode ? "device" : "account";
  // Security is not shown in device-only mode; the archive switch was never offered there either.
  const showJournalPrivacy = !localMode;
  const showAIMemory = isAdmin && !localMode;
  const showWebUi = isAdmin;
  const showAdvanced = showJournalPrivacy || showAIMemory || showWebUi;

  const [page, setPage] = useState<PreferencesPage>("home");
  const [query, setQuery] = useState("");
  const [editingMoreOpen, setEditingMoreOpen] = useState(false);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const transition = useRef<Transition | null>(null);
  const returnFocus = useRef<string | null>(null);
  const resultsId = useId();

  const categoryTitles = {
    navigation: t("preferences.categories.navigation.title"),
    editing: t("preferences.categories.editing.title"),
    layout: t("preferences.categories.layout.title"),
    advanced: t("preferences.categories.advanced.title"),
  };
  const deviceSectionTitle = surface === "mobile"
    ? t("preferences.sections.thisDeviceMobile")
    : t("preferences.sections.thisDeviceDesktop");

  const markdownModes: ChoiceOption<UserPreferences["markdownDefaultViewMode"]>[] = [
    { value: "source", label: t("markdown.view.source") },
    { value: "preview", label: t("markdown.view.preview") },
    { value: "split", label: t("markdown.view.split") },
  ];
  const pasteModes: ChoiceOption<UserPreferences["remoteImagePasteMode"]>[] = [
    { value: "localize", label: t("settings.remoteImagePasteMode_localize") },
    { value: "ask", label: t("settings.remoteImagePasteMode_ask") },
    { value: "keep-remote", label: t("settings.remoteImagePasteMode_keep-remote") },
  ];
  const collapseModes: ChoiceOption<UserPreferences["codeBlockCollapseMode"]>[] = [
    { value: "expanded", label: t("settings.codeBlockCollapseMode_expanded") },
    { value: "long", label: t("settings.codeBlockCollapseMode_long") },
    { value: "collapsed", label: t("settings.codeBlockCollapseMode_collapsed") },
  ];

  const navigate = (next: PreferencesPage, options: { reveal?: string; disclosure?: PreferenceDisclosure; from?: string } = {}) => {
    if (options.disclosure === "editingMore") setEditingMoreOpen(true);
    if (options.disclosure === "taskCenter") setTaskCenterOpen(true);
    returnFocus.current = options.from ?? null;
    transition.current = { reveal: options.reveal };
    setPage(next);
  };

  const goHome = () => {
    transition.current = { focus: returnFocus.current ?? undefined };
    returnFocus.current = null;
    setPage("home");
  };

  // Page changes keep keyboard focus and scroll position predictable.
  useEffect(() => {
    const root = rootRef.current;
    const pending = transition.current;
    transition.current = null;
    if (!root || !pending) return;
    if (pending.reveal) return revealSettingsTarget(root, `[data-preference-id="${pending.reveal}"]`, { focus: true });
    root.scrollIntoView?.({ block: "start" });
    const target = pending.focus === "search"
      ? searchRef.current
      : pending.focus
        ? root.querySelector<HTMLElement>(`[data-preference-id="${pending.focus}"]`)
        : headingRef.current;
    target?.focus({ preventScroll: true });
  }, [page]);

  const buildSearchEntries = (): PreferenceSearchEntry[] => {
    const navigationPath = [categoryTitles.navigation];
    const editingPath = [categoryTitles.editing];
    const editingMorePath = [categoryTitles.editing, t("preferences.moreOptions")];
    const generalPath = [categoryTitles.layout, t("preferences.sections.general")];
    const devicePath = [categoryTitles.layout, deviceSectionTitle];
    const onPage = (pageName: Exclude<PreferencesPage, "home">, disclosure?: PreferenceDisclosure) =>
      ({ kind: "page" as const, page: pageName, disclosure });
    const deviceEntries: PreferenceSearchEntry[] = surface === "mobile"
      ? [
        { id: "mobileRailHidden", ...copy.mobileRailHidden, path: devicePath, scope: "device", target: onPage("layout") },
        { id: "mobileKnowledgeTreeMode", ...copy.mobileKnowledgeTreeMode, path: devicePath, scope: "device", target: onPage("layout") },
        { id: "mobileKnowledgeTreeCompact", ...copy.mobileKnowledgeTreeCompact, path: devicePath, scope: "device", target: onPage("layout") },
      ]
      : [{ id: "desktopKnowledgeTreeMode", ...copy.desktopKnowledgeTreeMode, path: devicePath, scope: "device", target: onPage("layout") }];

    return [
      {
        id: "navigation-modules",
        title: t("preferences.sections.navigationModules"),
        description: t("preferences.categories.navigation.description"),
        keywords: t("preferences.items.navigation.keywords"),
        path: navigationPath,
        scope: accountScope,
        target: onPage("navigation"),
      },
      ...navigationModules.map((id): PreferenceSearchEntry => ({
        id: navigationModuleAnchor(id),
        title: navigationLabels[id],
        path: [...navigationPath, t("preferences.sections.navigationModules")],
        scope: accountScope,
        target: onPage("navigation"),
      })),
      {
        id: "task-center-modules",
        title: t("preferences.sections.taskCenter"),
        description: t("preferences.sections.taskCenterDescription"),
        keywords: t("preferences.items.taskCenter.keywords"),
        path: navigationPath,
        scope: accountScope,
        target: onPage("navigation", "taskCenter"),
      },
      ...TASK_CENTER_OPTIONAL_MODULE_IDS.map((id): PreferenceSearchEntry => ({
        id: taskCenterModuleAnchor(id),
        title: taskCenterLabels[id],
        path: [...navigationPath, t("preferences.sections.taskCenter")],
        scope: accountScope,
        target: onPage("navigation", "taskCenter"),
      })),
      { id: "markdownDefaultViewMode", ...copy.markdownDefaultViewMode, path: editingPath, scope: accountScope, target: onPage("editing") },
      { id: "remoteImagePasteMode", ...copy.remoteImagePasteMode, path: editingPath, scope: accountScope, target: onPage("editing") },
      { id: "enableNoteTabs", ...copy.enableNoteTabs, path: editingPath, scope: accountScope, target: onPage("editing") },
      { id: "outlineDefaultOpen", ...copy.outlineDefaultOpen, path: editingPath, scope: accountScope, target: onPage("editing") },
      { id: "codeBlockWordWrap", ...copy.codeBlockWordWrap, path: editingMorePath, scope: accountScope, target: onPage("editing", "editingMore") },
      { id: "codeBlockCollapseMode", ...copy.codeBlockCollapseMode, path: editingMorePath, scope: accountScope, target: onPage("editing", "editingMore") },
      { id: "lockOnOpen", ...copy.lockOnOpen, path: editingMorePath, scope: accountScope, target: onPage("editing", "editingMore") },
      { id: "showTemplateManagement", ...copy.showTemplateManagement, path: generalPath, scope: accountScope, target: onPage("layout") },
      { id: "noteTitleAsAppTitle", ...copy.noteTitleAsAppTitle, path: generalPath, scope: accountScope, target: onPage("layout") },
      { id: "showNoteListDividers", ...copy.showNoteListDividers, path: generalPath, scope: accountScope, target: onPage("layout") },
      ...deviceEntries,
      ...(menuBar.supported
        ? [{ id: "desktopHideMenuBar", ...copy.desktopHideMenuBar, path: devicePath, scope: "device" as const, target: onPage("layout") }]
        : []),
      ...(showJournalPrivacy
        ? [{ id: "journal-privacy", ...copy.journalPrivacy, path: [relatedTabLabels.security], scope: accountScope, target: { kind: "tab" as const, tab: "security" as const, section: "journal-privacy" } }]
        : []),
      ...(showAIMemory
        ? [{ id: "ai-memory-archive", ...copy.aiMemoryArchive, path: [relatedTabLabels.ai], scope: "admin" as const, target: { kind: "tab" as const, tab: "ai" as const, section: "ai-memory-archive" } }]
        : []),
      ...(showWebUi
        ? [{ id: "web-ui-access", ...copy.webUi, path: [relatedTabLabels.users], scope: "admin" as const, target: { kind: "tab" as const, tab: "users" as const, section: "web-ui-access" } }]
        : []),
    ];
  };

  const trimmedQuery = query.trim();
  const results = trimmedQuery ? searchPreferences(buildSearchEntries(), trimmedQuery) : [];

  const openEntry = (entry: PreferenceSearchEntry) => {
    if (entry.target.kind === "tab") {
      onOpenRelatedSetting(entry.target.tab, entry.target.section);
      return;
    }
    navigate(entry.target.page, { reveal: entry.id, disclosure: entry.target.disclosure, from: "search" });
  };

  const resultButtons = () =>
    Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-preference-result]") ?? []);

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    } else if (event.key === "ArrowDown" && results.length > 0) {
      event.preventDefault();
      resultButtons()[0]?.focus();
    } else if (event.key === "Enter" && results.length > 0) {
      event.preventDefault();
      openEntry(results[0]);
    }
  };

  const handleResultKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const buttons = resultButtons();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (index === 0 ? searchRef.current : buttons[index - 1])?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
    }
  };

  const markdownRow = (
    <SegmentedRow
      anchorId="markdownDefaultViewMode"
      title={copy.markdownDefaultViewMode.title}
      description={copy.markdownDefaultViewMode.description}
      value={prefs.markdownDefaultViewMode}
      options={markdownModes}
      onChange={(value) => setPref("markdownDefaultViewMode", value)}
    />
  );
  const pasteRow = (
    <SelectRow
      anchorId="remoteImagePasteMode"
      title={copy.remoteImagePasteMode.title}
      description={copy.remoteImagePasteMode.description}
      value={prefs.remoteImagePasteMode}
      options={pasteModes}
      onChange={(value) => setPref("remoteImagePasteMode", value)}
    />
  );
  const noteTabsRow = (
    <SwitchRow
      anchorId="enableNoteTabs"
      title={copy.enableNoteTabs.title}
      description={copy.enableNoteTabs.description}
      checked={prefs.enableNoteTabs}
      onChange={(checked) => setPref("enableNoteTabs", checked)}
    />
  );

  const renderHome = () => (
    <>
      <header>
        <h3 ref={headingRef} tabIndex={-1} className="text-lg font-bold text-zinc-900 outline-none dark:text-zinc-100">
          {t("preferences.title")}
        </h3>
        <p className="mt-1 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{t("preferences.description")}</p>
      </header>

      <div className="relative">
        <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder={t("preferences.searchPlaceholder")}
          aria-label={t("preferences.searchLabel")}
          aria-controls={trimmedQuery ? resultsId : undefined}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          data-preferences-search=""
          className="h-10 w-full rounded-xl border border-zinc-200 bg-white pl-9 pr-9 text-base text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 hover:border-zinc-300 focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-700 sm:text-sm [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              searchRef.current?.focus();
            }}
            aria-label={t("preferences.clearSearch")}
            className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {trimmedQuery ? t("preferences.resultCount", { count: results.length }) : ""}
      </p>

      {(localMode || syncOff) && (
        <p role="note" className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
          {localMode ? t("preferences.localModeHint") : t("preferences.syncOffHint")}
        </p>
      )}

      {trimmedQuery ? (
        <div id={resultsId} data-preferences-results="">
          {results.length > 0 ? (
            <PreferenceGroup title={t("preferences.resultsLabel")}>
              {results.map((entry, index) => (
                <LinkRow
                  key={entry.id}
                  title={entry.title}
                  description={entry.path.join(" › ")}
                  scope={entry.scope}
                  onClick={() => openEntry(entry)}
                  onKeyDown={(event) => handleResultKeyDown(event, index)}
                  dataAttributes={{ "data-preference-result": entry.id }}
                />
              ))}
            </PreferenceGroup>
          ) : (
            <p className="px-1 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
              {t("preferences.noResults", { query: trimmedQuery })}
            </p>
          )}
        </div>
      ) : (
        <>
          <PreferenceGroup title={t("preferences.common")} scope={accountScope}>
            {noteTabsRow}
            {markdownRow}
            {pasteRow}
          </PreferenceGroup>

          <PreferenceGroup title={t("preferences.more")}>
            <LinkRow
              anchorId="category-navigation"
              icon={PanelLeft}
              title={categoryTitles.navigation}
              description={t("preferences.categories.navigation.summary", {
                visible: navigationModules.filter((id) => !prefs.hiddenNavigationModules.includes(id)).length,
                total: navigationModules.length,
              })}
              trailing={t("preferences.manage")}
              onClick={() => navigate("navigation", { from: "category-navigation" })}
            />
            <LinkRow
              anchorId="category-editing"
              icon={PenLine}
              title={categoryTitles.editing}
              description={t("preferences.categories.editing.summary")}
              onClick={() => navigate("editing", { from: "category-editing" })}
            />
            <LinkRow
              anchorId="category-layout"
              icon={AppWindow}
              title={categoryTitles.layout}
              description={t("preferences.categories.layout.summary")}
              onClick={() => navigate("layout", { from: "category-layout" })}
            />
            {showAdvanced && (
              <LinkRow
                anchorId="category-advanced"
                icon={Settings2}
                title={categoryTitles.advanced}
                description={t("preferences.categories.advanced.summary")}
                onClick={() => navigate("advanced", { from: "category-advanced" })}
              />
            )}
          </PreferenceGroup>
        </>
      )}
    </>
  );

  const renderNavigation = () => (
    <>
      <SubpageHeader
        title={categoryTitles.navigation}
        description={t("preferences.categories.navigation.description")}
        scope={accountScope}
        onBack={goHome}
        headingRef={headingRef}
      />
      <NavigationModulesGroup modules={navigationModules} />
      <TaskCenterModulesGroup open={taskCenterOpen} onOpenChange={setTaskCenterOpen} />
    </>
  );

  const renderEditing = () => (
    <>
      <SubpageHeader
        title={categoryTitles.editing}
        description={t("preferences.categories.editing.description")}
        scope={accountScope}
        onBack={goHome}
        headingRef={headingRef}
      />
      <PreferenceGroup>
        {markdownRow}
        {pasteRow}
        {noteTabsRow}
        <SwitchRow
          anchorId="outlineDefaultOpen"
          title={copy.outlineDefaultOpen.title}
          description={copy.outlineDefaultOpen.description}
          checked={prefs.outlineDefaultOpen}
          onChange={(checked) => setPref("outlineDefaultOpen", checked)}
        />
        <DisclosureRow
          anchorId="editing-more"
          title={t("preferences.moreOptions")}
          summary={t("preferences.editingMoreSummary")}
          open={editingMoreOpen}
          onOpenChange={setEditingMoreOpen}
        >
          <SwitchRow
            anchorId="codeBlockWordWrap"
            title={copy.codeBlockWordWrap.title}
            description={copy.codeBlockWordWrap.description}
            checked={prefs.codeBlockWordWrap}
            onChange={(checked) => setPref("codeBlockWordWrap", checked)}
          />
          <SelectRow
            anchorId="codeBlockCollapseMode"
            title={copy.codeBlockCollapseMode.title}
            description={copy.codeBlockCollapseMode.description}
            value={prefs.codeBlockCollapseMode}
            options={collapseModes}
            onChange={(value) => setPref("codeBlockCollapseMode", value)}
          />
          <SwitchRow
            anchorId="lockOnOpen"
            title={copy.lockOnOpen.title}
            description={copy.lockOnOpen.description}
            checked={prefs.lockOnOpen}
            onChange={(checked) => setPref("lockOnOpen", checked)}
          />
        </DisclosureRow>
      </PreferenceGroup>
    </>
  );

  const renderLayout = () => (
    <>
      <SubpageHeader
        title={categoryTitles.layout}
        description={t("preferences.categories.layout.description")}
        onBack={goHome}
        headingRef={headingRef}
      />
      <PreferenceGroup title={t("preferences.sections.general")} scope={accountScope}>
        <SwitchRow
          anchorId="showTemplateManagement"
          title={copy.showTemplateManagement.title}
          description={copy.showTemplateManagement.description}
          checked={prefs.showTemplateManagement}
          onChange={(checked) => setPref("showTemplateManagement", checked)}
        />
        <SwitchRow
          anchorId="noteTitleAsAppTitle"
          title={copy.noteTitleAsAppTitle.title}
          description={copy.noteTitleAsAppTitle.description}
          checked={prefs.noteTitleAsAppTitle}
          onChange={(checked) => setPref("noteTitleAsAppTitle", checked)}
        />
        <SwitchRow
          anchorId="showNoteListDividers"
          title={copy.showNoteListDividers.title}
          description={copy.showNoteListDividers.description}
          checked={prefs.showNoteListDividers}
          onChange={(checked) => setPref("showNoteListDividers", checked)}
        />
      </PreferenceGroup>
      <PreferenceGroup title={deviceSectionTitle} scope="device">
        {surface === "mobile" ? (
          <>
            <SwitchRow
              anchorId="mobileRailHidden"
              title={copy.mobileRailHidden.title}
              description={copy.mobileRailHidden.description}
              checked={device.mobileRailHidden}
              onChange={device.setMobileRailHidden}
            />
            <SwitchRow
              anchorId="mobileKnowledgeTreeMode"
              title={copy.mobileKnowledgeTreeMode.title}
              description={copy.mobileKnowledgeTreeMode.description}
              checked={device.mobileTreeEnabled}
              onChange={device.setMobileTreeEnabled}
            />
            <SwitchRow
              anchorId="mobileKnowledgeTreeCompact"
              title={copy.mobileKnowledgeTreeCompact.title}
              description={copy.mobileKnowledgeTreeCompact.description}
              checked={device.mobileTreeCompact}
              onChange={device.setMobileTreeCompact}
            />
          </>
        ) : (
          <SwitchRow
            anchorId="desktopKnowledgeTreeMode"
            title={copy.desktopKnowledgeTreeMode.title}
            description={copy.desktopKnowledgeTreeMode.description}
            checked={device.desktopQuickBrowse}
            onChange={device.setDesktopQuickBrowse}
          />
        )}
        {menuBar.supported && (
          <SwitchRow
            anchorId="desktopHideMenuBar"
            title={copy.desktopHideMenuBar.title}
            description={copy.desktopHideMenuBar.description}
            checked={menuBar.hidden}
            busy={menuBar.saving}
            onChange={(checked) => void menuBar.setMenuBarHidden(checked)}
          />
        )}
      </PreferenceGroup>
    </>
  );

  const renderAdvanced = () => (
    <>
      <SubpageHeader
        title={categoryTitles.advanced}
        description={t("preferences.categories.advanced.description")}
        onBack={goHome}
        headingRef={headingRef}
      />
      {showJournalPrivacy && (
        <PreferenceGroup title={t("preferences.sections.privacy")}>
          <LinkRow
            anchorId="journal-privacy"
            icon={ShieldCheck}
            title={copy.journalPrivacy.title}
            description={copy.journalPrivacy.description}
            scope={accountScope}
            trailing={relatedTabLabels.security}
            onClick={() => onOpenRelatedSetting("security", "journal-privacy")}
          />
        </PreferenceGroup>
      )}
      {(showAIMemory || showWebUi) && (
        <PreferenceGroup title={t("preferences.sections.admin")}>
          {showAIMemory && (
            <LinkRow
              anchorId="ai-memory-archive"
              icon={Bot}
              title={copy.aiMemoryArchive.title}
              description={copy.aiMemoryArchive.description}
              scope="admin"
              trailing={relatedTabLabels.ai}
              onClick={() => onOpenRelatedSetting("ai", "ai-memory-archive")}
            />
          )}
          {showWebUi && (
            <LinkRow
              anchorId="web-ui-access"
              icon={Globe}
              title={copy.webUi.title}
              description={copy.webUi.description}
              scope="admin"
              trailing={relatedTabLabels.users}
              onClick={() => onOpenRelatedSetting("users", "web-ui-access")}
            />
          )}
        </PreferenceGroup>
      )}
    </>
  );

  return (
    <div ref={rootRef} data-preferences-page={page} className="space-y-5">
      {page === "home" && renderHome()}
      {page === "navigation" && renderNavigation()}
      {page === "editing" && renderEditing()}
      {page === "layout" && renderLayout()}
      {page === "advanced" && renderAdvanced()}
    </div>
  );
}
