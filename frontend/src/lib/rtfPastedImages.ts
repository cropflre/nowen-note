/** Restore Word photos after clipboard sanitizing has removed local/VML sources. */
export function mergeRtfImagesIntoHtml(html: string, rtfImages: string[]): string {
  if (!rtfImages.length) return html;
  const root = new DOMParser().parseFromString(html, "text/html").body;
  const used = new Set<number>();
  const assignedSources = new Map<string, string>();
  let cursor = 0;
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const src = (img.getAttribute("src") || "").trim();
    const needsReplacement = !src || /^file:\/\//i.test(src) || /^about:/i.test(src);
    const knownSource = assignedSources.get(src) || src;
    let index = knownSource ? rtfImages.findIndex((image, i) => image === knownSource && !used.has(i)) : -1;
    if (index < 0 && src && assignedSources.has(src)) {
      if (needsReplacement) img.setAttribute("src", assignedSources.get(src)!);
      continue;
    }
    if (index < 0) {
      while (used.has(cursor)) cursor += 1;
      if (cursor >= rtfImages.length) continue;
      index = cursor++;
    }
    // RTF includes usable HTML images too; consume their slots without changing src.
    used.add(index);
    const restoredSrc = needsReplacement ? rtfImages[index] : src;
    if (needsReplacement) img.setAttribute("src", restoredSrc);
    if (src) assignedSources.set(src, restoredSrc);
  }
  // VML/conditional images may leave no ordinary <img> after sanitizing. Their
  // exact text positions are unavailable, so preserve their bytes after the text.
  rtfImages.forEach((src, index) => {
    if (used.has(index)) return;
    const paragraph = root.ownerDocument.createElement("p");
    const img = root.ownerDocument.createElement("img");
    img.setAttribute("src", src);
    paragraph.appendChild(img);
    root.appendChild(paragraph);
  });
  return root.innerHTML;
}
