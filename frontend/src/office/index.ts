// office/index.ts —— 模块对外公开 API
//
// 前端任何地方需要使用自研 Office 能力，**只从这里 import**，不要直接
// 摸 ir/、parsers/、opc/ 内部文件。这样将来重构内部结构不会牵动调用方。

export { parseDocx } from "./parsers/docx-parser";
export type {
  DocxIR,
  DocMeta,
  Section,
  BlockNode,
  PageBreakNode,
  ParagraphNode,
  RunNode,
  RunProps,
  InlineNode,
  ImageNode,
} from "./ir/document";
export { OpcPackage } from "./opc/reader";

// 序列化器（W2 阶段）—— 现仅有"空白 docx 生成"，用于"新建 Word 文档"入口。
export { createBlankDocx, blankDocxFile } from "./serializers/docx-blank";
// 完整 IR → docx 序列化器（W2 MVP）。可把任何 DocxIR 落回 .docx 二进制。
export { createDocx } from "./serializers/docx-serializer";
export type { CreateDocxOptions } from "./serializers/docx-serializer";
// Tiptap JSON → DocxIR 适配器（W2 MVP）。配合 createDocx 实现"任意笔记导出 .docx"。
export { tiptapToIr } from "./serializers/tiptap-to-ir";
export type { TiptapToIrOptions } from "./serializers/tiptap-to-ir";
// DocxIR → Tiptap JSON 适配器（W2 双向闭环）。配合 parseDocx 实现高保真导入编辑。
export { irToTiptap } from "./serializers/ir-to-tiptap";
export type { IrToTiptapOptions, IrToTiptapResult, TiptapJsonNode } from "./serializers/ir-to-tiptap";
