import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Contrast,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  Loader2,
  Play,
  Plus,
  Presentation,
  Printer,
  Sparkles,
  StickyNote,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import type {
  NoteEditorHandle,
  NoteEditorHeading,
  NoteEditorProps,
} from "@/components/editors/types";
import {
  PPT_LAYOUTS,
  PPT_THEMES,
  createSlide,
  extractPptPlainText,
  outlineTextToPptDeck,
  parsePptDeckJson,
  parsePptx,
  serializePptDeckJson,
  type PptDeckIR,
  type PptLayoutId,
  type PptSlide,
  type PptThemeId,
} from "@/office";
import { exportPptDeckToFile, pickPptxFile } from "@/lib/pptNoteService";
import { api } from "@/lib/api";
import {
  shouldSkipTitleChange,
  shouldSyncTitleValue,
} from "@/lib/titleIme";
import { toast } from "@/lib/toast";
import "./PptDocumentEditor.css";

const SAVE_DEBOUNCE_MS = 500;
const HIGH_CONTRAST_LS_KEY = "nowen.ppt_editor.high_contrast";

function readHighContrastPref(): boolean {
  try {
    return localStorage.getItem(HIGH_CONTRAST_LS_KEY) === "1";
  } catch {
    return false;
  }
}

function layoutLabel(layout: PptLayoutId): string {
  return PPT_LAYOUTS.find((l) => l.id === layout)?.label || "标题与要点";
}

