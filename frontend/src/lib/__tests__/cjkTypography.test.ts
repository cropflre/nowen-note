// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { transformCjkTypography } from "@/lib/cjkTypography";
import { applyMarkdownCjkTypography } from "@/lib/markdownCommands";
import { applyTiptapCjkTypography } from "@/lib/tiptapCjkTypography";

describe("#822 manual Chinese typography", () => {
  it("inserts spaces only at Han / Latin and digit boundaries", () => {
    expect(transformCjkTypography("使用PostgreSQL数据库；2024年10月1日", "spacing"))
      .toBe("使用 PostgreSQL 数据库；2024 年 10 月 1 日");
    expect(transformCjkTypography("hello, world (参见图1)", "spacing"))
      .toBe("hello, world (参见图 1)");
  });

  it("protects fenced code, inline code, TeX, URLs, email, HTML and Markdown destinations", () => {
    const tick = String.fromCharCode(96);
    const md = [
      "使用PostgreSQL数据库，打开[网址介绍](https://example.com/中文doc?q=1.0)看文档",
      "联系 dev中文@example.com 或访问 https://example.com/中文code",
      "内联"+tick+"code中文ABC"+tick+" 保持",
      "公式$E=mc中文2$与\\(a中文3\\)不改",
      "<span class='中文ABC'>内容ABC</span>",
      tick.repeat(3)+"javascript", "const name = '中文ABC';", tick.repeat(3),
      "最后English版本",
    ].join("\n");
    const changed = transformCjkTypography(md, "spacing", "markdown");
    expect(changed).toContain("使用 PostgreSQL 数据库");
    expect(changed).toContain("网址介绍](https://example.com/中文doc?q=1.0)");
    expect(changed).toContain("dev中文@example.com");
    expect(changed).toContain("https://example.com/中文code");
    expect(changed).toContain(tick+"code中文ABC"+tick);
    expect(changed).toContain("$E=mc中文2$");
    expect(changed).toContain("\\(a中文3\\)");
    expect(changed).toContain("<span class='中文ABC'>");
    expect(changed).toContain("const name = '中文ABC';");
    expect(changed).toContain("最后 English 版本");
  });

  it("preserves frontmatter and Nowen note/mindmap reference identifiers", () => {
    const md = "---\ntitle: 使用PostgreSQL笔记\n---\n见[[使用PostgreSQL笔记]]或![[mindmap:中文ABC]]和[^脚注A]。";
    const result = transformCjkTypography(md, "spacing", "markdown");
    expect(result).toContain("title: 使用PostgreSQL笔记");
    expect(result).toContain("[[使用PostgreSQL笔记]]");
    expect(result).toContain("![[mindmap:中文ABC]]");
    expect(result).toContain("[^脚注A]");
  });

  it("normalizes Chinese punctuation but keeps English clauses and numeric tokens", () => {
    expect(transformCjkTypography("你好,今天很好!欢迎(大家).", "punctuation"))
      .toBe("你好，今天很好！欢迎（大家）。");
    expect(transformCjkTypography("他说，Hello, world! 然后离开了。", "punctuation"))
      .toBe("他说，Hello, world! 然后离开了。");
    expect(transformCjkTypography("Hello， world！", "punctuation"))
      .toBe("Hello, world!");
    const numbers = transformCjkTypography("价格3.14,版本v1.0;时间10:30;总数1,000", "punctuation");
    expect(numbers).toContain("3.14");
    expect(numbers).toContain("v1.0");
    expect(numbers).toContain("10:30");
    expect(numbers).toContain("1,000");
  });

  it("keeps inline and block math untouched in rich-text text nodes", () => {
    expect(transformCjkTypography("公式$E中文2$混排", "spacing"))
      .toBe("公式$E中文2$混排");
    expect(transformCjkTypography("公式\\(x中文3\\)不应改写", "spacing"))
      .toBe("公式\\(x中文3\\)不应改写");
  });

  it("converts only matched quotation pairs and skips apostrophes", () => {
    expect(transformCjkTypography('“外层‘内层’”', "cornerQuotes"))
      .toBe("「外层『内层』」");
    expect(transformCjkTypography('"外层\'内层\'"', "cornerQuotes"))
      .toBe("「外层『内层』」");
    expect(transformCjkTypography("don't students' said 'ok'", "cornerQuotes"))
      .toContain("don't students'");
    expect(transformCjkTypography('没有闭合的"引号', "cornerQuotes"))
      .toBe('没有闭合的"引号');
  });

  it("is idempotent after a single manual action", () => {
    for (const action of ["spacing", "punctuation", "cornerQuotes"] as const) {
      const once = transformCjkTypography('他用PostgreSQL, 说“你好”', action);
      expect(transformCjkTypography(once, action)).toBe(once);
    }
  });

  it("CodeMirror edits only the selection and undoes all changes in one step", () => {
    const source = "第一行PostgreSQL测试\n第二行SQLite数据库";
    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView({ parent: host, state: EditorState.create({
      doc: source, extensions: [history()],
    }) });
    view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, source.indexOf("\n"))]) });
    expect(applyMarkdownCjkTypography(view, "spacing")).toBe(true);
    expect(view.state.doc.toString()).toBe("第一行 PostgreSQL 测试\n第二行SQLite数据库");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
    view.destroy(); host.remove();
  });

  it("CodeMirror protects a selection placed inside inline code", () => {
    const tick = String.fromCharCode(96);
    const source = "普通中文ABC "+tick+"代码PostgreSQL测试"+tick+" 结束";
    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView({ parent: host, state: EditorState.create({
      doc: source, extensions: [history()],
    }) });
    view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, source.length)]) });
    expect(applyMarkdownCjkTypography(view, "spacing")).toBe(true);
    expect(view.state.doc.toString()).toContain(tick+"代码PostgreSQL测试"+tick);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
    view.destroy(); host.remove();
  });

  it("Tiptap preserves marks and code nodes and supports one-step undo", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({ element, extensions: [StarterKit],
      content: '<p><strong>使用PostgreSQL数据库</strong> <code>代码Python片段</code></p><pre><code>代码ABC</code></pre><p>结尾</p>',
    });
    const before = editor.getHTML();
    expect(applyTiptapCjkTypography(editor, "spacing")).toBe(true);
    expect(editor.getHTML()).toContain("<strong>使用 PostgreSQL 数据库</strong>");
    expect(editor.getHTML()).toContain("<code>代码Python片段</code>");
    expect(editor.getHTML()).toContain("代码ABC");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getHTML()).toBe(before);
    editor.destroy(); element.remove();
  });
});
