import { common, createLowlight, type LanguageFn } from "lowlight";
import maxscript from "@/lib/codeBlockLanguages/maxscript";

const commonRegistry = common as Record<string, LanguageFn>;
const EXPLICIT_ONLY_LANGUAGES = new Set(["maxscript"]);

/**
 * Extend lowlight's shared `common` registry before editor-level instances are created.
 *
 * TiptapEditor constructs its lowlight instance at module evaluation time. Importing this module
 * from the shared instrumentation and code-block view guarantees MAXScript is registered before
 * that instance is created, without maintaining separate rich-text and Markdown registries.
 */
export function installCodeBlockLanguages(): Record<string, LanguageFn> {
  if (!commonRegistry.maxscript) commonRegistry.maxscript = maxscript;
  return commonRegistry;
}

installCodeBlockLanguages();

/** Keep opt-in grammars out of `auto` so adding them cannot change existing detection results. */
export function getCodeBlockAutoLanguageSubset(
  lowlight: { listLanguages: () => string[] },
): string[] {
  return lowlight.listLanguages().filter((language) => !EXPLICIT_ONLY_LANGUAGES.has(language));
}

/** Create an isolated lowlight instance with every Nowen code-block language registered. */
export function createCodeBlockLowlight() {
  const lowlight = createLowlight({ ...installCodeBlockLanguages() });
  const highlightAuto = lowlight.highlightAuto.bind(lowlight);

  lowlight.highlightAuto = ((value, options) => highlightAuto(value, {
    ...(options || {}),
    subset: options?.subset || getCodeBlockAutoLanguageSubset(lowlight),
  })) as typeof lowlight.highlightAuto;

  return lowlight;
}

/** User-facing label for language badges and selectors. */
export function formatCodeBlockLanguageLabel(raw: string | null | undefined): string {
  if (!raw) return "auto";
  const language = raw.toLowerCase();
  if (language === "plaintext" || language === "text") return "text";
  if (language === "maxscript" || language === "ms" || language === "mcr") return "MAXScript";
  return language;
}
