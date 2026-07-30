#!/usr/bin/env python3
from __future__ import annotations

import re
from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"missing Yjs slice marker: {label}")
    target.write_text(text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE | re.DOTALL)
    if count != 1:
        raise SystemExit(f"missing Yjs slice regex: {label}")
    target.write_text(updated)


REALTIME = "backend/src/services/postgres-realtime-runtime.ts"
TEST = "backend/tests/postgres-realtime-yjs-pg.test.ts"

replace_once(
    REALTIME,
    "    yjsLoadingRooms: number;\n    yjsSeededRooms: number;",
    "    yjsLoadingRooms: number;\n    yjsWritingRooms: number;\n    yjsSeededRooms: number;",
    "realtime stats interface",
)
replace_once(
    REALTIME,
    '      send(client.ws, { type: "error", noteId: noteId || null, code: error.code, error: error.message });',
    '''      send(client.ws, {
        type: "error",
        noteId: noteId || null,
        code: error.code,
        error: error.message,
        details: error.details,
      });''',
    "runtime error details",
)
replace_once(
    REALTIME,
    "  function roomError(client: RuntimeClient, room: string, code: string, error: string): void {",
    '''  async function canWriteNote(
    noteId: string,
    info: Pick<ClientInfo, "userId" | "role">,
  ): Promise<boolean> {
    if (info.role === "admin") return true;
    const resolved = await noteCore.resolveNotePermissionAsync(noteId, info.userId);
    return resolved.permission === "write" || resolved.permission === "manage";
  }

  function roomError(client: RuntimeClient, room: string, code: string, error: string): void {''',
    "write permission helper",
)
regex_once(
    REALTIME,
    r'''(      if \(!\(await canJoinNoteRoom\(noteId, client\.info\)\)\) \{
        send\(client\.ws, \{ type: "error", noteId, code: "FORBIDDEN", error: "Forbidden" \}\);
        return true;
      \}
)(      try \{
        const result = await yjs\.join\(noteId, connectionId\);)''',
    r'''\1      const writable = await canWriteNote(noteId, client.info);
\2''',
    "join write permission",
)
replace_once(
    REALTIME,
    "          warnings: result.warnings,\n          readOnly: true,",
    "          warnings: result.warnings,\n          readOnly: !writable,",
    "join readOnly capability",
)
replace_once(
    REALTIME,
    '''        const update = yjs.syncStep1(noteId, connectionId, message.stateVector);
        send(client.ws, { type: "y:sync-step2", noteId, update, readOnly: true });''',
    '''        const update = yjs.syncStep1(noteId, connectionId, message.stateVector);
        const writable = await canWriteNote(noteId, client.info);
        send(client.ws, { type: "y:sync-step2", noteId, update, readOnly: !writable });''',
    "sync-step2 readOnly capability",
)
replace_once(
    REALTIME,
    '''    if (message.type === "y:update") {
      if (!noteId) return true;
      if (!yjs.hasJoined(noteId, connectionId)) {
        send(client.ws, { type: "error", noteId, code: "YJS_NOT_JOINED", error: "Yjs room has not been joined" });
        return true;
      }
      send(client.ws, {
        type: "error",
        noteId,
        code: "POSTGRES_YJS_WRITE_PENDING",
        error: "PostgreSQL Yjs update persistence is not migrated yet",
      });
      return true;
    }''',
    '''    if (message.type === "y:update") {
      if (!noteId) return true;
      if (!message.update) {
        send(client.ws, { type: "error", noteId, code: "YJS_UPDATE_REQUIRED", error: "Missing update" });
        return true;
      }
      if (!yjs.hasJoined(noteId, connectionId)) {
        send(client.ws, { type: "error", noteId, code: "YJS_NOT_JOINED", error: "Yjs room has not been joined" });
        return true;
      }
      if (!(await canWriteNote(noteId, client.info))) {
        send(client.ws, { type: "error", noteId, code: "FORBIDDEN", error: "Write permission required" });
        return true;
      }
      try {
        const persisted = await yjs.applyUpdate(
          noteId,
          connectionId,
          client.info.userId,
          message.update,
        );
        broadcastYRoom(noteId, {
          type: "y:update",
          noteId,
          update: persisted.updateBase64,
          version: persisted.version,
          updatedAt: persisted.updatedAt,
          actorConnectionId: connectionId,
          actorUserId: client.info.userId,
        }, connectionId);
        send(client.ws, {
          type: "y:update-ack",
          noteId,
          version: persisted.version,
          updatedAt: persisted.updatedAt,
        });
        await publishMutation({
          kind: "note.updated",
          actorUserId: client.info.userId,
          actorConnectionId: connectionId,
          note: {
            id: noteId,
            workspaceId: persisted.workspaceId,
            notebookId: persisted.notebookId,
            version: persisted.version,
            updatedAt: persisted.updatedAt,
            title: persisted.title,
            contentText: persisted.contentText,
          },
        });
      } catch (error) {
        if (error instanceof PostgresYjsReadRuntimeError && error.code === "YJS_WRITE_CONFLICT") {
          for (const current of clients.values()) current.info.yRooms.delete(noteId);
        }
        sendRuntimeError(client, error, noteId);
      }
      return true;
    }''',
    "transactional y:update handler",
)
regex_once(
    REALTIME,
    r'''(?P<indent>\s*)"yjs-read-sync",
(?P=indent)"yjs-awareness-relay",
(?P<close>\s*)\],
(?P<pending>\s*)pendingCapabilities: \["yjs-update-write", "yjs-snapshot-compaction"\],''',
    '''            "yjs-read-sync",
            "yjs-awareness-relay",
            "yjs-update-write",
          ],
          pendingCapabilities: ["yjs-snapshot-compaction"],''',
    "runtime capabilities",
)
replace_once(
    REALTIME,
    "[postgres-realtime-runtime] room, presence and Yjs read-sync hub attached at /ws",
    "[postgres-realtime-runtime] room, presence and Yjs read/write hub attached at /ws",
    "runtime log",
)
replace_once(
    REALTIME,
    "      yjsLoadingRooms: yjsStats.loadingRooms,\n      yjsSeededRooms: yjsStats.seededRooms,",
    "      yjsLoadingRooms: yjsStats.loadingRooms,\n      yjsWritingRooms: yjsStats.writingRooms,\n      yjsSeededRooms: yjsStats.seededRooms,",
    "runtime stats result",
)