function SlideCanvasView({
  slide,
  slideIndex,
  totalSlides,
  themeId,
  editable,
  presenting = false,
  onPatchSlide,
  onPickImage,
}: {
  slide: PptSlide;
  slideIndex: number;
  totalSlides: number;
  themeId: PptThemeId;
  editable: boolean;
  presenting?: boolean;
  onPatchSlide?: (patch: Partial<PptSlide>) => void;
  onPickImage?: () => void;
}) {
  const theme = PPT_THEMES[themeId] || PPT_THEMES["classic-light"];
  const styleVars = {
    "--ppt-bg": theme.bg,
    "--ppt-surface": theme.surface,
    "--ppt-text": theme.text,
    "--ppt-muted": theme.muted,
    "--ppt-accent": theme.accent,
    "--ppt-accent-soft": theme.accentSoft,
    "--ppt-border": theme.border,
  } as React.CSSProperties;

  const canEdit = editable && !presenting && Boolean(onPatchSlide);

  const updateBullet = (listKey: "bullets" | "rightBullets", idx: number, value: string) => {
    if (!onPatchSlide) return;
    const list = [...(slide[listKey] || [])];
    list[idx] = value;
    onPatchSlide({ [listKey]: list });
  };

  const addBullet = (listKey: "bullets" | "rightBullets", afterIdx?: number) => {
    if (!onPatchSlide) return;
    const list = [...(slide[listKey] || [])];
    const insertAt = afterIdx === undefined ? list.length : afterIdx + 1;
    list.splice(insertAt, 0, "");
    onPatchSlide({ [listKey]: list });
  };

  const removeBullet = (listKey: "bullets" | "rightBullets", idx: number) => {
    if (!onPatchSlide) return;
    const list = [...(slide[listKey] || [])];
    list.splice(idx, 1);
    onPatchSlide({ [listKey]: list });
  };

  const renderBulletList = (listKey: "bullets" | "rightBullets", labelPrefix: string) => {
    const items = slide[listKey] || [];
    return (
      <div className="flex flex-col gap-2 min-h-0 flex-1 overflow-y-auto pr-1">
        {items.length === 0 && !canEdit && (
          <p className="text-sm opacity-60">（暂无要点）</p>
        )}
        {items.map((item, idx) => (
          <div key={`${listKey}-${idx}`} className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
              style={{ background: theme.accent }}
            />
            {canEdit ? (
              <>
                <input
                  type="text"
                  value={item}
                  aria-label={`${labelPrefix}第 ${idx + 1} 条`}
                  placeholder="输入要点内容，回车新增下一条…"
                  onChange={(e) => updateBullet(listKey, idx, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      addBullet(listKey, idx);
                    } else if (e.key === "Backspace" && !item && items.length > 1) {
                      e.preventDefault();
                      removeBullet(listKey, idx);
                    }
                  }}
                  className="ppt-slide-input px-1.5 py-0.5 text-sm sm:text-base leading-relaxed"
                />
                <button
                  type="button"
                  onClick={() => removeBullet(listKey, idx)}
                  aria-label={`删除${labelPrefix}第 ${idx + 1} 条`}
                  className="mt-0.5 rounded p-1 opacity-55 hover:opacity-100 focus-visible:opacity-100"
                  style={{ color: theme.muted }}
                >
                  <X size={13} />
                </button>
              </>
            ) : (
              <span className={presenting ? "text-xl sm:text-2xl leading-relaxed" : "text-sm sm:text-base leading-relaxed"}>
                {item}
              </span>
            )}
          </div>
        ))}
        {canEdit && (
          <button
            type="button"
            onClick={() => addBullet(listKey)}
            className="mt-1 inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-xs font-medium"
            style={{ background: theme.accentSoft, color: theme.accent }}
          >
            <Plus size={13} />
            添加要点
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      className={presenting ? "ppt-present-slide" : "ppt-slide-canvas"}
      style={styleVars}
      data-ppt-layout={slide.layout}
      data-ppt-theme={theme.id}
    >
      <div className="ppt-slide-top-bar" aria-hidden="true" />

      {slide.layout === "cover" ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center gap-4 px-4">
          {canEdit ? (
            <input
              type="text"
              value={slide.title}
              aria-label="封面主标题"
              placeholder="输入演示文稿主标题"
              onChange={(e) => onPatchSlide?.({ title: e.target.value })}
              className="ppt-slide-input text-center text-2xl sm:text-4xl font-bold px-2 py-1"
            />
          ) : (
            <h1 className={presenting ? "text-4xl sm:text-5xl font-bold leading-tight" : "text-2xl sm:text-4xl font-bold leading-tight"}>
              {slide.title || "演示文稿标题"}
            </h1>
          )}
          <div className="h-1 w-24 rounded-full" style={{ background: theme.accent }} aria-hidden="true" />
          {canEdit ? (
            <input
              type="text"
              value={slide.subtitle || ""}
              aria-label="封面副标题"
              placeholder="输入副标题、汇报人或日期"
              onChange={(e) => onPatchSlide?.({ subtitle: e.target.value })}
              className="ppt-slide-input text-center text-sm sm:text-lg px-2 py-1"
              style={{ color: theme.muted }}
            />
          ) : slide.subtitle ? (
            <p className={presenting ? "text-xl sm:text-2xl" : "text-sm sm:text-lg"} style={{ color: theme.muted }}>
              {slide.subtitle}
            </p>
          ) : null}
        </div>
      ) : slide.layout === "section" ? (
        <div className="flex flex-1 items-center gap-5 px-4">
          <div className="w-2 self-stretch my-8 rounded-full shrink-0" style={{ background: theme.accent }} aria-hidden="true" />
          <div className="flex-1 flex flex-col gap-3">
            {canEdit ? (
              <>
                <input
                  type="text"
                  value={slide.title}
                  aria-label="章节标题"
                  placeholder="输入章节标题"
                  onChange={(e) => onPatchSlide?.({ title: e.target.value })}
                  className="ppt-slide-input text-2xl sm:text-4xl font-bold px-2 py-1"
                />
                <input
                  type="text"
                  value={slide.subtitle || ""}
                  aria-label="章节副标题"
                  placeholder="输入章节引导说明（可选）"
                  onChange={(e) => onPatchSlide?.({ subtitle: e.target.value })}
                  className="ppt-slide-input text-sm sm:text-lg px-2 py-1"
                  style={{ color: theme.muted }}
                />
              </>
            ) : (
              <>
                <h2 className={presenting ? "text-4xl sm:text-5xl font-bold" : "text-2xl sm:text-4xl font-bold"}>
                  {slide.title}
                </h2>
                {slide.subtitle && (
                  <p className={presenting ? "text-xl" : "text-base"} style={{ color: theme.muted }}>
                    {slide.subtitle}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      ) : slide.layout === "quote" ? (
        <div className="flex flex-1 flex-col gap-4">
          {canEdit ? (
            <input
              type="text"
              value={slide.title}
              aria-label="幻灯片标题"
              placeholder="标题（如：核心观点）"
              onChange={(e) => onPatchSlide?.({ title: e.target.value })}
              className="ppt-slide-input text-lg sm:text-xl font-bold px-1.5 py-0.5"
              style={{ color: theme.accent }}
            />
          ) : (
            <h2 className={presenting ? "text-2xl font-bold" : "text-lg font-bold"} style={{ color: theme.accent }}>
              {slide.title}
            </h2>
          )}
          <div
            className="flex-1 rounded-xl p-6 flex flex-col justify-center gap-4 border"
            style={{ background: theme.surface, borderColor: theme.accent }}
          >
            {canEdit ? (
              <>
                <textarea
                  value={slide.quote || ""}
                  aria-label="引用正文"
                  placeholder="输入要突出的核心观点或引言…"
                  rows={3}
                  onChange={(e) => onPatchSlide?.({ quote: e.target.value })}
                  className="ppt-slide-textarea text-center text-lg sm:text-2xl italic leading-relaxed px-2 py-1 resize-none"
                />
                <input
                  type="text"
                  value={slide.quoteAuthor || ""}
                  aria-label="引用出处或署名"
                  placeholder="—— 出处 / 署名"
                  onChange={(e) => onPatchSlide?.({ quoteAuthor: e.target.value })}
                  className="ppt-slide-input text-right text-sm sm:text-base px-2 py-0.5"
                  style={{ color: theme.muted }}
                />
              </>
            ) : (
              <>
                <blockquote className={presenting ? "text-center text-3xl italic leading-relaxed" : "text-center text-xl italic leading-relaxed"}>
                  {slide.quote}
                </blockquote>
                {slide.quoteAuthor && (
                  <p className="text-right text-base" style={{ color: theme.muted }}>
                    {slide.quoteAuthor}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      ) : slide.layout === "two-column" ? (
        <div className="flex flex-1 flex-col gap-4 min-h-0">
          {canEdit ? (
            <input
              type="text"
              value={slide.title}
              aria-label="幻灯片标题"
              placeholder="输入页面标题"
              onChange={(e) => onPatchSlide?.({ title: e.target.value })}
              className="ppt-slide-input text-xl sm:text-2xl font-bold px-1.5 py-0.5 shrink-0"
            />
          ) : (
            <h2 className={presenting ? "text-3xl font-bold shrink-0" : "text-xl sm:text-2xl font-bold shrink-0"}>
              {slide.title}
            </h2>
          )}
          <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">
            <div
              className="rounded-lg p-3.5 border flex flex-col gap-2 min-h-0"
              style={{ background: theme.surface, borderColor: theme.border }}
            >
              {renderBulletList("bullets", "左栏要点")}
            </div>
            <div
              className="rounded-lg p-3.5 border flex flex-col gap-2 min-h-0"
              style={{ background: theme.surface, borderColor: theme.border }}
            >
              {canEdit ? (
                <input
                  type="text"
                  value={slide.rightTitle || ""}
                  aria-label="右栏标题"
                  placeholder="右栏标题（可选）"
                  onChange={(e) => onPatchSlide?.({ rightTitle: e.target.value })}
                  className="ppt-slide-input text-sm sm:text-base font-semibold px-1.5 py-0.5 shrink-0"
                  style={{ color: theme.accent }}
                />
              ) : slide.rightTitle ? (
                <h3 className={presenting ? "text-xl font-semibold shrink-0" : "text-base font-semibold shrink-0"} style={{ color: theme.accent }}>
                  {slide.rightTitle}
                </h3>
              ) : null}
              {renderBulletList("rightBullets", "右栏要点")}
            </div>
          </div>
        </div>
      ) : slide.layout === "text-image" ? (
        <div className="flex flex-1 flex-col gap-4 min-h-0">
          {canEdit ? (
            <input
              type="text"
              value={slide.title}
              aria-label="幻灯片标题"
              placeholder="输入图文页标题"
              onChange={(e) => onPatchSlide?.({ title: e.target.value })}
              className="ppt-slide-input text-xl sm:text-2xl font-bold px-1.5 py-0.5 shrink-0"
            />
          ) : (
            <h2 className={presenting ? "text-3xl font-bold shrink-0" : "text-xl sm:text-2xl font-bold shrink-0"}>
              {slide.title}
            </h2>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1 min-h-0">
            <div className="flex flex-col min-h-0">
              {renderBulletList("bullets", "要点")}
            </div>
            <div
              className="rounded-lg border flex flex-col items-center justify-center p-2 gap-2 overflow-hidden min-h-0"
              style={{ background: theme.surface, borderColor: theme.border }}
            >
              {slide.imageUrl ? (
                <>
                  <img
                    src={slide.imageUrl}
                    alt={slide.imageAlt || slide.title || "幻灯片配图"}
                    className="max-h-full max-w-full object-contain rounded flex-1 min-h-0"
                  />
                  {canEdit && (
                    <div className="flex w-full items-center gap-1.5 shrink-0">
                      <input
                        type="text"
                        value={slide.imageAlt || ""}
                        aria-label="图片替代文本"
                        placeholder="图片说明（无障碍替代文本）"
                        onChange={(e) => onPatchSlide?.({ imageAlt: e.target.value })}
                        className="ppt-slide-input text-xs px-1.5 py-0.5 flex-1"
                        style={{ color: theme.muted }}
                      />
                      <button
                        type="button"
                        onClick={onPickImage}
                        className="rounded px-2 py-0.5 text-xs shrink-0"
                        style={{ background: theme.accentSoft, color: theme.accent }}
                      >
                        更换
                      </button>
                      <button
                        type="button"
                        onClick={() => onPatchSlide?.({ imageUrl: "", imageAlt: "" })}
                        aria-label="移除配图"
                        className="rounded p-1 shrink-0"
                        style={{ color: theme.muted }}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  )}
                </>
              ) : canEdit ? (
                <button
                  type="button"
                  onClick={onPickImage}
                  className="flex flex-col items-center gap-2 rounded-lg px-4 py-6 text-xs font-medium"
                  style={{ color: theme.accent }}
                >
                  <ImageIcon size={28} />
                  <span>点击上传或插入配图</span>
                </button>
              ) : (
                <span className="text-xs opacity-60">（暂无配图）</span>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* title-body & summary */
        <div className="flex flex-1 flex-col gap-3 min-h-0">
          {canEdit ? (
            <>
              <input
                type="text"
                value={slide.title}
                aria-label="幻灯片标题"
                placeholder="输入页面标题"
                onChange={(e) => onPatchSlide?.({ title: e.target.value })}
                className="ppt-slide-input text-xl sm:text-2xl font-bold px-1.5 py-0.5 shrink-0"
              />
              <input
                type="text"
                value={slide.subtitle || ""}
                aria-label="页面副标题"
                placeholder="副标题或摘要说明（可选）"
                onChange={(e) => onPatchSlide?.({ subtitle: e.target.value })}
                className="ppt-slide-input text-xs sm:text-sm px-1.5 py-0.5 shrink-0"
                style={{ color: theme.muted }}
              />
            </>
          ) : (
            <>
              <h2 className={presenting ? "text-3xl font-bold shrink-0" : "text-xl sm:text-2xl font-bold shrink-0"}>
                {slide.title}
              </h2>
              {slide.subtitle && (
                <p className={presenting ? "text-lg shrink-0" : "text-sm shrink-0"} style={{ color: theme.muted }}>
                  {slide.subtitle}
                </p>
              )}
            </>
          )}
          <div
            className="flex-1 min-h-0 flex flex-col rounded-lg"
            style={
              slide.layout === "summary"
                ? {
                    background: theme.surface,
                    border: `1px solid ${theme.accent}`,
                    padding: "14px 16px",
                  }
                : undefined
            }
          >
            {renderBulletList("bullets", "要点")}
          </div>
        </div>
      )}

      <div className="ppt-slide-footer">
        <span>{layoutLabel(slide.layout)}</span>
        <span>
          {slideIndex + 1} / {totalSlides}
        </span>
      </div>
    </div>
  );
}

const PptDocumentEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(function PptDocumentEditor(
  {
    note,
    onUpdate,
    onLocalUpdate,
    onHeadingsChange,
    onEditorReady,
    editable = true,
  },
  ref,
) {
  const [title, setTitle] = useState(note.title || "");
  const [deck, setDeck] = useState<PptDeckIR>(() => parsePptDeckJson(note.content, note.title));
  const [activeIndex, setActiveIndex] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const [highContrast, setHighContrast] = useState<boolean>(readHighContrastPref);
  const [presenting, setPresenting] = useState(false);
  const [presentShowNotes, setPresentShowNotes] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showOutlineModal, setShowOutlineModal] = useState(false);
  const [outlineDraft, setOutlineDraft] = useState("");
  const [liveStatus, setLiveStatus] = useState("");

  const titleRef = useRef(title);
  const deckRef = useRef(deck);
  const noteIdRef = useRef(note.id);
  const composingRef = useRef(false);
  const pendingTimerRef = useRef<number | null>(null);
  const pendingDirtyRef = useRef(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  titleRef.current = title;
  deckRef.current = deck;

  // 同步外部 note 切换或刷新
  useEffect(() => {
    const isSameNote = noteIdRef.current === note.id;
    noteIdRef.current = note.id;
    if (!isSameNote) {
      if (pendingTimerRef.current) {
        window.clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
      pendingDirtyRef.current = false;
      setTitle(note.title || "");
      const parsed = parsePptDeckJson(note.content, note.title);
      setDeck(parsed);
      setActiveIndex(0);
      setPresenting(false);
    } else if (
      !pendingDirtyRef.current &&
      shouldSyncTitleValue({
        inputValue: titleRef.current,
        noteTitle: note.title || "",
        isComposing: composingRef.current,
      })
    ) {
      setTitle(note.title || "");
    }
  }, [note.id, note.title, note.content]);

  const emitSave = useCallback(
    (nextDeck: PptDeckIR, nextTitle: string) => {
      const content = serializePptDeckJson(nextDeck);
      const contentText = extractPptPlainText(nextDeck);
      onUpdate({
        title: nextTitle,
        content,
        contentText,
        _noteId: noteIdRef.current,
      });
    },
    [onUpdate],
  );

  const scheduleSave = useCallback(
    (nextDeck: PptDeckIR, nextTitle: string) => {
      const content = serializePptDeckJson(nextDeck);
      const contentText = extractPptPlainText(nextDeck);
      onLocalUpdate?.({
        title: nextTitle,
        content,
        contentText,
        _noteId: noteIdRef.current,
      });
      pendingDirtyRef.current = true;
      if (pendingTimerRef.current) window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = window.setTimeout(() => {
        pendingTimerRef.current = null;
        pendingDirtyRef.current = false;
        emitSave(deckRef.current, titleRef.current);
      }, SAVE_DEBOUNCE_MS);
    },
    [emitSave, onLocalUpdate],
  );

  useEffect(() => {
    return () => {
      if (pendingTimerRef.current) {
        window.clearTimeout(pendingTimerRef.current);
      }
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      flushSave: () => {
        if (pendingTimerRef.current) {
          window.clearTimeout(pendingTimerRef.current);
          pendingTimerRef.current = null;
        }
        if (pendingDirtyRef.current) {
          pendingDirtyRef.current = false;
          emitSave(deckRef.current, titleRef.current);
        }
      },
      discardPending: () => {
        if (pendingTimerRef.current) {
          window.clearTimeout(pendingTimerRef.current);
          pendingTimerRef.current = null;
        }
        pendingDirtyRef.current = false;
      },
      getSnapshot: () => ({
        title: titleRef.current,
        content: serializePptDeckJson(deckRef.current),
        contentText: extractPptPlainText(deckRef.current),
      }),
    }),
    [emitSave],
  );

  // 将每页幻灯片同步到右侧“大纲”面板，支持点击跳转
  useEffect(() => {
    if (!onHeadingsChange) return;
    const headings: NoteEditorHeading[] = deck.slides.map((s, idx) => ({
      id: `ppt-slide-${s.id}`,
      level: s.layout === "cover" || s.layout === "section" ? 1 : 2,
      text: `${idx + 1}. ${s.title || layoutLabel(s.layout)}`,
      pos: idx,
    }));
    onHeadingsChange(headings);
  }, [deck.slides, onHeadingsChange]);

  useEffect(() => {
    onEditorReady?.((pos: number) => {
      if (Number.isInteger(pos) && pos >= 0) {
        setActiveIndex(Math.min(pos, Math.max(0, deckRef.current.slides.length - 1)));
      }
    });
  }, [onEditorReady]);

  const safeActiveIndex = Math.min(activeIndex, Math.max(0, deck.slides.length - 1));
  const currentSlide = deck.slides[safeActiveIndex] || deck.slides[0];

  const updateDeck = useCallback(
    (updater: (prev: PptDeckIR) => PptDeckIR, announce?: string) => {
      setDeck((prev) => {
        const next = updater(prev);
        deckRef.current = next;
        scheduleSave(next, titleRef.current);
        return next;
      });
      if (announce) setLiveStatus(announce);
    },
    [scheduleSave],
  );

  const patchCurrentSlide = useCallback(
    (patch: Partial<PptSlide>) => {
      updateDeck((prev) => ({
        ...prev,
        slides: prev.slides.map((s, idx) => (idx === safeActiveIndex ? { ...s, ...patch } : s)),
      }));
    },
    [safeActiveIndex, updateDeck],
  );

  const addNewSlide = useCallback(
    (layout: PptLayoutId = "title-body") => {
      const created = createSlide(layout);
      const insertAt = safeActiveIndex + 1;
      updateDeck(
        (prev) => {
          const nextSlides = [...prev.slides];
          nextSlides.splice(insertAt, 0, created);
          return { ...prev, slides: nextSlides };
        },
        `已新增第 ${insertAt + 1} 页幻灯片`,
      );
      setActiveIndex(insertAt);
    },
    [safeActiveIndex, updateDeck],
  );

  const duplicateCurrentSlide = useCallback(() => {
    if (!currentSlide) return;
    const copy = createSlide(currentSlide.layout, {
      ...currentSlide,
      id: undefined,
      title: currentSlide.title ? `${currentSlide.title}（副本）` : "副本页",
    });
    const insertAt = safeActiveIndex + 1;
    updateDeck(
      (prev) => {
        const nextSlides = [...prev.slides];
        nextSlides.splice(insertAt, 0, copy);
        return { ...prev, slides: nextSlides };
      },
      `已复制当前页到第 ${insertAt + 1} 页`,
    );
    setActiveIndex(insertAt);
  }, [currentSlide, safeActiveIndex, updateDeck]);

  const moveCurrentSlide = useCallback(
    (delta: -1 | 1) => {
      const target = safeActiveIndex + delta;
      if (target < 0 || target >= deck.slides.length) return;
      updateDeck(
        (prev) => {
          const nextSlides = [...prev.slides];
          const [moved] = nextSlides.splice(safeActiveIndex, 1);
          nextSlides.splice(target, 0, moved);
          return { ...prev, slides: nextSlides };
        },
        `已将幻灯片移动至第 ${target + 1} 页`,
      );
      setActiveIndex(target);
    },
    [deck.slides.length, safeActiveIndex, updateDeck],
  );

  const deleteCurrentSlide = useCallback(() => {
    if (deck.slides.length <= 1) {
      toast.info("至少保留一页幻灯片");
      return;
    }
    const nextIdx = Math.max(0, safeActiveIndex - 1);
    updateDeck(
      (prev) => ({
        ...prev,
        slides: prev.slides.filter((_, idx) => idx !== safeActiveIndex),
      }),
      `已删除第 ${safeActiveIndex + 1} 页幻灯片`,
    );
    setActiveIndex(nextIdx);
  }, [deck.slides.length, safeActiveIndex, updateDeck]);

  const toggleHighContrast = () => {
    setHighContrast((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(HIGH_CONTRAST_LS_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      if (next) {
        updateDeck((d) => ({ ...d, theme: "high-contrast" }), "已开启无障碍高对比模式");
      } else {
        setLiveStatus("已关闭无障碍高对比模式");
      }
      return next;
    });
  };

  // F5 快捷进入全屏放映；放映态下支持全键盘切页与退出
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (presenting) {
        if (e.key === "Escape") {
          e.preventDefault();
          setPresenting(false);
        } else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
          e.preventDefault();
          setActiveIndex((idx) => Math.min(deckRef.current.slides.length - 1, idx + 1));
        } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
          e.preventDefault();
          setActiveIndex((idx) => Math.max(0, idx - 1));
        } else if (e.key === "Home") {
          e.preventDefault();
          setActiveIndex(0);
        } else if (e.key === "End") {
          e.preventDefault();
          setActiveIndex(Math.max(0, deckRef.current.slides.length - 1));
        } else if (e.key.toLowerCase() === "n") {
          setPresentShowNotes((v) => !v);
        }
        return;
      }
      if (e.key === "F5") {
        e.preventDefault();
        setPresenting(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [presenting]);

  const handleImportPptx = async () => {
    if (!editable || busyAction) return;
    const file = await pickPptxFile();
    if (!file) return;
    setBusyAction("import");
    try {
      const parsed = await parsePptx(file);
      updateDeck(() => parsed, `已导入 ${parsed.slides.length} 页幻灯片`);
      setActiveIndex(0);
      toast.success(`已导入 ${parsed.slides.length} 页幻灯片`);
    } catch (err: any) {
      toast.error(err?.message || "导入 PPTX 失败");
    } finally {
      setBusyAction(null);
    }
  };

  const handleExportPptx = async () => {
    if (busyAction) return;
    setBusyAction("export");
    try {
      await exportPptDeckToFile(deckRef.current, titleRef.current || "演示文稿");
      toast.success("已导出 .pptx 文件");
    } catch (err: any) {
      toast.error(err?.message || "导出 PPTX 失败");
    } finally {
      setBusyAction(null);
    }
  };

  const handleImageFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !editable) return;
    setBusyAction("image");
    try {
      let imageUrl = "";
      if (note.id) {
        const uploaded = await api.attachments.upload(note.id, file);
        imageUrl = uploaded.url;
      } else {
        imageUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(new Error("读取图片失败"));
          reader.readAsDataURL(file);
        });
      }
      patchCurrentSlide({
        layout: "text-image",
        imageUrl,
        imageAlt: file.name.replace(/\.[^.]+$/, ""),
      });
      toast.success("已插入配图");
    } catch (err: any) {
      toast.error(err?.message || "插入图片失败");
    } finally {
      setBusyAction(null);
    }
  };

  const handleApplyOutline = () => {
    if (!outlineDraft.trim()) return;
    const generated = outlineTextToPptDeck(outlineDraft, {
      title: titleRef.current || "演示文稿",
      theme: deckRef.current.theme,
    });
    updateDeck(() => generated, `已从大纲生成 ${generated.slides.length} 页幻灯片`);
    setActiveIndex(0);
    setShowOutlineModal(false);
    setOutlineDraft("");
    toast.success(`已生成 ${generated.slides.length} 页幻灯片`);
  };

  const totalTextCount = useMemo(() => extractPptPlainText(deck).length, [deck]);

  return (
    <div className="ppt-editor-root" data-high-contrast={highContrast ? "true" : "false"}>
      {/* 无障碍状态播报 */}
      <div className="sr-only" role="status" aria-live="polite">
        {liveStatus}
      </div>

      {/* 隐藏图片上传选择器 */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void handleImageFileSelected(e)}
        aria-hidden="true"
      />

      {/* 紧凑双行工具栏 */}
      <div className="ppt-toolbar" role="toolbar" aria-label="PPT 演示文稿工具栏">
        <div className="ppt-toolbar-row">
          <div className="ppt-toolbar-group">
            <span className="ppt-badge">
              <Presentation size={14} />
              PPT
            </span>
            {editable && (
              <>
                <button
                  type="button"
                  className="ppt-btn"
                  disabled={Boolean(busyAction)}
                  onClick={() => void handleImportPptx()}
                  title="导入 .pptx 文件"
                >
                  {busyAction === "import" ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  导入
                </button>
                <button
                  type="button"
                  className="ppt-btn"
                  disabled={Boolean(busyAction)}
                  onClick={() => setShowOutlineModal((v) => !v)}
                  aria-expanded={showOutlineModal}
                  title="粘贴 Markdown 或大纲一键生成多页幻灯片"
                >
                  <Sparkles size={14} />
                  大纲生成
                </button>
              </>
            )}
            <button
              type="button"
              className="ppt-btn"
              disabled={Boolean(busyAction)}
              onClick={() => void handleExportPptx()}
              title="导出标准 .pptx 文件（PowerPoint / WPS 可直接编辑）"
            >
              {busyAction === "export" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              导出 PPTX
            </button>
            <button
              type="button"
              className="ppt-btn"
              onClick={() => window.print()}
              title="打印或另存为 PDF"
            >
              <Printer size={14} />
              打印/PDF
            </button>
            <button
              type="button"
              className="ppt-btn ppt-btn-primary"
              onClick={() => setPresenting(true)}
              title="全屏放映（快捷键 F5）"
            >
              <Play size={14} />
              放映
            </button>
          </div>

          <div className="ppt-toolbar-group">
            <select
              aria-label="选择演示文稿主题"
              className="ppt-select ppt-select-theme"
              value={deck.theme}
              disabled={!editable}
              onChange={(e) => {
                const nextTheme = e.target.value as PptThemeId;
                updateDeck((prev) => ({ ...prev, theme: nextTheme }), `已切换主题：${PPT_THEMES[nextTheme].label}`);
              }}
            >
              {Object.values(PPT_THEMES).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={`ppt-btn ${highContrast ? "ppt-btn-active" : ""}`}
              aria-pressed={highContrast}
              onClick={toggleHighContrast}
              title="切换无障碍大按钮与高对比模式"
            >
              <Contrast size={14} />
              无障碍
            </button>
          </div>
        </div>

        <div className="ppt-toolbar-row">
          <div className="ppt-toolbar-group">
            {editable && (
              <>
                <button
                  type="button"
                  className="ppt-btn"
                  onClick={() => addNewSlide("title-body")}
                >
                  <Plus size={14} />
                  新建页
                </button>
                <select
                  aria-label="选择当前页版式"
                  className="ppt-select ppt-select-layout"
                  value={currentSlide?.layout || "title-body"}
                  onChange={(e) => {
                    const nextLayout = e.target.value as PptLayoutId;
                    patchCurrentSlide({ layout: nextLayout });
                    setLiveStatus(`已切换版式：${layoutLabel(nextLayout)}`);
                  }}
                >
                  {PPT_LAYOUTS.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="ppt-btn"
                  disabled={safeActiveIndex === 0}
                  onClick={() => moveCurrentSlide(-1)}
                  aria-label="上移当前幻灯片"
                  title="上移一页"
                >
                  <ArrowUp size={14} />
                  上移
                </button>
                <button
                  type="button"
                  className="ppt-btn"
                  disabled={safeActiveIndex >= deck.slides.length - 1}
                  onClick={() => moveCurrentSlide(1)}
                  aria-label="下移当前幻灯片"
                  title="下移一页"
                >
                  <ArrowDown size={14} />
                  下移
                </button>
                <button
                  type="button"
                  className="ppt-btn"
                  onClick={duplicateCurrentSlide}
                  aria-label="复制当前幻灯片"
                  title="复制当前页"
                >
                  <Copy size={14} />
                  复制
                </button>
                <button
                  type="button"
                  className="ppt-btn"
                  disabled={deck.slides.length <= 1}
                  onClick={deleteCurrentSlide}
                  aria-label="删除当前幻灯片"
                  title="删除当前页"
                >
                  <Trash2 size={14} />
                  删除
                </button>
                <button
                  type="button"
                  className="ppt-btn"
                  disabled={Boolean(busyAction)}
                  onClick={() => imageInputRef.current?.click()}
                  title="为当前页插入配图（自动切换为左文右图版式）"
                >
                  <ImageIcon size={14} />
                  配图
                </button>
              </>
            )}
          </div>

          <div className="ppt-toolbar-group">
            <button
              type="button"
              className={`ppt-btn ${showNotes ? "ppt-btn-active" : ""}`}
              aria-expanded={showNotes}
              onClick={() => setShowNotes((v) => !v)}
            >
              <StickyNote size={14} />
              演讲者备注
            </button>
          </div>
        </div>
      </div>

      {/* 从 Markdown / 大纲一键生成幻灯片面板 */}
      {showOutlineModal && editable && (
        <div className="border-b border-app-border bg-app-surface px-4 py-3 space-y-2 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-tx-primary">
              <FileText size={14} className="text-accent-primary" />
              从 Markdown / 大纲一键生成幻灯片（`#` 封面/章节，`##` 新页，`- ` 要点，`&gt;` 引用）
            </div>
            <button
              type="button"
              className="ppt-btn"
              onClick={() => setShowOutlineModal(false)}
              aria-label="关闭大纲生成面板"
            >
              <X size={14} />
            </button>
          </div>
          <textarea
            value={outlineDraft}
            onChange={(e) => setOutlineDraft(e.target.value)}
            aria-label="粘贴 Markdown 或大纲文本"
            rows={5}
            placeholder={"# 项目季度复盘\n产品与研发团队 · 2026 Q4\n\n## 核心成果\n- 完成 Word 与 PPT 原生编辑闭环\n- 团队权限体系升级到 P2\n\n> 聚焦个人与小团队自托管，把体验做到极致"}
            className="w-full rounded-lg border border-app-border bg-app-bg p-2.5 text-xs text-tx-primary outline-none focus:border-accent-primary"
          />
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="ppt-btn" onClick={() => setShowOutlineModal(false)}>
              取消
            </button>
            <button
              type="button"
              className="ppt-btn ppt-btn-primary"
              disabled={!outlineDraft.trim()}
              onClick={handleApplyOutline}
            >
              生成并替换当前幻灯片
            </button>
          </div>
        </div>
      )}

      {/* 主编辑工作区 */}
      <div className="ppt-workspace">
        {/* 左侧幻灯片大纲列表 */}
        <aside className="ppt-sidebar" aria-label="幻灯片大纲导航">
          <div className="ppt-sidebar-header">
            <span>幻灯片（{deck.slides.length}）</span>
            {editable && (
              <button
                type="button"
                className="ppt-btn"
                onClick={() => addNewSlide("title-body")}
                aria-label="新增一页幻灯片"
              >
                <Plus size={14} />
              </button>
            )}
          </div>
          <div
            className="ppt-slide-list"
            role="listbox"
            aria-label="幻灯片列表"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((idx) => Math.min(deck.slides.length - 1, idx + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((idx) => Math.max(0, idx - 1));
              }
            }}
          >
            {deck.slides.map((slide, idx) => (
              <button
                key={slide.id}
                type="button"
                role="option"
                aria-selected={idx === safeActiveIndex}
                onClick={() => setActiveIndex(idx)}
                className="ppt-slide-thumb"
              >
                <div className="ppt-slide-thumb-meta">
                  <span>{String(idx + 1).padStart(2, "0")}</span>
                  <span>{layoutLabel(slide.layout)}</span>
                </div>
                <div className="ppt-slide-thumb-title">{slide.title || "未命名页面"}</div>
              </button>
            ))}
          </div>
        </aside>

        {/* 中央 16:9 画布区 */}
        <div className="ppt-stage-column">
          <div className="ppt-doc-title-bar">
            <input
              type="text"
              value={title}
              readOnly={!editable}
              aria-label="PPT 演示文稿名称"
              placeholder="请输入 PPT 演示文稿标题"
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={(e) => {
                composingRef.current = false;
                const nextTitle = e.currentTarget.value;
                setTitle(nextTitle);
                titleRef.current = nextTitle;
                if (nextTitle !== (note.title || "")) {
                  scheduleSave(deckRef.current, nextTitle);
                }
              }}
              onChange={(e) => {
                const nextTitle = e.target.value;
                setTitle(nextTitle);
                titleRef.current = nextTitle;
                if (
                  !shouldSkipTitleChange({
                    isComposing: composingRef.current,
                    eventIsComposing: (e.nativeEvent as InputEvent).isComposing,
                  })
                ) {
                  scheduleSave(deckRef.current, nextTitle);
                }
              }}
              className="ppt-doc-title-input"
            />
          </div>

          <div className="ppt-stage-scroll">
            {currentSlide && (
              <SlideCanvasView
                slide={currentSlide}
                slideIndex={safeActiveIndex}
                totalSlides={deck.slides.length}
                themeId={deck.theme}
                editable={editable}
                onPatchSlide={patchCurrentSlide}
                onPickImage={() => imageInputRef.current?.click()}
              />
            )}
          </div>

          {showNotes && currentSlide && (
            <div className="ppt-notes-bar">
              <label htmlFor="ppt-speaker-notes" className="block text-xs font-medium text-tx-secondary mb-1">
                第 {safeActiveIndex + 1} 页演讲者备注（导出 .pptx 时同步写入备注页，放映时按 N 键显示）
              </label>
              <textarea
                id="ppt-speaker-notes"
                value={currentSlide.notes || ""}
                readOnly={!editable}
                rows={2}
                placeholder="输入本页讲解提词或补充说明…"
                onChange={(e) => patchCurrentSlide({ notes: e.target.value })}
                className="w-full rounded-md border border-app-border bg-app-bg px-2.5 py-1.5 text-xs text-tx-primary outline-none focus:border-accent-primary resize-none"
              />
            </div>
          )}
        </div>
      </div>

      {/* 底部状态栏 */}
      <div className="ppt-statusbar">
        <span>
          16:9 宽屏 · 第 {safeActiveIndex + 1} / {deck.slides.length} 页 · 字数：{totalTextCount}
        </span>
        <span>快捷键：F5 全屏放映 · 方向键翻页</span>
      </div>

      {/* 全屏放映模式 */}
      {presenting &&
        currentSlide &&
        createPortal(
          <div
            className="ppt-present-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="PPT 全屏放映模式"
          >
            <div className="sr-only" role="status" aria-live="polite">
              第 {safeActiveIndex + 1} 页，共 {deck.slides.length} 页：{currentSlide.title}
            </div>

            <SlideCanvasView
              slide={currentSlide}
              slideIndex={safeActiveIndex}
              totalSlides={deck.slides.length}
              themeId={deck.theme}
              editable={false}
              presenting
            />

            {presentShowNotes && (
              <div className="mt-3 w-full max-w-3xl rounded-lg border border-slate-700 bg-slate-900/95 px-4 py-2.5 text-sm text-slate-200">
                <div className="text-xs font-semibold text-amber-300 mb-1">演讲者备注</div>
                <div>{currentSlide.notes?.trim() || "本页暂无备注"}</div>
              </div>
            )}

            <div className="ppt-present-hud" role="toolbar" aria-label="放映控制栏">
              <button
                type="button"
                disabled={safeActiveIndex === 0}
                onClick={() => setActiveIndex((idx) => Math.max(0, idx - 1))}
                aria-label="上一页"
              >
                <ArrowLeft size={15} />
                上一页
              </button>
              <span className="px-2 text-xs tabular-nums">
                {safeActiveIndex + 1} / {deck.slides.length}
              </span>
              <button
                type="button"
                disabled={safeActiveIndex >= deck.slides.length - 1}
                onClick={() => setActiveIndex((idx) => Math.min(deck.slides.length - 1, idx + 1))}
                aria-label="下一页"
              >
                下一页
                <ArrowRight size={15} />
              </button>
              <button
                type="button"
                aria-pressed={presentShowNotes}
                onClick={() => setPresentShowNotes((v) => !v)}
              >
                <StickyNote size={14} />
                备注
              </button>
              <button
                type="button"
                onClick={() => setPresenting(false)}
                aria-label="退出全屏放映"
              >
                <X size={15} />
                退出 (Esc)
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
});

export default PptDocumentEditor;
