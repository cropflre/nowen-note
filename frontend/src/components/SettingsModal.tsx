import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Palette, Shield, Database, X, Settings, Camera, Save, Loader2, Trash2, Upload, Type, Check, ChevronDown, Globe, Bot, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import ThemeToggle from "@/components/ThemeToggle";
import SecuritySettings from "@/components/SecuritySettings";
import DataManager from "@/components/DataManager";
import AISettingsPanel from "@/components/AISettingsPanel";
import UserManagement from "@/components/UserManagement";
import { useSiteSettings, BUILTIN_FONTS, getBuiltinFontName } from "@/hooks/useSiteSettings";
import { api } from "@/lib/api";
import { CustomFont } from "@/types";
import { cn } from "@/lib/utils";

type TabId = "appearance" | "ai" | "security" | "data" | "users";

interface SettingsModalProps {
  onClose: () => void;
  defaultTab?: TabId;
}

function AppearancePanel() {
  const { t, i18n } = useTranslation();
  const { siteConfig, updateSiteConfig, updateEditorFont } = useSiteSettings();
  const [title, setTitle] = useState(siteConfig.title);
  const [previewIcon, setPreviewIcon] = useState(siteConfig.favicon);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 字体状态
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([]);
  const [fontDropdownOpen, setFontDropdownOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [isSwitchingFont, setIsSwitchingFont] = useState(false);
  const fontFileRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 加载自定义字体列表
  const loadFonts = useCallback(async () => {
    try {
      const fonts = await api.getFonts();
      setCustomFonts(fonts);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadFonts(); }, [loadFonts]);

  // 点击外部关闭下拉
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setFontDropdownOpen(false);
      }
    };
    if (fontDropdownOpen) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [fontDropdownOpen]);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setSaveMessage(t('settings.iconTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      setPreviewIcon(reader.result as string);
      setSaveMessage("");
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveIcon = () => {
    setPreviewIcon("");
    setSaveMessage("");
  };

  const handleSave = async () => {
    if (!title.trim()) return;
    setIsSaving(true);
    setSaveMessage("");
    try {
      await updateSiteConfig(title.trim(), previewIcon);
      setSaveMessage(t('settings.saveSuccess'));
      setTimeout(() => setSaveMessage(""), 2000);
    } catch {
      setSaveMessage(t('settings.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const hasChanges = title !== siteConfig.title || previewIcon !== siteConfig.favicon;

  // 当前字体的显示名
  const currentFontName = (() => {
    const builtin = BUILTIN_FONTS.find(f => f.id === siteConfig.editorFontFamily);
    if (builtin) return getBuiltinFontName(builtin);
    const custom = customFonts.find(f => f.id === siteConfig.editorFontFamily);
    return custom ? custom.name : t('settings.interDefault');
  })();

  const handleSelectFont = async (fontId: string) => {
    setIsSwitchingFont(true);
    setFontDropdownOpen(false);
    try {
      await updateEditorFont(fontId);
    } catch { /* ignore */ }
    setIsSwitchingFont(false);
  };

  const handleUploadFonts = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsUploading(true);
    setUploadMessage("");
    setUploadSuccess(false);
    try {
      const result = await api.uploadFonts(files);
      const msgs: string[] = [];
      if (result.uploaded.length > 0) msgs.push(t('settings.fontUploadSuccess', { count: result.uploaded.length }));
      if (result.errors.length > 0) msgs.push(result.errors.join("; "));
      setUploadMessage(msgs.join(" · "));
      setUploadSuccess(result.uploaded.length > 0);
      await loadFonts();
      setTimeout(() => { setUploadMessage(""); setUploadSuccess(false); }, 4000);
    } catch (err: any) {
      setUploadMessage(err.message || t('settings.fontUploadFailed'));
      setUploadSuccess(false);
    } finally {
      setIsUploading(false);
      if (fontFileRef.current) fontFileRef.current.value = "";
    }
  };

  const handleDeleteFont = async (fontId: string) => {
    try {
      await api.deleteFont(fontId);
      // 如果删的是当前字体，回退默认
      if (siteConfig.editorFontFamily === fontId) {
        await updateEditorFont("");
      }
      await loadFonts();
    } catch { /* ignore */ }
  };

  return (
    <div className="space-y-6">
      {/* 站点标识 */}
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">{t('settings.siteIdentity')}</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">{t('settings.siteIdentityDesc')}</p>

        <div className="flex flex-col sm:flex-row gap-6 items-start">
          {/* Logo 上传区域 */}
          <div className="flex flex-col items-center gap-2.5">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('settings.siteIcon')}</span>
            <div
              className="relative w-20 h-20 rounded-2xl border-2 border-dashed border-zinc-300 dark:border-zinc-700 flex items-center justify-center overflow-hidden group cursor-pointer hover:border-accent-primary transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              {previewIcon ? (
                <img src={previewIcon} alt="Site Icon" className="w-full h-full object-cover" />
              ) : (
                <div className="flex flex-col items-center gap-1 text-zinc-400 dark:text-zinc-600">
                  <Camera size={20} />
                  <span className="text-[10px]">{t('settings.upload')}</span>
                </div>
              )}
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                <Camera className="w-5 h-5 text-white" />
              </div>
            </div>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageChange}
              accept="image/png,image/jpeg,image/svg+xml,image/x-icon,image/webp"
              className="hidden"
            />
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500">PNG/SVG/ICO · &lt;1MB</span>
              {previewIcon && (
                <button
                  onClick={handleRemoveIcon}
                  className="text-[10px] text-red-500 hover:text-red-400 transition-colors"
                >
                  {t('settings.remove')}
                </button>
              )}
            </div>
          </div>

          {/* 站点名称 */}
          <div className="flex-1 space-y-3 w-full">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('settings.siteName')}</label>
              <input
                type="text"
                value={title}
                onChange={(e) => { setTitle(e.target.value); setSaveMessage(""); }}
                maxLength={20}
                className="w-full px-3 py-2 bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-lg text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-accent-primary/40 focus:border-accent-primary outline-none transition-all placeholder:text-zinc-400"
                placeholder={t('settings.siteNamePlaceholder')}
              />
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500 text-right">{title.length} / 20</p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleSave}
                disabled={isSaving || !title.trim() || !hasChanges}
                className="flex items-center justify-center gap-1.5 px-4 py-1.5 bg-accent-primary hover:bg-accent-primary/90 text-white rounded-lg text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {t('settings.saveChanges')}
              </button>
              {saveMessage && (
                <span className={`text-xs ${saveMessage === t('settings.saveSuccess') ? "text-emerald-500" : "text-red-500"}`}>
                  {saveMessage}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 分割线 */}
      <div className="h-px bg-zinc-200 dark:bg-zinc-800" />

      {/* 外观与主题 */}
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">{t('settings.appearanceTheme')}</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">{t('settings.appearanceThemeDesc')}</p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
          <div>
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('settings.themeMode')}</span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings.themeModeDesc')}</p>
          </div>
          <ThemeToggle />
        </div>

        {/* 编辑器字体 - 可交互 */}
        <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('settings.editorFont')}</span>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('settings.editorFontDesc')}</p>
            </div>
            {isSwitchingFont && <Loader2 size={14} className="animate-spin text-accent-primary" />}
          </div>

          {/* 字体选择器下拉 */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setFontDropdownOpen(!fontDropdownOpen)}
              className="w-full flex items-center justify-between px-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-sm text-zinc-900 dark:text-zinc-100 hover:border-accent-primary/50 transition-colors"
            >
              <span className="flex items-center gap-2">
                <Type size={14} className="text-zinc-400" />
                {currentFontName}
              </span>
              <ChevronDown size={14} className={cn("text-zinc-400 transition-transform", fontDropdownOpen && "rotate-180")} />
            </button>

            <AnimatePresence>
              {fontDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15 }}
                  className="absolute z-50 top-full left-0 mt-1 w-full max-h-64 overflow-y-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-xl"
                >
                  {/* 内置字体 */}
                  <div className="px-2 pt-2 pb-1">
                    <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider px-2">{t('settings.builtinFonts')}</span>
                  </div>
                  {BUILTIN_FONTS.map(font => (
                    <button
                      key={font.id}
                      onClick={() => handleSelectFont(font.id)}
                      className="w-full flex items-center justify-between px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors"
                    >
                      <span style={{ fontFamily: font.family }}>{getBuiltinFontName(font)}</span>
                      {siteConfig.editorFontFamily === font.id && <Check size={14} className="text-accent-primary" />}
                    </button>
                  ))}

                  {/* 自定义字体 */}
                  {customFonts.length > 0 && (
                    <>
                      <div className="h-px bg-zinc-100 dark:bg-zinc-800 mx-2 my-1" />
                      <div className="px-2 pt-1 pb-1">
                        <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider px-2">{t('settings.importedFonts')}</span>
                      </div>
                      {customFonts.map(font => (
                        <div
                          key={font.id}
                          className="flex items-center justify-between px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors group"
                        >
                          <button
                            onClick={() => handleSelectFont(font.id)}
                            className="flex-1 text-left text-sm text-zinc-700 dark:text-zinc-300"
                          >
                            {font.name}
                            <span className="ml-2 text-[10px] text-zinc-400">.{font.format}</span>
                          </button>
                          <div className="flex items-center gap-1.5">
                            {siteConfig.editorFontFamily === font.id && <Check size={14} className="text-accent-primary" />}
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDeleteFont(font.id); }}
                              className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-400 hover:text-red-500 transition-all"
                              title={t('settings.deleteFont')}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* 字体导入 */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => fontFileRef.current?.click()}
              disabled={isUploading}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg text-xs text-zinc-600 dark:text-zinc-400 hover:border-accent-primary/50 hover:text-accent-primary transition-colors disabled:opacity-50"
            >
              {isUploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              {t('settings.importFont')}
            </button>
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{t('settings.importFontHint')}</span>
            <input
              type="file"
              ref={fontFileRef}
              onChange={handleUploadFonts}
              accept=".otf,.otc,.ttc,.ttf,.woff,.woff2"
              multiple
              className="hidden"
            />
          </div>

          {uploadMessage && (
            <p className={cn("text-xs", uploadSuccess ? "text-emerald-500" : "text-amber-500")}>{uploadMessage}</p>
          )}

          {/* 字体预览 */}
          <div
            className="px-3 py-3 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-950"
            style={{ fontFamily: "var(--editor-font-family)" }}
          >
            <p className="text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed">
              {t('settings.fontPreviewEn')}
            </p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed mt-1">
              {t('settings.fontPreviewZh')}
            </p>
          </div>
        </div>

        {/* 语言切换 */}
        <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-zinc-500 dark:text-zinc-400" />
            <div>
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('language.label')}</span>
            </div>
          </div>
          <div className="flex items-center gap-1 p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800">
            {([
              { code: "zh-CN", label: t('language.zh') },
              { code: "en", label: t('language.en') },
            ] as const).map(lang => (
              <button
                key={lang.code}
                onClick={() => i18n.changeLanguage(lang.code)}
                className={cn(
                  "relative px-3 py-1 rounded-md text-xs font-medium transition-colors",
                  i18n.language === lang.code
                    ? "bg-white dark:bg-zinc-700 text-accent-primary shadow-sm"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
                )}
              >
                {lang.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const SettingsModal = React.forwardRef<HTMLDivElement, SettingsModalProps>(
  function SettingsModal({ onClose, defaultTab = "appearance" }, ref) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab);
  const { siteConfig } = useSiteSettings();
  const [currentUser, setCurrentUser] = useState<{ id: string; role?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((u) => { if (!cancelled) setCurrentUser({ id: u.id, role: (u as any).role }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const isAdmin = currentUser?.role === "admin";

  const SETTING_TABS = [
    { id: "appearance" as const, label: t('settings.appearance'), icon: Palette },
    { id: "ai" as const, label: t('settings.ai'), icon: Bot },
    { id: "security" as const, label: t('settings.security'), icon: Shield },
    ...(isAdmin ? [{ id: "users" as const, label: t('settings.users'), icon: Users }] : []),
    { id: "data" as const, label: t('settings.dataManagement'), icon: Database },
  ];

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-0 md:p-4 md:sm:p-6"
    >
      {/* 背景遮罩 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-zinc-900/40 dark:bg-black/60 backdrop-blur-sm"
      />

      {/* 模态框主体 */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ type: "spring", duration: 0.5, bounce: 0 }}
        className="relative w-full max-w-4xl h-[80vh] min-h-[500px] flex flex-col md:flex-row overflow-hidden bg-white dark:bg-zinc-950 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 max-md:h-[100dvh] max-md:max-w-none max-md:rounded-none max-md:border-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 移动端：顶部标签栏 + 关闭按钮 */}
        <div className="md:hidden flex items-center border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50" style={{ paddingTop: 'var(--safe-area-top)' }}>
          <div className="flex-1 flex items-center gap-1 px-3 py-2 overflow-x-auto no-scrollbar">
            {SETTING_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors shrink-0",
                    isActive
                      ? "bg-zinc-200/70 dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400"
                      : "text-zinc-500 dark:text-zinc-400 active:bg-zinc-200/40 dark:active:bg-zinc-800/50"
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
          <button
            onClick={onClose}
            className="p-2 mr-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-lg transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 桌面端：左侧导航栏 */}
        <div className="hidden md:flex w-56 flex-shrink-0 bg-zinc-50 dark:bg-zinc-900/50 border-r border-zinc-200 dark:border-zinc-800 p-4 flex-col">
          <div className="flex items-center gap-2 mb-6 px-2">
            <Settings className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
            <span className="font-bold text-sm text-zinc-900 dark:text-zinc-100">{t('settings.title')}</span>
          </div>

          <nav className="flex-1 space-y-0.5">
            {SETTING_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-zinc-200/70 dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400"
                      : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-200"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* 底部版本信息：版本号由 vite.config.ts 从根 package.json 注入 */}
          <div className="mt-auto pt-4 border-t border-zinc-200 dark:border-zinc-800 px-2">
            <p className="text-xs text-zinc-400 dark:text-zinc-600">{siteConfig.title} v{__APP_VERSION__}</p>
          </div>
        </div>

        {/* 右侧内容区 */}
        <div className="flex-1 overflow-y-auto relative">
          {/* 关闭按钮 — 桌面端 */}
          <button
            onClick={onClose}
            className="hidden md:block absolute top-4 right-4 p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors z-10"
          >
            <X className="w-4 h-4" />
          </button>

          {/* 动态渲染内容 */}
          <div className="p-4 md:p-8 md:pr-14">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.15 }}
              >
                {activeTab === "appearance" && <AppearancePanel />}
                {activeTab === "ai" && <AISettingsPanel />}
                {activeTab === "security" && <SecuritySettings />}
                {activeTab === "users" && isAdmin && <UserManagement currentUserId={currentUser?.id ?? null} />}
                {activeTab === "data" && <DataManager />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
});

export default SettingsModal;
