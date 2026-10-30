export type SharePageWidth = "standard" | "wide" | "full";

export function normalizeSharePageWidth(value: unknown): SharePageWidth {
  return value === "wide" || value === "full" ? value : "standard";
}

export function sharePageWidthClass(value: unknown, withOutline = false): string {
  const width = normalizeSharePageWidth(value);
  if (!withOutline) {
    return width === "full" ? "max-w-none" : width === "wide" ? "max-w-6xl" : "max-w-4xl";
  }
  if (width === "standard") {
    return "max-w-6xl lg:grid lg:grid-cols-[minmax(0,56rem)_16rem] lg:gap-8 lg:items-start";
  }
  return `${width === "full" ? "max-w-none" : "max-w-[90rem]"} lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-8 lg:items-start`;
}
