import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFtsSearchTerm,
  containsAllSearchTerms,
  countSearchTermOccurrences,
  normalizeSearchText,
  splitSearchTerms,
} from "../src/lib/searchQuery";

test("search normalization folds width, case, whitespace and zero-width characters", () => {
  assert.equal(normalizeSearchText("  ＡＢＣ\u200B１２３  "), "abc123");
  assert.equal(normalizeSearchText("Alpha\n\tBETA"), "alpha beta");
});

test("literal terms keep punctuation that changes meaning", () => {
  assert.deepEqual(splitSearchTerms("C++ foo-bar 中文检索"), ["c++", "foo-bar", "中文检索"]);
  assert.equal(containsAllSearchTerms("Modern C++ and foo-bar", ["c++", "foo-bar"]), true);
  assert.equal(containsAllSearchTerms("C language and foo bar", ["c++", "foo-bar"]), false);
});

test("FTS candidates are conservative tokens and never define final truth", () => {
  assert.equal(buildFtsSearchTerm("C++ foo-bar"), '"c"* AND "foo"* AND "bar"*');
  assert.equal(buildFtsSearchTerm("全文搜索"), '"全文搜索"*');
});

test("occurrence counting uses the same normalization as filtering", () => {
  assert.equal(countSearchTermOccurrences("ＡＢＣ１２３ abc123", "abc123"), 2);
  assert.equal(countSearchTermOccurrences("Alpha alpha ALPHA", "alpha"), 3);
});