replace_once(
    TEST,
    'const MEMBER = "pg-yws-member";\nconst OUTSIDER = "pg-yws-outsider";',
    'const MEMBER = "pg-yws-member";\nconst VIEWER = "pg-yws-viewer";\nconst OUTSIDER = "pg-yws-outsider";',
    "viewer fixture constant",
)
replace_once(
    TEST,
    '''  assert.ok(connected.capabilities.includes("yjs-awareness-relay"));
  assert.deepEqual(connected.pendingCapabilities, ["yjs-update-write", "yjs-snapshot-compaction"]);''',
    '''  assert.ok(connected.capabilities.includes("yjs-awareness-relay"));
  assert.ok(connected.capabilities.includes("yjs-update-write"));
  assert.deepEqual(connected.pendingCapabilities, ["yjs-snapshot-compaction"]);''',
    "capability assertions",
)
replace_once(
    TEST,
    '''  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, MEMBER, OUTSIDER]]);
  for (const userId of [OWNER, MEMBER, OUTSIDER]) {''',
    '''  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, MEMBER, VIEWER, OUTSIDER]]);
  for (const userId of [OWNER, MEMBER, VIEWER, OUTSIDER]) {''',
    "viewer fixture user",
)
replace_once(
    TEST,
    '''  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES ($1, $2, 'editor')`,
    [WORKSPACE, MEMBER],
  );''',
    '''  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES ($1, $2, 'editor')`,
    [WORKSPACE, MEMBER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES ($1, $2, 'viewer')`,
    [WORKSPACE, VIEWER],
  );''',
    "viewer workspace membership",
)
replace_once(
    TEST,
    'test("PostgreSQL websocket Yjs boundary supports join/sync-step1/awareness and rejects writes", { skip: !hasPg }, async () => {',
    'test("PostgreSQL websocket Yjs boundary persists authorized updates and rejects invalid or read-only writes", { skip: !hasPg }, async () => {',
    "test title",
)
replace_once(
    TEST,
    '''    const member = await connectClient(port, MEMBER);
    const outsider = await connectClient(port, OUTSIDER);
    sockets.push(owner.ws, member.ws, outsider.ws);''',
    '''    const member = await connectClient(port, MEMBER);
    const viewer = await connectClient(port, VIEWER);
    const outsider = await connectClient(port, OUTSIDER);
    sockets.push(owner.ws, member.ws, viewer.ws, outsider.ws);''',
    "viewer websocket",
)
replace_once(
    TEST,
    '''    send(member, { type: "y:join", noteId: NOTE });
    send(outsider, { type: "y:join", noteId: NOTE });

    const ownerSync = await waitForMessage(owner.messages, "y:sync", (message) => message.noteId === NOTE);
    const memberSync = await waitForMessage(member.messages, "y:sync", (message) => message.noteId === NOTE);
    assert.equal(ownerSync.readOnly, true);
    assert.equal(memberSync.replayedUpdates, 1);''',
    '''    send(member, { type: "y:join", noteId: NOTE });
    send(viewer, { type: "y:join", noteId: NOTE });
    send(outsider, { type: "y:join", noteId: NOTE });

    const ownerSync = await waitForMessage(owner.messages, "y:sync", (message) => message.noteId === NOTE);
    const memberSync = await waitForMessage(member.messages, "y:sync", (message) => message.noteId === NOTE);
    const viewerSync = await waitForMessage(viewer.messages, "y:sync", (message) => message.noteId === NOTE);
    assert.equal(ownerSync.readOnly, false);
    assert.equal(memberSync.readOnly, false);
    assert.equal(viewerSync.readOnly, true);
    assert.equal(memberSync.replayedUpdates, 1);''',
    "join readOnly assertions",
)
replace_once(
    TEST,
    '''    assert.equal(realtime.getStats().yjsRooms, 1);
    assert.equal(realtime.getStats().yjsConnections, 2);''',
    '''    assert.equal(realtime.getStats().yjsRooms, 1);
    assert.equal(realtime.getStats().yjsConnections, 3);''',
    "joined connection count",
)
regex_once(
    TEST,
    r'''    const beforeWrites = Number\(\(await pool\.query\(
      `SELECT COUNT\(\*\)::int AS count FROM note_yupdates WHERE "noteId" = \$1`,
      \[NOTE\],
    \)\)\.rows\[0\]\.count\);
    send\(member, \{
      type: "y:update",
      noteId: NOTE,
      update: Buffer\.from\(\[1, 2, 3\]\)\.toString\("base64"\),
    \}\);
    await waitForMessage\(member\.messages, "error", \(message\) => \(
      message\.noteId === NOTE && message\.code === "POSTGRES_YJS_WRITE_PENDING"
    \)\);
    const afterWrites = Number\(\(await pool\.query\(
      `SELECT COUNT\(\*\)::int AS count FROM note_yupdates WHERE "noteId" = \$1`,
      \[NOTE\],
    \)\)\.rows\[0\]\.count\);
    assert\.equal\(afterWrites, beforeWrites\);''',
    '''    const beforeWrites = Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_yupdates WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count);
    const editingDoc = decodeYDoc(ownerSync.state);
    const beforeVector = Y.encodeStateVector(editingDoc);
    editingDoc.getText("content").insert(editingDoc.getText("content").length, " + persisted");
    const validUpdate = Buffer.from(Y.encodeStateAsUpdate(editingDoc, beforeVector)).toString("base64");
    editingDoc.destroy();

    send(member, { type: "y:update", noteId: NOTE, update: validUpdate });
    const ack = await waitForMessage(member.messages, "y:update-ack", (message) => message.noteId === NOTE);
    assert.equal(ack.version, 2);
    const ownerUpdate = await waitForMessage(owner.messages, "y:update", (message) => message.noteId === NOTE);
    const viewerUpdate = await waitForMessage(viewer.messages, "y:update", (message) => message.noteId === NOTE);
    assert.equal(ownerUpdate.update, validUpdate);
    assert.equal(viewerUpdate.version, 2);

    const afterWriteRows = await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_yupdates WHERE "noteId" = $1`,
      [NOTE],
    );
    assert.equal(Number(afterWriteRows.rows[0].count), beforeWrites + 1);
    const persistedNote = (await pool.query(
      `SELECT content, "contentText", version FROM notes WHERE id = $1`,
      [NOTE],
    )).rows[0];
    assert.equal(persistedNote.content, "server snapshot + delta + persisted");
    assert.equal(persistedNote.contentText, "server snapshot + delta + persisted");
    assert.equal(Number(persistedNote.version), 2);

    send(viewer, { type: "y:update", noteId: NOTE, update: validUpdate });
    await waitForMessage(viewer.messages, "error", (message) => (
      message.noteId === NOTE && message.code === "FORBIDDEN"
    ));
    send(member, {
      type: "y:update",
      noteId: NOTE,
      update: Buffer.from([1, 2, 3]).toString("base64"),
    });
    await waitForMessage(member.messages, "error", (message) => (
      message.noteId === NOTE && message.code === "YJS_INVALID_UPDATE"
    ));
    const finalWrites = Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_yupdates WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count);
    assert.equal(finalWrites, beforeWrites + 1);''',
    "persisted write assertions",
)
replace_once(
    TEST,
    "    await waitForCondition(() => realtime.getStats().yjsConnections === 1);",
    "    await waitForCondition(() => realtime.getStats().yjsConnections === 2);",
    "leave connection count",
)
replace_once(
    TEST,
    '''    member.ws.terminate();
    outsider.ws.terminate();''',
    '''    member.ws.terminate();
    viewer.ws.terminate();
    outsider.ws.terminate();''',
    "viewer disconnect",
)

print("[pg-yjs-write] realtime and regression patch applied")
