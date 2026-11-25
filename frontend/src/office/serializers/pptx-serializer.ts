// office/serializers/pptx-serializer.ts —— PptDeckIR → 标准 OOXML .pptx 序列化器
//
// 复用项目已有 jszip，纯前端生成可在 PowerPoint / WPS / Keynote / LibreOffice 打开的 .pptx。

import JSZip from "jszip";
import { PPT_THEMES, type PptDeckIR, type PptSlide, type PptThemeSpec } from "../ir/presentation";

export interface CreatePptxOptions {
  /** 可选：将非 data: URL（如 /api/attachments/...）转为二进制图片以嵌入 .pptx */
  resolveImage?: (url: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;
}

const SLIDE_W = 12192000; // 13.333 in (16:9 widescreen)
const SLIDE_H = 6858000;  // 7.5 in

function escXml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function hexNoHash(color: string, fallback = "0F172A"): string {
  const cleaned = color.replace(/^#/, "").trim();
  return /^[0-9a-fA-F]{6}$/.test(cleaned) ? cleaned.toUpperCase() : fallback;
}

function parseDataUrl(url: string): { bytes: Uint8Array; ext: string; mime: string } | null {
  const match = url.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/i);
  if (!match) return null;
  const rawExt = match[1].toLowerCase();
  const ext = rawExt === "jpg" ? "jpeg" : rawExt;
  const mime = `image/${ext}`;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return { bytes, ext, mime };
}

function mimeToExt(mime: string): string {
  if (/png/i.test(mime)) return "png";
  if (/gif/i.test(mime)) return "gif";
  if (/webp/i.test(mime)) return "webp";
  return "jpeg";
}

function makeParagraphsXml(
  lines: string[],
  opts: {
    fontSizePt: number;
    colorHex: string;
    bold?: boolean;
    italic?: boolean;
    align?: "l" | "ctr" | "r";
    bullet?: boolean;
    spaceAfterPt?: number;
  },
): string {
  const sz = Math.round(opts.fontSizePt * 100);
  const safeLines = lines.length > 0 ? lines : [""];
  const spcAft = opts.spaceAfterPt ? `<a:spcAft><a:spcPts val="${Math.round(opts.spaceAfterPt * 100)}"/></a:spcAft>` : "";
  const buXml = opts.bullet
    ? `<a:buFont typeface="Arial"/><a:buChar char="•"/>`
    : `<a:buNone/>`;
  const marAttr = opts.bullet ? ` marL="285750" indent="-285750"` : "";
  const algnAttr = opts.align ? ` algn="${opts.align}"` : "";

  return safeLines
    .map((line) => {
      const bAttr = opts.bold ? ` b="1"` : "";
      const iAttr = opts.italic ? ` i="1"` : "";
      return (
        `<a:p>` +
        `<a:pPr${algnAttr}${marAttr}>${spcAft}${buXml}</a:pPr>` +
        `<a:r>` +
        `<a:rPr lang="zh-CN" sz="${sz}"${bAttr}${iAttr} dirty="0">` +
        `<a:solidFill><a:srgbClr val="${opts.colorHex}"/></a:solidFill>` +
        `<a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/>` +
        `</a:rPr>` +
        `<a:t>${escXml(line)}</a:t>` +
        `</a:r>` +
        `<a:endParaRPr lang="zh-CN" sz="${sz}"/>` +
        `</a:p>`
      );
    })
    .join("");
}

function makeTextBoxXml(opts: {
  id: number;
  name: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
  paragraphsXml: string;
  fillHex?: string;
  strokeHex?: string;
  placeholderType?: "title" | "ctrTitle" | "subTitle" | "body";
  anchor?: "t" | "ctr" | "b";
}): string {
  const phXml = opts.placeholderType ? `<p:ph type="${opts.placeholderType}"/>` : "";
  const fillXml = opts.fillHex
    ? `<a:solidFill><a:srgbClr val="${opts.fillHex}"/></a:solidFill>`
    : `<a:noFill/>`;
  const lnXml = opts.strokeHex
    ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${opts.strokeHex}"/></a:solidFill></a:ln>`
    : `<a:ln><a:noFill/></a:ln>`;
  const anchorAttr = opts.anchor ? ` anchor="${opts.anchor}"` : ` anchor="t"`;
  return (
    `<p:sp>` +
    `<p:nvSpPr>` +
    `<p:cNvPr id="${opts.id}" name="${escXml(opts.name)}"/>` +
    `<p:cNvSpPr txBox="1"/>` +
    `<p:nvPr>${phXml}</p:nvPr>` +
    `</p:nvSpPr>` +
    `<p:spPr>` +
    `<a:xfrm><a:off x="${opts.x}" y="${opts.y}"/><a:ext cx="${opts.cx}" cy="${opts.cy}"/></a:xfrm>` +
    `<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>` +
    `${fillXml}${lnXml}` +
    `</p:spPr>` +
    `<p:txBody>` +
    `<a:bodyPr wrap="square" lIns="140000" tIns="90000" rIns="140000" bIns="90000"${anchorAttr}/>` +
    `<a:lstStyle/>` +
    `${opts.paragraphsXml}` +
    `</p:txBody>` +
    `</p:sp>`
  );
}

function makeRectXml(id: number, name: string, x: number, y: number, cx: number, cy: number, fillHex: string): string {
  return (
    `<p:sp>` +
    `<p:nvSpPr><p:cNvPr id="${id}" name="${escXml(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>` +
    `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${fillHex}"/></a:solidFill>` +
    `<a:ln><a:noFill/></a:ln>` +
    `</p:spPr>` +
    `</p:sp>`
  );
}

function makePictureXml(opts: {
  id: number;
  name: string;
  descr: string;
  rId: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
}): string {
  return (
    `<p:pic>` +
    `<p:nvPicPr>` +
    `<p:cNvPr id="${opts.id}" name="${escXml(opts.name)}" descr="${escXml(opts.descr)}"/>` +
    `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>` +
    `<p:nvPr/>` +
    `</p:nvPicPr>` +
    `<p:blipFill>` +
    `<a:blip r:embed="${opts.rId}"/>` +
    `<a:stretch><a:fillRect/></a:stretch>` +
    `</p:blipFill>` +
    `<p:spPr>` +
    `<a:xfrm><a:off x="${opts.x}" y="${opts.y}"/><a:ext cx="${opts.cx}" cy="${opts.cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `</p:spPr>` +
    `</p:pic>`
  );
}

function buildSlideXml(
  slide: PptSlide,
  slideIndex: number,
  totalSlides: number,
  theme: PptThemeSpec,
  imageRelId: string | null,
): string {
  const bgHex = hexNoHash(theme.bg, "FFFFFF");
  const surfaceHex = hexNoHash(theme.surface, "F8FAFC");
  const textHex = hexNoHash(theme.text, "0F172A");
  const mutedHex = hexNoHash(theme.muted, "475569");
  const accentHex = hexNoHash(theme.accent, "2563EB");
  const borderHex = hexNoHash(theme.border, "E2E8F0");

  const shapes: string[] = [];
  let nextId = 2;

  // 顶部细强调条
  shapes.push(makeRectXml(nextId++, "AccentTopBar", 0, 0, SLIDE_W, 91440, accentHex));

  if (slide.layout === "cover") {
    shapes.push(
      makeTextBoxXml({
        id: nextId++,
        name: "CoverTitle",
        x: 914400,
        y: 1900000,
        cx: SLIDE_W - 1828800,
        cy: 1600000,
        placeholderType: "ctrTitle",
        anchor: "ctr",
        paragraphsXml: makeParagraphsXml([slide.title || "演示文稿标题"], {
          fontSizePt: 40,
          colorHex: textHex,
          bold: true,
          align: "ctr",
        }),
      }),
    );
    shapes.push(makeRectXml(nextId++, "CoverDivider", Math.round(SLIDE_W / 2 - 914400), 3650000, 1828800, 60000, accentHex));
    if (slide.subtitle?.trim()) {
      shapes.push(
        makeTextBoxXml({
          id: nextId++,
          name: "CoverSubtitle",
          x: 1371600,
          y: 3900000,
          cx: SLIDE_W - 2743200,
          cy: 900000,
          placeholderType: "subTitle",
          anchor: "t",
          paragraphsXml: makeParagraphsXml([slide.subtitle.trim()], {
            fontSizePt: 20,
            colorHex: mutedHex,
            align: "ctr",
          }),
        }),
      );
    }
  } else if (slide.layout === "section") {
    shapes.push(makeRectXml(nextId++, "SectionSideBar", 760000, 2100000, 110000, 2200000, accentHex));
    shapes.push(
      makeTextBoxXml({
        id: nextId++,
        name: "SectionTitle",
        x: 1120000,
        y: 2100000,
        cx: SLIDE_W - 1880000,
        cy: 1300000,
        placeholderType: "title",
        anchor: "ctr",
        paragraphsXml: makeParagraphsXml([slide.title || "章节标题"], {
          fontSizePt: 36,
          colorHex: textHex,
          bold: true,
        }),
      }),
    );
    if (slide.subtitle?.trim()) {
      shapes.push(
        makeTextBoxXml({
          id: nextId++,
          name: "SectionSubtitle",
          x: 1120000,
          y: 3500000,
          cx: SLIDE_W - 1880000,
          cy: 900000,
          placeholderType: "subTitle",
          paragraphsXml: makeParagraphsXml([slide.subtitle.trim()], {
            fontSizePt: 18,
            colorHex: mutedHex,
          }),
        }),
      );
    }
  } else if (slide.layout === "quote") {
    shapes.push(
      makeTextBoxXml({
        id: nextId++,
        name: "QuoteHeader",
        x: 760000,
        y: 450000,
        cx: SLIDE_W - 1520000,
        cy: 750000,
        placeholderType: "title",
        paragraphsXml: makeParagraphsXml([slide.title || "核心观点"], {
          fontSizePt: 26,
          colorHex: accentHex,
          bold: true,
        }),
      }),
    );
    shapes.push(
      makeTextBoxXml({
        id: nextId++,
        name: "QuoteBody",
        x: 1100000,
        y: 1650000,
        cx: SLIDE_W - 2200000,
        cy: 2900000,
        fillHex: surfaceHex,
        strokeHex: accentHex,
        placeholderType: "body",
        anchor: "ctr",
        paragraphsXml: makeParagraphsXml(
          (slide.quote || "").split("\n").filter(Boolean),
          {
            fontSizePt: 26,
            colorHex: textHex,
            italic: true,
            align: "ctr",
            spaceAfterPt: 10,
          },
        ),
      }),
    );
    if (slide.quoteAuthor?.trim()) {
      shapes.push(
        makeTextBoxXml({
          id: nextId++,
          name: "QuoteAuthor",
          x: 1100000,
          y: 4750000,
          cx: SLIDE_W - 2200000,
          cy: 600000,
          paragraphsXml: makeParagraphsXml([slide.quoteAuthor.trim()], {
            fontSizePt: 16,
            colorHex: mutedHex,
            align: "r",
          }),
        }),
      );
    }
  } else if (slide.layout === "two-column") {
    shapes.push(
      makeTextBoxXml({
        id: nextId++,
        name: "SlideTitle",
        x: 760000,
        y: 420000,
        cx: SLIDE_W - 1520000,
        cy: 850000,
        placeholderType: "title",
        paragraphsXml: makeParagraphsXml([slide.title || "页面标题"], {
          fontSizePt: 28,
          colorHex: textHex,
          bold: true,
        }),
      }),
    );
    const colW = Math.round((SLIDE_W - 1520000 - 380000) / 2);
    const leftLines = (slide.bullets || []).filter((b) => b.trim());
    const rightLines = (slide.rightBullets || []).filter((b) => b.trim());
    shapes.push(
      makeTextBoxXml({
        id: nextId++,
        name: "LeftColumn",
        x: 760000,
        y: 1500000,
        cx: colW,
        cy: 4550000,
        fillHex: surfaceHex,
        strokeHex: borderHex,
        placeholderType: "body",
        paragraphsXml: makeParagraphsXml(leftLines.length ? leftLines : [" "], {
          fontSizePt: 18,
          colorHex: textHex,
          bullet: true,
          spaceAfterPt: 12,
        }),
      }),
    );
    const rightPara = [
      ...(slide.rightTitle?.trim()
        ? [
            makeParagraphsXml([slide.rightTitle.trim()], {
              fontSizePt: 20,
              colorHex: accentHex,
              bold: true,
              spaceAfterPt: 12,
            }),
          ]
        : []),
      makeParagraphsXml(rightLines.length ? rightLines : [" "], {
        fontSizePt: 18,
        colorHex: textHex,
        bullet: true,
        spaceAfterPt: 12,
      }),
    ].join("");
    shapes.push(
      makeTextBoxXml({
        id: nextId++,
        name: "RightColumn",
        x: 760000 + colW + 380000,
        y: 1500000,
        cx: colW,
        cy: 4550000,
        fillHex: surfaceHex,
        strokeHex: borderHex,
        paragraphsXml: rightPara,
      }),
    );
  } else if (slide.layout === "text-image") {
    shapes.push(
      makeTextBoxXml({
        id: nextId++,
        name: "SlideTitle",
        x: 760000,
        y: 420000,
        cx: SLIDE_W - 1520000,
        cy: 850000,
        placeholderType: "title",
        paragraphsXml: makeParagraphsXml([slide.title || "图文展示"], {
          fontSizePt: 28,
          colorHex: textHex,
          bold: true,
        }),
      }),
    );
    const leftW = Math.round((SLIDE_W - 1520000 - 380000) * 0.52);
    const rightW = SLIDE_W - 1520000 - 380000 - leftW;
    const bullets = (slide.bullets || []).filter((b) => b.trim());
    shapes.push(
      makeTextBoxXml({
        id: nextId++,
        name: "SlideBody",
        x: 760000,
        y: 1500000,
        cx: leftW,
        cy: 4550000,
        placeholderType: "body",
        paragraphsXml: makeParagraphsXml(bullets.length ? bullets : [" "], {
          fontSizePt: 18,
          colorHex: textHex,
          bullet: true,
          spaceAfterPt: 14,
        }),
      }),
    );
    if (imageRelId) {
      shapes.push(
        makePictureXml({
          id: nextId++,
          name: "SlideImage",
          descr: slide.imageAlt || slide.title || "幻灯片配图",
          rId: imageRelId,
          x: 760000 + leftW + 380000,
          y: 1500000,
          cx: rightW,
          cy: 4550000,
        }),
      );
    }
  } else {
    // title-body & summary
    shapes.push(
      makeTextBoxXml({
        id: nextId++,
        name: "SlideTitle",
        x: 760000,
        y: 420000,
        cx: SLIDE_W - 1520000,
        cy: 850000,
        placeholderType: "title",
        paragraphsXml: makeParagraphsXml([slide.title || "页面标题"], {
          fontSizePt: 28,
          colorHex: textHex,
          bold: true,
        }),
      }),
    );
    if (slide.subtitle?.trim()) {
      shapes.push(
        makeTextBoxXml({
          id: nextId++,
          name: "SlideSubtitle",
          x: 760000,
          y: 1220000,
          cx: SLIDE_W - 1520000,
          cy: 420000,
          placeholderType: "subTitle",
          paragraphsXml: makeParagraphsXml([slide.subtitle.trim()], {
            fontSizePt: 15,
            colorHex: mutedHex,
          }),
        }),
      );
    }
    const bullets = (slide.bullets || []).filter((b) => b.trim());
    shapes.push(
      makeTextBoxXml({
        id: nextId++,
        name: "SlideBody",
        x: 760000,
        y: slide.subtitle?.trim() ? 1720000 : 1480000,
        cx: SLIDE_W - 1520000,
        cy: 4350000,
        fillHex: slide.layout === "summary" ? surfaceHex : undefined,
        strokeHex: slide.layout === "summary" ? accentHex : undefined,
        placeholderType: "body",
        paragraphsXml: makeParagraphsXml(bullets.length ? bullets : [" "], {
          fontSizePt: 20,
          colorHex: textHex,
          bullet: true,
          spaceAfterPt: 14,
        }),
      }),
    );
  }

  // 右下角页码
  shapes.push(
    makeTextBoxXml({
      id: nextId++,
      name: "SlideNumberFooter",
      x: SLIDE_W - 1600000,
      y: SLIDE_H - 460000,
      cx: 1000000,
      cy: 340000,
      paragraphsXml: makeParagraphsXml([`${slideIndex} / ${totalSlides}`], {
        fontSizePt: 11,
        colorHex: mutedHex,
        align: "r",
      }),
    }),
  );

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld>` +
    `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bgHex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    `<p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    shapes.join("") +
    `</p:spTree>` +
    `</p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `</p:sld>`
  );
}

function buildNotesSlideXml(notes: string): string {
  const lines = notes.replace(/\r\n?/g, "\n").split("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    makeTextBoxXml({
      id: 2,
      name: "NotesPlaceholder",
      x: 685800,
      y: 4343400,
      cx: 5486400,
      cy: 4114800,
      placeholderType: "body",
      paragraphsXml: makeParagraphsXml(lines, {
        fontSizePt: 12,
        colorHex: "111827",
      }),
    }) +
    `</p:spTree></p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `</p:notes>`
  );
}

export async function createPptx(
  deck: PptDeckIR,
  options: CreatePptxOptions = {},
): Promise<Uint8Array> {
  const zip = new JSZip();
  const theme = PPT_THEMES[deck.theme] || PPT_THEMES["classic-light"];
  const slides = deck.slides.length > 0 ? deck.slides : [];

  const contentTypeOverrides: string[] = [
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
  ];
  const imageExts = new Set<string>();
  const presRels: string[] = [
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`,
  ];
  const sldIds: string[] = [];

  for (let i = 0; i < slides.length; i += 1) {
    const num = i + 1;
    const slide = slides[i];
    const rId = `rId${num + 2}`;
    presRels.push(
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${num}.xml"/>`,
    );
    sldIds.push(`<p:sldId id="${256 + i}" r:id="${rId}"/>`);
    contentTypeOverrides.push(
      `<Override PartName="/ppt/slides/slide${num}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    );

    const slideRels: string[] = [
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
    ];
    let nextSlideRelNum = 2;

    // 尝试嵌入图片
    let imageRelId: string | null = null;
    if (slide.imageUrl?.trim()) {
      let resolved: { bytes: Uint8Array; ext: string } | null = null;
      const fromData = parseDataUrl(slide.imageUrl.trim());
      if (fromData) {
        resolved = { bytes: fromData.bytes, ext: fromData.ext };
      } else if (options.resolveImage) {
        const fetched = await options.resolveImage(slide.imageUrl.trim()).catch(() => null);
        if (fetched && fetched.bytes.length > 0) {
          resolved = { bytes: fetched.bytes, ext: mimeToExt(fetched.mime) };
        }
      }
      if (resolved) {
        const mediaName = `image${num}.${resolved.ext}`;
        zip.file(`ppt/media/${mediaName}`, resolved.bytes);
        imageExts.add(resolved.ext);
        imageRelId = `rId${nextSlideRelNum++}`;
        slideRels.push(
          `<Relationship Id="${imageRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/>`,
        );
      }
    }

    // 演讲者备注
    if (slide.notes?.trim()) {
      const notesRelId = `rId${nextSlideRelNum++}`;
      slideRels.push(
        `<Relationship Id="${notesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${num}.xml"/>`,
      );
      contentTypeOverrides.push(
        `<Override PartName="/ppt/notesSlides/notesSlide${num}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
      );
      zip.file(`ppt/notesSlides/notesSlide${num}.xml`, buildNotesSlideXml(slide.notes));
      zip.file(
        `ppt/notesSlides/_rels/notesSlide${num}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${num}.xml"/>` +
          `</Relationships>`,
      );
    }

    zip.file(
      `ppt/slides/slide${num}.xml`,
      buildSlideXml(slide, num, slides.length, theme, imageRelId),
    );
    zip.file(
      `ppt/slides/_rels/slide${num}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        slideRels.join("") +
        `</Relationships>`,
    );
  }

  const imageDefaults = Array.from(imageExts)
    .map((ext) => `<Default Extension="${ext}" ContentType="image/${ext}"/>`)
    .join("");

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      imageDefaults +
      contentTypeOverrides.join("") +
      `</Types>`,
  );

  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
      `</Relationships>`,
  );

  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
      `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${sldIds.join("")}</p:sldIdLst>` +
      `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}" type="screen16x9"/>` +
      `<p:notesSz cx="6858000" cy="9144000"/>` +
      `</p:presentation>`,
  );

  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      presRels.join("") +
      `</Relationships>`,
  );

  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
      `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:cSld><p:spTree>` +
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      `</p:spTree></p:cSld>` +
      `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
      `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
      `</p:sldMaster>`,
  );

  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
      `</Relationships>`,
  );

  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
      `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">` +
      `<p:cSld name="Blank"><p:spTree>` +
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
      `</p:spTree></p:cSld>` +
      `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
      `</p:sldLayout>`,
  );

  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
      `</Relationships>`,
  );

  const bgHex = hexNoHash(theme.bg, "FFFFFF");
  const textHex = hexNoHash(theme.text, "0F172A");
  const surfaceHex = hexNoHash(theme.surface, "F8FAFC");
  const accentHex = hexNoHash(theme.accent, "2563EB");

  zip.file(
    "ppt/theme/theme1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="NowenTheme">` +
      `<a:themeElements>` +
      `<a:clrScheme name="Nowen">` +
      `<a:dk1><a:srgbClr val="${textHex}"/></a:dk1>` +
      `<a:lt1><a:srgbClr val="${bgHex}"/></a:lt1>` +
      `<a:dk2><a:srgbClr val="${textHex}"/></a:dk2>` +
      `<a:lt2><a:srgbClr val="${surfaceHex}"/></a:lt2>` +
      `<a:accent1><a:srgbClr val="${accentHex}"/></a:accent1>` +
      `<a:accent2><a:srgbClr val="10B981"/></a:accent2>` +
      `<a:accent3><a:srgbClr val="F59E0B"/></a:accent3>` +
      `<a:accent4><a:srgbClr val="8B5CF6"/></a:accent4>` +
      `<a:accent5><a:srgbClr val="EC4899"/></a:accent5>` +
      `<a:accent6><a:srgbClr val="06B6D4"/></a:accent6>` +
      `<a:hlink><a:srgbClr val="${accentHex}"/></a:hlink>` +
      `<a:folHlink><a:srgbClr val="6366F1"/></a:folHlink>` +
      `</a:clrScheme>` +
      `<a:fontScheme name="Nowen">` +
      `<a:majorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:majorFont>` +
      `<a:minorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:minorFont>` +
      `</a:fontScheme>` +
      `<a:fmtScheme name="Nowen">` +
      `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
      `<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="28575"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
      `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
      `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
      `</a:fmtScheme>` +
      `</a:themeElements>` +
      `</a:theme>`,
  );

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
