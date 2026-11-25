import { describe, expect, it } from "vitest";
import {
  createPptx,
  createSlide,
  extractPptPlainText,
  outlineTextToPptDeck,
  parsePptx,
  type PptDeckIR,
} from "@/office";

// 1x1 透明 PNG data URL
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("PPTX 双向往返与大纲转换（office/ppt）", () => {
  it("PptDeckIR → createPptx → parsePptx 完整保留封面、双栏、配图、金句与演讲者备注", async () => {
    const deck: PptDeckIR = {
      version: 1,
      aspectRatio: "16:9",
      theme: "deep-space",
      slides: [
        createSlide("cover", {
          title: "Nowen Note 年度汇报",
          subtitle: "个人与小团队自托管知识库",
          notes: "开场白：欢迎大家参加本次演示",
        }),
        createSlide("two-column", {
          title: "方案对比",
          bullets: ["SQLite 零运维", "单文件一键备份"],
          rightTitle: "团队能力",
          rightBullets: ["用户组批量授权", "生效权限诊断"],
        }),
        createSlide("text-image", {
          title: "架构示意图",
          bullets: ["纯前端 OOXML 双向解析", "懒加载不影响首屏体积"],
          imageUrl: TINY_PNG_DATA_URL,
          imageAlt: "系统架构缩略图",
        }),
        createSlide("quote", {
          title: "设计理念",
          quote: "数据真正属于你，交互对每个人友好。",
          quoteAuthor: "—— Nowen 团队",
        }),
      ],
    };

    const bytes = await createPptx(deck);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // ZIP 文件头 PK\x03\x04
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);

    const parsed = await parsePptx(bytes);
    expect(parsed.slides).toHaveLength(4);

    expect(parsed.slides[0].layout).toBe("cover");
    expect(parsed.slides[0].title).toBe("Nowen Note 年度汇报");
    expect(parsed.slides[0].subtitle).toBe("个人与小团队自托管知识库");
    expect(parsed.slides[0].notes).toContain("开场白");

    expect(parsed.slides[1].layout).toBe("two-column");
    expect(parsed.slides[1].bullets).toEqual(["SQLite 零运维", "单文件一键备份"]);
    expect(parsed.slides[1].rightTitle).toBe("团队能力");
    expect(parsed.slides[1].rightBullets).toEqual(["用户组批量授权", "生效权限诊断"]);

    expect(parsed.slides[2].layout).toBe("text-image");
    expect(parsed.slides[2].imageUrl).toMatch(/^data:image\/png;base64,/);
    expect(parsed.slides[2].imageAlt).toBe("系统架构缩略图");

    expect(parsed.slides[3].layout).toBe("quote");
    expect(parsed.slides[3].quote).toContain("数据真正属于你");
    expect(parsed.slides[3].quoteAuthor).toContain("Nowen 团队");
  });

  it("outlineTextToPptDeck 支持 Markdown 标题、要点与引用自动分页", () => {
    const md = [
      "# 产品路线图",
      "2026 Q4 规划",
      "## 核心功能",
      "- Word 与 PPT 原生支持",
      "- 无障碍全键盘操作",
      "## 价值主张",
      "> 专注个人与小团队自托管",
    ].join("\n");

    const deck = outlineTextToPptDeck(md, { theme: "forest-calm" });
    expect(deck.theme).toBe("forest-calm");
    expect(deck.slides).toHaveLength(3);
    expect(deck.slides[0].layout).toBe("cover");
    expect(deck.slides[0].title).toBe("产品路线图");
    expect(deck.slides[0].subtitle).toBe("2026 Q4 规划");
    expect(deck.slides[1].layout).toBe("title-body");
    expect(deck.slides[1].bullets).toEqual(["Word 与 PPT 原生支持", "无障碍全键盘操作"]);
    expect(deck.slides[2].layout).toBe("quote");
    expect(deck.slides[2].quote).toBe("专注个人与小团队自托管");
    expect(extractPptPlainText(deck)).toContain("无障碍全键盘操作");
  });
});
