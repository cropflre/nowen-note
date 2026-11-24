import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import KnowledgeSearchScopeSwitch from "../KnowledgeSearchScopeSwitch";
import KnowledgeSearchScopeMenuButton from "../KnowledgeSearchScopeMenuButton";

describe("knowledge search scope languages", () => {
  it.each([
    ["zh-CN", "目录", "全文", "搜索范围"],
    ["en", "Tree", "Full text", "Search scope"],
  ])("renders search controls in %s", async (language, tree, fullText, scope) => {
    await i18n.changeLanguage(language);
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <KnowledgeSearchScopeSwitch scope="tree" onChange={() => {}} />
        <KnowledgeSearchScopeMenuButton scope="content" onChange={() => {}} />
      </I18nextProvider>,
    );
    expect(html).toContain(tree);
    expect(html).toContain(fullText);
    expect(html).toContain(scope);
  });
});
