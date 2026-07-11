import assert from "node:assert/strict";
import test from "node:test";
import { siyuanSyToTiptapJson, type TiptapJsonNode } from "../src/lib/siyuanTiptapConverter";

function doc(children: any[]): any {
  return { Type: "NodeDocument", Children: children };
}

function paragraph(children: any[]): any {
  return { Type: "NodeParagraph", Children: children };
}

function text(value: string): any {
  return { Type: "NodeText", Data: value };
}

function textMark(type: string, value: string, extra: Record<string, unknown> = {}): any {
  return {
    Type: "NodeTextMark",
    TextMarkType: type,
    TextMarkTextContent: value,
    ...extra,
  };
}

function tableCell(value: string, extra: Record<string, unknown> = {}): any {
  return {
    Type: "NodeTableCell",
    ...extra,
    Children: [paragraph([text(value)])],
  };
}

function flatten(node: TiptapJsonNode): TiptapJsonNode[] {
  return [node, ...(node.content || []).flatMap(flatten)];
}

test("normalizes real SiYuan numeric table alignment values", () => {
  const converted = JSON.parse(siyuanSyToTiptapJson(doc([{
    Type: "NodeTable",
    TableAligns: [1, 2, 3],
    colgroup: [{ width: 120 }, { width: 180 }, { width: 240 }],
    Children: [{
      Type: "NodeTableRow",
      Children: [
        tableCell("left"),
        tableCell("explicit-right", { TableCellAlign: 3 }),
        tableCell("right"),
      ],
    }],
  }]))) as TiptapJsonNode;

  const table = converted.content?.[0];
  assert.equal(table?.type, "table");
  assert.deepEqual(table?.attrs?.tableAligns, ["left", "center", "right"]);
  assert.deepEqual(table?.attrs?.colgroup, [{ width: 120 }, { width: 180 }, { width: 240 }]);

  const cells = table?.content?.[0]?.content || [];
  assert.equal(cells[0]?.attrs?.align, "left");
  assert.equal(cells[1]?.attrs?.align, "right");
  assert.equal(cells[2]?.attrs?.align, "right");
});

test("keeps code marks schema-valid by dropping incompatible marks", () => {
  const converted = JSON.parse(siyuanSyToTiptapJson(doc([
    paragraph([
      textMark("strong code a", "code-link", {
        TextMarkAHref: "https://example.com/code",
        style: "color:#3b82f6; font-size:24px; background-color:#fde68a",
      }),
    ]),
  ]))) as TiptapJsonNode;

  const node = flatten(converted).find((item) => item.type === "text" && item.text === "code-link");
  assert.ok(node);
  assert.deepEqual(node.marks, [{ type: "code" }]);
});

test("preserves allowlisted inline styles and rejects unsafe CSS values", () => {
  const converted = JSON.parse(siyuanSyToTiptapJson(doc([
    paragraph([
      textMark("strong", "safe-style", {
        style: "color:#3b82f6; font-size:24px; background-color:#fde68a; text-decoration: underline",
      }),
      text(" "),
      textMark("strong", "unsafe-style", {
        style: "color:url(javascript:alert(1)); font-size:999999px; background-color:var(--danger)",
      }),
    ]),
  ]))) as TiptapJsonNode;

  const safe = flatten(converted).find((item) => item.type === "text" && item.text === "safe-style");
  assert.ok(safe?.marks?.some((mark) => mark.type === "bold"));
  assert.ok(safe?.marks?.some((mark) => mark.type === "underline"));
  assert.ok(safe?.marks?.some((mark) =>
    mark.type === "textStyle" &&
    mark.attrs?.color === "#3b82f6" &&
    mark.attrs?.fontSize === "24px"
  ));
  assert.ok(safe?.marks?.some((mark) =>
    mark.type === "highlight" && mark.attrs?.color === "#fde68a"
  ));

  const unsafe = flatten(converted).find((item) => item.type === "text" && item.text === "unsafe-style");
  assert.ok(unsafe?.marks?.some((mark) => mark.type === "bold"));
  assert.equal(unsafe?.marks?.some((mark) => mark.type === "textStyle"), false);
  assert.equal(unsafe?.marks?.some((mark) => mark.type === "highlight"), false);
});
