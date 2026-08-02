import type { TaskQuickAddParseResult } from "./taskSmartRecognition";

export function captureTitleFromText(text: string, maxLength = 180): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
  return firstLine.slice(0, maxLength);
}

export function recognizedCaptureLabels(
  input: string,
  ranges: TaskQuickAddParseResult["recognizedRanges"],
): string[] {
  return ranges
    .map((range) => input.slice(range.start, range.end).trim())
    .filter(Boolean);
}

export function shouldApplySmartCapturePatch(parsed: TaskQuickAddParseResult): boolean {
  const repeatRule = parsed.taskPatch.repeatRule;
  return !repeatRule || repeatRule === "none";
}

export function captureDescriptionFromText(text: string): string {
  const normalized = text.trim();
  return normalized.length > 180 || normalized.includes("\n") ? normalized : "";
}
