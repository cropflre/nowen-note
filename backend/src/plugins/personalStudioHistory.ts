import type Database from "better-sqlite3";
import { getPersonalStudioApp, updatePersonalStudioApp, parsePersonalAppSpec, type PersonalStudioApp } from "./personalStudioApps.js";

export interface PersonalStudioVersion {
  revision: number;
  createdAt: string;
  name: string;
  layout: string;
  fieldCount: number;
  itemCount: number;
}
type HistoryRow = { revision: number; createdAt: string; specJson: string };
function issue(code: string): never { throw Object.assign(new Error(code), { code }); }

export function listPersonalStudioVersions(db: Database.Database, userId: string, appId: string): PersonalStudioVersion[] {
  getPersonalStudioApp(db, userId, appId);
  const rows = db.prepare("SELECT revision, createdAt, specJson FROM personal_studio_app_versions WHERE appId=? AND userId=? ORDER BY revision DESC LIMIT 25")
    .all(appId, userId) as HistoryRow[];
  return rows.map(row => {
    const spec = parsePersonalAppSpec(JSON.parse(row.specJson));
    return { revision: row.revision, createdAt: row.createdAt, name: spec.name, layout: spec.layout, fieldCount: spec.fields.length, itemCount: spec.items.length };
  });
}
export function restorePersonalStudioVersion(db: Database.Database, userId: string, appId: string, revision: number, expectedRevision: number): PersonalStudioApp {
  if (!Number.isSafeInteger(revision) || revision < 1) issue("STUDIO_INVALID_REVISION");
  return db.transaction(() => {
    // Do both ownership and revision checks in the same write transaction.
    const current = getPersonalStudioApp(db, userId, appId);
    if (current.revision !== expectedRevision) issue("STUDIO_CONFLICT");
    const snapshot = db.prepare("SELECT specJson FROM personal_studio_app_versions WHERE userId=? AND appId=? AND revision=?")
      .get(userId, appId, revision) as { specJson: string } | undefined;
    if (!snapshot) issue("STUDIO_VERSION_NOT_FOUND");
    const spec = parsePersonalAppSpec(JSON.parse(snapshot.specJson));
    return updatePersonalStudioApp(db, userId, appId, expectedRevision, spec);
  })();
}
