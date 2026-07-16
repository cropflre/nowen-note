const WIDTH_ATTRIBUTES = ["width", "colwidth", "data-colwidth"] as const;

function positiveInteger(value: string | null | undefined, fallback = 1): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseWidthValues(value: string | null | undefined): number[] {
  if (!value) return [];
  return (value.match(/\d+(?:\.\d+)?/g) || [])
    .map((token) => Number.parseFloat(token))
    .filter((number) => Number.isFinite(number) && number > 0);
}

function readWidthValues(element: HTMLElement): number[] {
  const candidates = [
    element.getAttribute("data-colwidth"),
    element.getAttribute("colwidth"),
    element.getAttribute("width"),
    element.style.width,
    element.style.minWidth,
    element.style.maxWidth,
  ];
  for (const candidate of candidates) {
    const values = parseWidthValues(candidate);
    if (values.length) return values;
  }
  return [];
}

function logicalColumnCount(table: HTMLTableElement): number {
  let count = 0;
  const colCount = Array.from(table.querySelectorAll(":scope > colgroup > col"))
    .reduce((sum, col) => sum + positiveInteger(col.getAttribute("span")), 0);
  count = Math.max(count, colCount);

  for (const row of Array.from(table.rows)) {
    const rowCount = Array.from(row.cells)
      .reduce((sum, cell) => sum + positiveInteger(cell.getAttribute("colspan")), 0);
    count = Math.max(count, rowCount);
  }
  return Math.max(1, count);
}

function addHint(sums: number[], counts: number[], index: number, value: number): void {
  if (index < 0 || index >= sums.length || !Number.isFinite(value) || value <= 0) return;
  sums[index] += value;
  counts[index] += 1;
}

export function getExportTableColumnWeights(table: HTMLTableElement): number[] {
  const columnCount = logicalColumnCount(table);
  const sums = Array.from({ length: columnCount }, () => 0);
  const counts = Array.from({ length: columnCount }, () => 0);

  let colIndex = 0;
  for (const col of Array.from(table.querySelectorAll<HTMLElement>(":scope > colgroup > col"))) {
    const span = positiveInteger(col.getAttribute("span"));
    const values = readWidthValues(col);
    const width = values[0];
    for (let offset = 0; offset < span; offset += 1) {
      if (width) addHint(sums, counts, colIndex + offset, width);
    }
    colIndex += span;
  }

  for (const row of Array.from(table.rows)) {
    let cellIndex = 0;
    for (const cell of Array.from(row.cells)) {
      const span = positiveInteger(cell.getAttribute("colspan"));
      const explicitColumnWidths = [
        ...parseWidthValues(cell.getAttribute("data-colwidth")),
        ...parseWidthValues(cell.getAttribute("colwidth")),
      ];
      if (explicitColumnWidths.length >= span) {
        for (let offset = 0; offset < span; offset += 1) {
          addHint(sums, counts, cellIndex + offset, explicitColumnWidths[offset]);
        }
      } else {
        const width = readWidthValues(cell)[0];
        if (width) {
          const perColumn = width / span;
          for (let offset = 0; offset < span; offset += 1) {
            addHint(sums, counts, cellIndex + offset, perColumn);
          }
        }
      }
      cellIndex += span;
    }
  }

  const known = sums
    .map((sum, index) => counts[index] ? sum / counts[index] : 0)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
  return sums.map((sum, index) => counts[index] ? sum / counts[index] : fallback);
}

export function normalizeColumnWeights(weights: number[]): number[] {
  if (!weights.length) return [];
  const safe = weights.map((weight) => Number.isFinite(weight) && weight > 0 ? weight : 1);
  const total = safe.reduce((sum, weight) => sum + weight, 0) || safe.length;
  const percentages = safe.map((weight) => Number(((weight / total) * 100).toFixed(4)));
  const prior = percentages.slice(0, -1).reduce((sum, value) => sum + value, 0);
  percentages[percentages.length - 1] = Number(Math.max(0, 100 - prior).toFixed(4));
  return percentages;
}

function clearWidthSizing(element: HTMLElement): void {
  for (const attribute of WIDTH_ATTRIBUTES) element.removeAttribute(attribute);
  element.style.removeProperty("width");
  element.style.removeProperty("min-width");
  element.style.removeProperty("max-width");
}

function normalizeCellContents(table: HTMLTableElement, cell: HTMLTableCellElement): void {
  cell.querySelectorAll<HTMLElement>("[style], [width], [colwidth], [data-colwidth]")
    .forEach((element) => {
      if (element.closest("table") !== table) return;
      const media = /^(IMG|VIDEO|SVG|CANVAS)$/i.test(element.tagName);
      if (!media) clearWidthSizing(element);
      element.style.setProperty("max-width", "100%", "important");
      element.style.setProperty("min-width", "0", "important");
      element.style.setProperty("overflow-wrap", "anywhere", "important");
      element.style.setProperty("word-break", "break-word", "important");
      if (media) element.style.setProperty("height", "auto", "important");
    });
}

export function normalizeExportTable(table: HTMLTableElement): number[] {
  const percentages = normalizeColumnWeights(getExportTableColumnWeights(table));

  table.querySelectorAll(":scope > colgroup").forEach((colgroup) => colgroup.remove());
  const colgroup = table.ownerDocument.createElement("colgroup");
  percentages.forEach((percentage) => {
    const col = table.ownerDocument.createElement("col");
    col.style.setProperty("width", `${percentage}%`, "important");
    col.style.setProperty("min-width", "0", "important");
    col.style.setProperty("max-width", "none", "important");
    colgroup.appendChild(col);
  });
  const firstNonCaption = Array.from(table.children)
    .find((child) => child.tagName !== "CAPTION") || null;
  table.insertBefore(colgroup, firstNonCaption);

  clearWidthSizing(table);
  table.style.setProperty("width", "100%", "important");
  table.style.setProperty("max-width", "100%", "important");
  table.style.setProperty("min-width", "0", "important");
  table.style.setProperty("table-layout", "fixed", "important");
  table.style.setProperty("overflow-wrap", "anywhere", "important");
  table.dataset.exportTableNormalized = "true";

  for (const cell of Array.from(table.querySelectorAll<HTMLTableCellElement>("th, td"))) {
    clearWidthSizing(cell);
    cell.style.setProperty("width", "auto", "important");
    cell.style.setProperty("min-width", "0", "important");
    cell.style.setProperty("max-width", "none", "important");
    cell.style.setProperty("white-space", "normal", "important");
    cell.style.setProperty("overflow-wrap", "anywhere", "important");
    cell.style.setProperty("word-break", "break-word", "important");
    normalizeCellContents(table, cell);
  }

  return percentages;
}

export function normalizeExportTables(
  root: ParentNode,
  _availableWidth?: number,
): number {
  const tables = Array.from(root.querySelectorAll<HTMLTableElement>("table"));
  tables.forEach(normalizeExportTable);
  return tables.length;
}

export function findOverflowingExportTables(
  root: ParentNode,
  availableWidth: number,
  tolerance = 1,
): HTMLTableElement[] {
  return Array.from(root.querySelectorAll<HTMLTableElement>("table"))
    .filter((table) => {
      const parentWidth = table.parentElement?.clientWidth || availableWidth;
      if (parentWidth <= 0) return false;
      const visualWidth = table.getBoundingClientRect().width;
      return table.scrollWidth > parentWidth + tolerance
        || visualWidth > parentWidth + tolerance;
    });
}
