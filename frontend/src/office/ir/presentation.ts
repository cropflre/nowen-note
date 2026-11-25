// office/ir/presentation.ts —— 自研 PPT 演示文稿内部数据模型（纯 TS，无 DOM/React 依赖）

export type PptLayoutId =
  | "cover"
  | "section"
  | "title-body"
  | "two-column"
  | "text-image"
  | "quote"
  | "summary";

export type PptThemeId =
  | "classic-light"
  | "deep-space"
  | "forest-calm"
  | "warm-paper"
  | "high-contrast";

export interface PptThemeSpec {
  id: PptThemeId;
  label: string;
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
  border: string;
}

export const PPT_THEMES: Record<PptThemeId, PptThemeSpec> = {
  "classic-light": {
    id: "classic-light",
    label: "极简亮白",
    bg: "#FFFFFF",
    surface: "#F8FAFC",
    text: "#0F172A",
    muted: "#475569",
    accent: "#2563EB",
    accentSoft: "#EFF6FF",
    border: "#E2E8F0",
  },
  "deep-space": {
    id: "deep-space",
    label: "深空暗夜",
    bg: "#0F172A",
    surface: "#1E293B",
    text: "#F8FAFC",
    muted: "#94A3B8",
    accent: "#38BDF8",
    accentSoft: "#0C4A6E",
    border: "#334155",
  },
  "forest-calm": {
    id: "forest-calm",
    label: "森系青绿",
    bg: "#F6FBF8",
    surface: "#EBF5F0",
    text: "#102A22",
    muted: "#3D6154",
    accent: "#059669",
    accentSoft: "#D1FAE5",
    border: "#C6E3D5",
  },
  "warm-paper": {
    id: "warm-paper",
    label: "暖纸米白",
    bg: "#FDFBF7",
    surface: "#F5EFE6",
    text: "#2C2218",
    muted: "#6B5A49",
    accent: "#D97706",
    accentSoft: "#FEF3C7",
    border: "#E6DAC8",
  },
  "high-contrast": {
    id: "high-contrast",
    label: "无障碍高对比",
    bg: "#000000",
    surface: "#111111",
    text: "#FFFFFF",
    muted: "#FDE047",
    accent: "#FACC15",
    accentSoft: "#27270A",
    border: "#FACC15",
  },
};

export interface PptLayoutMeta {
  id: PptLayoutId;
  label: string;
  description: string;
}

export const PPT_LAYOUTS: PptLayoutMeta[] = [
  { id: "cover", label: "封面页", description: "居中主标题、副标题与主题强调条" },
  { id: "section", label: "章节过渡页", description: "大字号章节标题与引导说明" },
  { id: "title-body", label: "标题与要点", description: "顶部标题搭配结构化条目列表" },
  { id: "two-column", label: "左右双栏", description: "对比展示两组要点内容" },
  { id: "text-image", label: "左文右图", description: "左侧要点说明，右侧配图与替代文本" },
  { id: "quote", label: "引用金句", description: "突出核心观点与出处署名" },
  { id: "summary", label: "总结与行动", description: "提炼关键结论与下一步行动" },
];

export interface PptSlide {
  id: string;
  layout: PptLayoutId;
  title: string;
  subtitle?: string;
  bullets: string[];
  rightTitle?: string;
  rightBullets?: string[];
  quote?: string;
  quoteAuthor?: string;
  imageUrl?: string;
  imageAlt?: string;
  notes?: string;
}

export interface PptDeckIR {
  version: 1;
  aspectRatio: "16:9";
  theme: PptThemeId;
  slides: PptSlide[];
}

const VALID_LAYOUTS = new Set<PptLayoutId>(PPT_LAYOUTS.map((l) => l.id));
const VALID_THEMES = new Set<PptThemeId>(Object.keys(PPT_THEMES) as PptThemeId[]);

let slideSeq = 0;

export function createSlideId(): string {
  slideSeq += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `slide-${Date.now().toString(36)}-${slideSeq}`;
}

