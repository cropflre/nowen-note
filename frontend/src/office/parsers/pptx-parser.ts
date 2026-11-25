// office/parsers/pptx-parser.ts —— 标准 OOXML .pptx → PptDeckIR 解析器
//
// 复用项目已有 OpcPackage（jszip + 浏览器原生 DOMParser），无重型第三方依赖。

import { OpcPackage } from "../opc/reader";
import {
  createDefaultPptDeck,
  createSlide,
  type PptDeckIR,
  type PptLayoutId,
  type PptSlide,
} from "../ir/presentation";

function resolveRelativePath(basePartPath: string, target: string): string {
  const cleanTarget = target.replace(/^\/+/, "");
  if (target.startsWith("/")) return cleanTarget;
  const baseParts = basePartPath.split("/");
  baseParts.pop(); // remove filename
  for (const seg of cleanTarget.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") baseParts.pop();
    else baseParts.push(seg);
  }
  return baseParts.join("/");
}

function getElementsByLocalName(root: Document | Element, localName: string): Element[] {
  const result: Element[] = [];
  const all = root.getElementsByTagName("*");
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i];
    if (el.localName === localName) result.push(el);
  }
  return result;
}

function extractParagraphsFromShape(sp: Element): string[] {
  const lines: string[] = [];
  const paragraphs = getElementsByLocalName(sp, "p");
  for (const p of paragraphs) {
    const runs = getElementsByLocalName(p, "t");
    const text = runs.map((t) => t.textContent || "").join("").trim();
    if (text) lines.push(text);
  }
  return lines;
}

function getPlaceholderType(sp: Element): string {
  const ph = getElementsByLocalName(sp, "ph")[0];
  return (ph?.getAttribute("type") || "").toLowerCase();
}

function getShapeName(sp: Element): string {
  const cNvPr = getElementsByLocalName(sp, "cNvPr")[0];
  return cNvPr?.getAttribute("name") || "";
}

function getShapeX(sp: Element): number {
  const off = getElementsByLocalName(sp, "off")[0];
  return Number.parseInt(off?.getAttribute("x") || "0", 10) || 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function guessImageMime(path: string): string {
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.gif$/i.test(path)) return "image/gif";
  if (/\.webp$/i.test(path)) return "image/webp";
  return "image/jpeg";
}

