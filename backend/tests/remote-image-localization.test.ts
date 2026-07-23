import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyImageUrl,
  replaceRemoteImages,
  scanRemoteImages,
} from "../src/lib/remote-image-localization";

test("classifyImageUrl separates remote, Nowen local and unsupported schemes", () => {
  assert.equal(classifyImageUrl("https://cdn.example.com/a.png"), "remote");
  assert.equal(classifyImageUrl("http://cdn.example.com/a.png"), "remote");
  assert.equal(classifyImageUrl("/api/attachments/att-1"), "local");
  assert.equal(classifyImageUrl("https://notes.example.com/api/files/file-1"), "local");
  assert.equal(classifyImageUrl("data:image/png;base64,AAAA"), "ignored");
  assert.equal(classifyImageUrl("blob:https://notes.example.com/1"), "ignored");
  assert.equal(classifyImageUrl("file:///tmp/a.png"), "ignored");
});

test("Markdown scan only counts image destinations and preserves ordinary links", () => {
  const content = [
    "![remote](https://cdn.example.com/a.png \"title\")",
    "![remote duplicate](<https://cdn.example.com/a.png>)",
    "![local](/api/attachments/local-1)",
    "![data](data:image/png;base64,AAAA)",
    "[ordinary link](https://cdn.example.com/a.png)",
  ].join("\n");

  const scan = scanRemoteImages(content, "markdown");
  assert.equal(scan.totalImageReferences, 4);
  assert.equal(scan.remoteReferenceCount, 2);
  assert.equal(scan.localReferenceCount, 1);
  assert.equal(scan.ignoredReferenceCount, 1);
  assert.deepEqual(scan.remoteUrls, ["https://cdn.example.com/a.png"]);

  const replacement = replaceRemoteImages(
    content,
    "markdown",
    new Map([["https://cdn.example.com/a.png", "/api/attachments/new-1"]]),
  );
  assert.equal(replacement.replacedCount, 2);
  assert.match(replacement.content, /!\[remote\]\(\/api\/attachments\/new-1 "title"\)/);
  assert.match(replacement.content, /!\[remote duplicate\]\(<\/api\/attachments\/new-1>\)/);
  assert.match(replacement.content, /\[ordinary link\]\(https:\/\/cdn\.example\.com\/a\.png\)/);

  const second = replaceRemoteImages(
    replacement.content,
    "markdown",
    new Map([["https://cdn.example.com/a.png", "/api/attachments/new-1"]]),
  );
  assert.equal(second.changed, false);
  assert.equal(second.replacedCount, 0);
});

test("HTML replacement changes img src only and preserves attributes", () => {
  const content = [
    '<p><img src="https://cdn.example.com/a.webp" alt="A" width="320" data-align="center"></p>',
    "<img src='/api/attachments/local-1' alt='local'>",
    '<a href="https://cdn.example.com/a.webp">ordinary</a>',
  ].join("");

  const scan = scanRemoteImages(content, "html");
  assert.equal(scan.remoteReferenceCount, 1);
  assert.equal(scan.localReferenceCount, 1);

  const replacement = replaceRemoteImages(
    content,
    "html",
    new Map([["https://cdn.example.com/a.webp", "/api/attachments/new-html"]]),
  );
  assert.equal(replacement.replacedCount, 1);
  assert.match(
    replacement.content,
    /<img src="\/api\/attachments\/new-html" alt="A" width="320" data-align="center">/,
  );
  assert.match(replacement.content, /href="https:\/\/cdn\.example\.com\/a\.webp"/);
});

test("Tiptap replacement preserves image node metadata", () => {
  const document = {
    type: "doc",
    content: [
      {
        type: "image",
        attrs: {
          src: "https://cdn.example.com/a.png",
          alt: "diagram",
          title: "Architecture",
          width: 640,
          align: "center",
        },
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "https://cdn.example.com/a.png" }],
      },
      {
        type: "image",
        attrs: { src: "/api/attachments/local-1", width: 100 },
      },
    ],
  };
  const content = JSON.stringify(document);
  const scan = scanRemoteImages(content, "tiptap-json");
  assert.equal(scan.remoteReferenceCount, 1);
  assert.equal(scan.localReferenceCount, 1);

  const replacement = replaceRemoteImages(
    content,
    "tiptap-json",
    new Map([["https://cdn.example.com/a.png", "/api/attachments/new-json"]]),
  );
  assert.equal(replacement.replacedCount, 1);
  const parsed = JSON.parse(replacement.content);
  assert.deepEqual(parsed.content[0].attrs, {
    src: "/api/attachments/new-json",
    alt: "diagram",
    title: "Architecture",
    width: 640,
    align: "center",
  });
  assert.equal(parsed.content[1].content[0].text, "https://cdn.example.com/a.png");
});

test("malformed Tiptap JSON is reported without modifying content", () => {
  const content = '{"type":"doc","content":[';
  const scan = scanRemoteImages(content, "tiptap-json");
  assert.ok(scan.parseError);
  assert.equal(scan.remoteReferenceCount, 0);

  const replacement = replaceRemoteImages(
    content,
    "tiptap-json",
    new Map([["https://cdn.example.com/a.png", "/api/attachments/new-json"]]),
  );
  assert.equal(replacement.content, content);
  assert.equal(replacement.changed, false);
  assert.ok(replacement.parseError);
});