export function createSlide(
  layout: PptLayoutId = "title-body",
  partial: Partial<PptSlide> = {},
): PptSlide {
  const safeLayout: PptLayoutId = VALID_LAYOUTS.has(layout) ? layout : "title-body";
  const base: PptSlide = {
    id: partial.id || createSlideId(),
    layout: safeLayout,
    title: partial.title ?? (
      safeLayout === "cover"
        ? "演示文稿标题"
        : safeLayout === "section"
          ? "第一部分"
          : safeLayout === "quote"
            ? "核心观点"
            : safeLayout === "summary"
              ? "总结与下一步"
              : "页面标题"
    ),
    subtitle: partial.subtitle ?? (safeLayout === "cover" ? "副标题 · 汇报人 / 日期" : ""),
    bullets: Array.isArray(partial.bullets)
      ? partial.bullets.map((b) => String(b))
      : safeLayout === "cover" || safeLayout === "section" || safeLayout === "quote"
        ? []
        : ["要点一：简明阐述核心信息", "要点二：补充支撑数据或案例"],
    rightTitle: partial.rightTitle ?? (safeLayout === "two-column" ? "右侧栏标题" : ""),
    rightBullets: Array.isArray(partial.rightBullets)
      ? partial.rightBullets.map((b) => String(b))
      : safeLayout === "two-column"
        ? ["对比要点一", "对比要点二"]
        : [],
    quote: partial.quote ?? (safeLayout === "quote" ? "在这里输入希望强调的核心观点或引言。" : ""),
    quoteAuthor: partial.quoteAuthor ?? (safeLayout === "quote" ? "—— 出处 / 作者" : ""),
    imageUrl: typeof partial.imageUrl === "string" ? partial.imageUrl : "",
    imageAlt: typeof partial.imageAlt === "string" ? partial.imageAlt : "",
    notes: typeof partial.notes === "string" ? partial.notes : "",
  };
  return base;
}

export function createDefaultPptDeck(title?: string): PptDeckIR {
  const safeTitle = (title || "").trim() || "无标题 PPT 演示文稿";
  return {
    version: 1,
    aspectRatio: "16:9",
    theme: "classic-light",
    slides: [
      createSlide("cover", {
        title: safeTitle,
        subtitle: "按 Tab 键切换编辑区域，按 F5 进入全屏放映",
      }),
      createSlide("title-body", {
        title: "核心要点",
        bullets: [
          "支持全键盘操作与无障碍高对比主题",
          "支持 7 种常用版式一键切换，自动对齐不跑版",
          "支持导入 / 导出标准 .pptx 文件，可在 PowerPoint / WPS 中打开",
        ],
      }),
    ],
  };
}

export function normalizePptDeck(input: unknown, fallbackTitle?: string): PptDeckIR {
  if (!input || typeof input !== "object") {
    return createDefaultPptDeck(fallbackTitle);
  }
  const obj = input as Record<string, unknown>;
  const theme: PptThemeId =
    typeof obj.theme === "string" && VALID_THEMES.has(obj.theme as PptThemeId)
      ? (obj.theme as PptThemeId)
      : "classic-light";
  const rawSlides = Array.isArray(obj.slides) ? obj.slides : [];
  const slides: PptSlide[] = rawSlides
    .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === "object"))
    .map((s) => {
      const layout: PptLayoutId =
        typeof s.layout === "string" && VALID_LAYOUTS.has(s.layout as PptLayoutId)
          ? (s.layout as PptLayoutId)
          : "title-body";
      return {
        id: typeof s.id === "string" && s.id.trim() ? s.id : createSlideId(),
        layout,
        title: typeof s.title === "string" ? s.title : "",
        subtitle: typeof s.subtitle === "string" ? s.subtitle : "",
        bullets: Array.isArray(s.bullets) ? s.bullets.map((b) => String(b ?? "")) : [],
        rightTitle: typeof s.rightTitle === "string" ? s.rightTitle : "",
        rightBullets: Array.isArray(s.rightBullets) ? s.rightBullets.map((b) => String(b ?? "")) : [],
        quote: typeof s.quote === "string" ? s.quote : "",
        quoteAuthor: typeof s.quoteAuthor === "string" ? s.quoteAuthor : "",
        imageUrl: typeof s.imageUrl === "string" ? s.imageUrl : "",
        imageAlt: typeof s.imageAlt === "string" ? s.imageAlt : "",
        notes: typeof s.notes === "string" ? s.notes : "",
      };
    });

  if (slides.length === 0) {
    return {
      ...createDefaultPptDeck(fallbackTitle),
      theme,
    };
  }
  return {
    version: 1,
    aspectRatio: "16:9",
    theme,
    slides,
  };
}

