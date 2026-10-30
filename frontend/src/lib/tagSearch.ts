/** Match tags by name without changing the current note/tag selection. */
export function filterTagsByQuery<T extends { name: string }>(tags: T[], query: string): T[] {
  const keyword = query.trim().replace(/^#\s*/, "").toLocaleLowerCase();
  if (!keyword) return tags;
  return tags.filter((tag) => tag.name.toLocaleLowerCase().includes(keyword));
}
