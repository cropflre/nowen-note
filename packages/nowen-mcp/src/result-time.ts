// SQLite metadata timestamps are UTC. Task dueDate/dueAt are local calendar
// values and must never be shifted or labelled as UTC.
const UTC_FIELDS = new Set(["createdAt", "updatedAt", "completedAt", "archivedAt", "lastNotifiedAt"]);

export function stringifyTimedResult(value: unknown): string {
  return JSON.stringify(value, (key, item) => {
    if (UTC_FIELDS.has(key) && typeof item === "string"
      && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(item)) {
      return `${item.replace(" ", "T")}Z`;
    }
    return item;
  }, 2);
}