export async function parsePptx(
  input: File | Blob | ArrayBuffer | Uint8Array,
): Promise<PptDeckIR> {
  const pkg = await OpcPackage.load(input);
  const presDoc = await pkg.getXml("ppt/presentation.xml");
  const presRels = await pkg.getRels("ppt/presentation.xml");

  const slidePaths: string[] = [];
  if (presDoc) {
    const sldIds = getElementsByLocalName(presDoc, "sldId");
    for (const sldId of sldIds) {
      const rId =
        sldId.getAttribute("r:id") ||
        sldId.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ||
        "";
      const rel = presRels.get(rId);
      if (rel?.target) {
        slidePaths.push(resolveRelativePath("ppt/presentation.xml", rel.target));
      }
    }
  }

  // 兜底：若 presentation.xml 缺失或关系异常，按文件名顺序扫描 ppt/slides/slide*.xml
  if (slidePaths.length === 0) {
    const fallback = pkg.entries
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
      .sort((a, b) => {
        const na = Number.parseInt(a.match(/slide(\d+)\.xml/i)?.[1] || "0", 10);
        const nb = Number.parseInt(b.match(/slide(\d+)\.xml/i)?.[1] || "0", 10);
        return na - nb;
      });
    slidePaths.push(...fallback);
  }

  const slides: PptSlide[] = [];

  for (let i = 0; i < slidePaths.length; i += 1) {
    const slidePath = slidePaths[i];
    const slideDoc = await pkg.getXml(slidePath);
    if (!slideDoc) continue;
    const slideRels = await pkg.getRels(slidePath);

    let title = "";
    let subtitle = "";
    let quote = "";
    let quoteAuthor = "";
    let rightTitle = "";
    const leftBullets: string[] = [];
    const rightBullets: string[] = [];
    let hasRightColumn = false;

    const shapes = getElementsByLocalName(slideDoc, "sp");
    for (const sp of shapes) {
      const name = getShapeName(sp);
      const phType = getPlaceholderType(sp);
      if (phType === "sldnum" || name === "SlideNumberFooter") continue;

      const lines = extractParagraphsFromShape(sp);
      if (lines.length === 0) continue;

      if (name === "QuoteBody") {
        quote = lines.join("\n");
        continue;
      }
      if (name === "QuoteAuthor") {
        quoteAuthor = lines.join(" ");
        continue;
      }
      if (name === "RightColumn") {
        hasRightColumn = true;
        if (lines.length > 1) {
          rightTitle = lines[0];
          rightBullets.push(...lines.slice(1));
        } else {
          rightBullets.push(...lines);
        }
        continue;
      }

      if ((phType === "title" || phType === "ctrtitle" || name.includes("Title")) && !title) {
        title = lines.join(" ");
      } else if (phType === "subtitle" || name.includes("Subtitle")) {
        subtitle = lines.join(" ");
      } else if (!title && i === 0 && leftBullets.length === 0 && lines.length === 1) {
        title = lines[0];
      } else {
        // 识别外部 PPT 的左右双栏布局（右侧区域 x > 5,500,000 EMU）
        const x = getShapeX(sp);
        if (x > 5500000 && leftBullets.length > 0) {
          hasRightColumn = true;
          rightBullets.push(...lines);
        } else {
          leftBullets.push(...lines);
        }
      }
    }

    // 解析配图（取第一张有效图片）
    let imageUrl = "";
    let imageAlt = "";
    const pics = getElementsByLocalName(slideDoc, "pic");
    for (const pic of pics) {
      const blip = getElementsByLocalName(pic, "blip")[0];
      const embedId =
        blip?.getAttribute("r:embed") ||
        blip?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") ||
        "";
      if (!embedId) continue;
      const rel = slideRels.get(embedId);
      if (!rel?.target || rel.external) continue;
      const mediaPath = resolveRelativePath(slidePath, rel.target);
      const bytes = await pkg.getBinary(mediaPath);
      if (bytes && bytes.length > 0) {
        imageUrl = `data:${guessImageMime(mediaPath)};base64,${bytesToBase64(bytes)}`;
        const cNvPr = getElementsByLocalName(pic, "cNvPr")[0];
        imageAlt = cNvPr?.getAttribute("descr") || cNvPr?.getAttribute("name") || "";
        break;
      }
    }

    // 解析演讲者备注
    let notes = "";
    for (const rel of slideRels.values()) {
      if (rel.type.includes("notesSlide") && rel.target) {
        const notesPath = resolveRelativePath(slidePath, rel.target);
        const notesDoc = await pkg.getXml(notesPath);
        if (notesDoc) {
          const noteShapes = getElementsByLocalName(notesDoc, "sp");
          const noteLines: string[] = [];
          for (const ns of noteShapes) {
            const ph = getPlaceholderType(ns);
            if (ph === "sldnum" || ph === "sldimg") continue;
            noteLines.push(...extractParagraphsFromShape(ns));
          }
          notes = noteLines.join("\n").trim();
        }
        break;
      }
    }

    // 推断版式
    let layout: PptLayoutId = "title-body";
    if (quote) {
      layout = "quote";
    } else if (imageUrl) {
      layout = "text-image";
    } else if (hasRightColumn) {
      layout = "two-column";
    } else if (i === 0 && leftBullets.length === 0) {
      layout = "cover";
    } else if (i > 0 && leftBullets.length === 0 && subtitle) {
      layout = "section";
    }

    slides.push(
      createSlide(layout, {
        title: title || `第 ${i + 1} 页`,
        subtitle,
        bullets: leftBullets,
        rightTitle,
        rightBullets,
        quote,
        quoteAuthor,
        imageUrl,
        imageAlt,
        notes,
      }),
    );
  }

  if (slides.length === 0) {
    return createDefaultPptDeck("导入的 PPT 演示文稿");
  }

  return {
    version: 1,
    aspectRatio: "16:9",
    theme: "classic-light",
    slides,
  };
}
