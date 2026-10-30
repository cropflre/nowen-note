// Optional local PostgreSQL/WASM storage acceptance; never connects to a real user DB.
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const { PGlite } = await import(
  process.argv[2] ? pathToFileURL(process.argv[2]).href : "@electric-sql/pglite"
);
const db = new PGlite();
try {
  await db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE workspaces(id TEXT PRIMARY KEY);
    CREATE TABLE attachments(id TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "workspaceId" TEXT);
    INSERT INTO users VALUES ('one'),('two'); INSERT INTO workspaces VALUES ('team');
    INSERT INTO attachments VALUES ('file','one',NULL),('foreign','two',NULL),('work','one','team');`);
  const sql = fs.readFileSync(
    new URL(
      "../src/db/postgres/migrations/0127-asset-organization.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await db.exec(sql);
  await db.exec(sql);
  await db.query(
    `INSERT INTO asset_tags (id,"userId",name,"normalizedName") VALUES ($1,$2,$3,$4)`,
    ["tag", "one", "Design", "design"],
  );
  await assert.rejects(
    db.query(
      `INSERT INTO asset_tags (id,"userId",name,"normalizedName") VALUES ('duplicate','one','DESIGN','design')`,
    ),
    /unique/i,
  );
  await db.exec(`INSERT INTO asset_tags (id,"userId",name,"normalizedName") VALUES ('other','two','Design','design');
    INSERT INTO asset_tag_relations ("attachmentId","tagId") VALUES ('file','tag');`);
  await assert.rejects(
    db.exec(
      `INSERT INTO asset_tag_relations ("attachmentId","tagId") VALUES ('foreign','tag')`,
    ),
    /SCOPE/,
  );
  await db.query(
    `INSERT INTO asset_smart_folders (id,"userId",name,"normalizedName",filters) VALUES ($1,$2,$3,$4,$5)`,
    [
      "saved",
      "one",
      "Images",
      "images",
      JSON.stringify({ category: "image", minSize: 10 }),
    ],
  );
  assert.deepEqual(
    JSON.parse(
      (
        await db.query(
          `SELECT filters FROM asset_smart_folders WHERE id='saved'`,
        )
      ).rows[0].filters,
    ),
    { category: "image", minSize: 10 },
  );
  await db.exec(`UPDATE attachments SET "workspaceId"='team' WHERE id='file'`);
  assert.equal(
    (await db.query("SELECT * FROM asset_tag_relations")).rows.length,
    0,
  );
  await db.exec(`DELETE FROM asset_tags WHERE id='tag'`);
  assert.equal(
    (await db.query(`SELECT * FROM attachments WHERE id='file'`)).rows.length,
    1,
  );
  console.log(
    "PASS: PostgreSQL/WASM migration idempotency, scoped uniqueness, relation guard, scope transfer, saved filters, and non-destructive tag deletion.",
  );
} finally {
  await db.close();
}
