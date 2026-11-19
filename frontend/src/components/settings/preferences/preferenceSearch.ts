import type { PreferenceScope } from "./PreferenceControls";

export type PreferencesPage = "home" | "navigation" | "editing" | "layout" | "advanced";
export type PreferenceDisclosure = "editingMore" | "taskCenter";
/** Settings tabs that received options from the old Switches page. */
export type RelatedSettingsTab = "security" | "ai" | "users";

export type PreferenceTarget =
  | { kind: "page"; page: Exclude<PreferencesPage, "home">; disclosure?: PreferenceDisclosure }
  | { kind: "tab"; tab: RelatedSettingsTab; section: string };

export interface PreferenceSearchEntry {
  /** `data-preference-id` of the row on its page, or the section name in another tab. */
  id: string;
  title: string;
  description?: string;
  keywords?: string;
  /** Where the setting lives, shown with each result. */
  path: string[];
  scope?: PreferenceScope;
  target: PreferenceTarget;
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/** "代码换行" finds "代码块自动换行": the characters appear in order. */
function containsInOrder(needle: string, haystack: string): boolean {
  const characters = Array.from(needle);
  let index = 0;
  for (const character of haystack) {
    if (character === characters[index]) index += 1;
    if (index === characters.length) return true;
  }
  return false;
}

function termScore(term: string, entry: PreferenceSearchEntry): number | null {
  const title = normalizeSearchText(entry.title);
  if (title === term) return 0;
  if (title.startsWith(term)) return 1;
  if (title.includes(term)) return 2;
  if (normalizeSearchText(entry.keywords ?? "").includes(term)) return 3;
  if (normalizeSearchText(`${entry.description ?? ""} ${entry.path.join(" ")}`).includes(term)) return 4;
  if (Array.from(term).length >= 2 && containsInOrder(term, title)) return 5;
  return null;
}

/** Every term must match; better title matches rank first, ties keep page order. */
export function searchPreferences(
  entries: readonly PreferenceSearchEntry[],
  query: string,
  limit = 20,
): PreferenceSearchEntry[] {
  const terms = normalizeSearchText(query).split(" ").filter(Boolean);
  if (terms.length === 0) return [];
  const matches: Array<{ entry: PreferenceSearchEntry; score: number; index: number }> = [];
  entries.forEach((entry, index) => {
    let score = 0;
    for (const term of terms) {
      const value = termScore(term, entry);
      if (value === null) return;
      score += value;
    }
    matches.push({ entry, score, index });
  });
  return matches
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, limit)
    .map(({ entry }) => entry);
}
