import { generateJSON, type JSONContent } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { preparePastedImages, rescuePastedImages } from "../pastedImages";
import { mergeRtfImagesIntoHtml } from "../rtfPastedImages";

const image = (number: number) => `data:image/png;base64,${btoa(`${number}`.repeat(300))}`;

function parsePaste(html: string, images: string[]) {
  const prepared = preparePastedImages(html);
  const root = document.createElement("div");
  root.innerHTML = mergeRtfImagesIntoHtml(prepared.html, images);
  rescuePastedImages(root);
  const doc = generateJSON(root.innerHTML, [StarterKit, Image.configure({ inline: true, allowBase64: true })]);
  const sources: string[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === "image") sources.push(node.attrs?.src as string);
    node.content?.forEach(visit);
  };
  visit(doc);
  return { root, doc, sources };
}

describe("Word RTF image placement", () => {
  it("retains nine recovered photos when Word image markup disappears during sanitizing", () => {
    const images = Array.from({ length: 9 }, (_, index) => image(index));
    const result = parsePaste('<p>Word photos</p><!--[if gte vml 1]><v:shape><v:imagedata src="file:///tmp/photo.png" /></v:shape><![endif]-->', images);
    expect(result.sources).toEqual(images);
    expect(result.root.textContent).toBe("Word photos");
  });

  it("fills file placeholders in their original text positions", () => {
    const images = [image(1), image(2)];
    const result = parsePaste('<p>before<img src="file:///tmp/first.png">between<img src="file:///tmp/second.png">after</p>', images);
    expect(result.sources).toEqual(images);
    expect(Array.from(result.root.querySelector("p")!.childNodes).map((node) => node.nodeType === Node.TEXT_NODE ? node.textContent : (node as Element).getAttribute("src")))
      .toEqual(["before", images[0], "between", images[1], "after"]);
  });

  it("preserves usable sources while filling the matching later image and retaining the remainder", () => {
    const images = [image(1), image(2), image(3), image(4)];
    const result = parsePaste(`<p><img src="https://cdn.example/first.png"><img src="${images[1]}"><img src="file:///tmp/third.png"></p>`, images);
    expect(result.sources).toEqual(["https://cdn.example/first.png", images[1], images[2], images[3]]);
  });

  it("keeps repeated existing image references without consuming the next recovered image", () => {
    const images = [image(1), image(2)];
    const result = parsePaste(`<p><img src="${images[0]}"><img src="${images[0]}"><img src="file:///tmp/second.png"></p>`, images);
    expect(result.sources).toEqual([images[0], images[0], images[1]]);
  });

  it.each([false, true])("retains repeated file references when RTF repeats the same bytes: %s", (repeatedBytes) => {
    const images = repeatedBytes ? [image(1), image(1), image(2)] : [image(1), image(2)];
    const root = document.createElement("div");
    root.innerHTML = mergeRtfImagesIntoHtml('<p><img src="file:///tmp/first.png"><img src="file:///tmp/first.png"><img src="file:///tmp/second.png"></p>', images);
    expect(Array.from(root.querySelectorAll("img")).map((img) => img.getAttribute("src")))
      .toEqual([image(1), image(1), image(2)]);
  });

  it("continues to remove clipboard scripts and event handlers before restoring photos", () => {
    const result = parsePaste('<script>alert(1)</script><p onclick="alert(1)">text<img src="file:///tmp/photo.png" onerror="alert(1)"></p><a href="javascript:alert(1)">link</a>', [image(1), image(2)]);
    expect(result.sources).toEqual([image(1), image(2)]);
    expect(result.root.querySelector("script, [onclick], [onerror], [href]")).toBeNull();
    expect(result.root.textContent).toBe("textlink");
  });
});