export function parsePptDeckJson(raw: string | null | undefined, fallbackTitle?: string): PptDeckIR {
  if (!raw || !raw.trim() || raw.trim() === "{}") {
    return createDefaultPptDeck(fallbackTitle);
  }
  try {
    return normalizePptDeck(JSON.parse(raw), fallbackTitle);
  } catch {
    return createDefaultPptDeck(fallbackTitle);
  }
}

export function serializePptDeckJson(deck: PptDeckIR): string {
  return JSON.stringify(deck);
}

export function extractPptPlainText(deck: PptDeckIR): string {
  const chunks: string[] = [];
  for (const slide of deck.slides) {
    if (slide.title?.trim()) chunks.push(slide.title.trim());
    if (slide.subtitle?.trim()) chunks.push(slide.subtitle.trim());
    for (const b of slide.bullets || []) {
      if (b.trim()) chunks.push(b.trim());
    }
    if (slide.rightTitle?.trim()) chunks.push(slide.rightTitle.trim());
    for (const b of slide.rightBullets || []) {
      if (b.trim()) chunks.push(b.trim());
    }
    if (slide.quote?.trim()) chunks.push(slide.quote.trim());
    if (slide.quoteAuthor?.trim()) chunks.push(slide.quoteAuthor.trim());
    if (slide.notes?.trim()) chunks.push(slide.notes.trim());
  }
  return chunks.join("\n").trim();
}

/**
 * 将 Markdown / 大纲纯文本一键拆分为结构化幻灯片：
 * - `# 标题`：首项作为封面页，后续作为章节页
 * - `## 标题` 或 `---`：开启新的要点页
 * - `- ` / `* ` / `1. ` / 普通行：归入当前页要点
 * - `> `：归入引用金句（若当前页无其他要点则自动切换为 quote 版式）
 */
export function outlineTextToPptDeck(
  rawText: string,
  options: { title?: string; theme?: PptThemeId } = {},
): PptDeckIR {
  const theme = options.theme && VALID_THEMES.has(options.theme) ? options.theme : "classic-light";
  const lines = rawText.replace(/\r\n?/g, "\n").split("\n");
  const slides: PptSlide[] = [];
  let current: PptSlide | null = null;

  const ensureSlide = (layout: PptLayoutId, title: string) => {
    current = createSlide(layout, { title, subtitle: "", bullets: [], quote: "", quoteAuthor: "" });
    slides.push(current);
    return current;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^---+$/.test(line)) {
      current = null;
      continue;
    }

    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      ensureSlide(slides.length === 0 ? "cover" : "section", h1[1].trim());
      continue;
    }

    const h2 = line.match(/^#{2,3}\s+(.+)$/);
    if (h2) {
      ensureSlide("title-body", h2[1].trim());
      continue;
    }

    const quoteMatch = line.match(/^>\s*(.+)$/);
    if (quoteMatch) {
      if (!current) {
        ensureSlide("quote", "核心观点");
      }
      if (current!.layout === "title-body" && current!.bullets.length === 0 && !current!.quote) {
        current!.layout = "quote";
      }
      current!.quote = current!.quote ? `${current!.quote}\n${quoteMatch[1].trim()}` : quoteMatch[1].trim();
      continue;
    }

    const bulletText = line.replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim();
    if (!bulletText) continue;

    if (!current) {
      ensureSlide("title-body", options.title?.trim() || "核心内容");
    }
    if (current!.layout === "cover" || current!.layout === "section") {
      current!.subtitle = current!.subtitle ? `${current!.subtitle} · ${bulletText}` : bulletText;
    } else {
      current!.bullets.push(bulletText);
    }
  }

  if (slides.length === 0) {
    return {
      ...createDefaultPptDeck(options.title),
      theme,
    };
  }

  return {
    version: 1,
    aspectRatio: "16:9",
    theme,
    slides,
  };
}
