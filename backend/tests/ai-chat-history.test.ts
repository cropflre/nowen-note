import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { getDb, closeDb } from "../src/db/schema";
import ai from "../src/routes/ai";

const app = new Hono().route("/ai", ai);
const headers = { "X-User-Id": "chat-history-owner", "Content-Type": "application/json" };

test.before(() => {
  getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(headers["X-User-Id"], "chat-history-owner", "test-hash");
});
test.after(() => closeDb());

test("same-second chat history retains insertion order, recent pagination and conversation preview after reopening", async () => {
  const created = await app.request("/ai/conversations", { method: "POST", headers, body: JSON.stringify({ title: "Existing history" }) });
  const { conversation } = await created.json();
  const ids = ["u-1", "a-1", "u-2", "a-2"];
  for (const [index, id] of ids.entries()) {
    const response = await app.request("/ai/chat-history", { method: "POST", headers, body: JSON.stringify({ id, conversationId: conversation.id, role: index % 2 ? "assistant" : "user", content: id }) });
    assert.equal(response.status, 200);
  }
  getDb().prepare("UPDATE ai_chat_messages SET createdAt = '2000-01-01 00:00:00' WHERE conversationId = ?").run(conversation.id);
  closeDb();
  const history = await (await app.request(`/ai/chat-history?conversationId=${conversation.id}`, { headers })).json();
  assert.deepEqual(history.messages.map((message: { id: string }) => message.id), ids);
  const recent = await (await app.request(`/ai/chat-history?conversationId=${conversation.id}&limit=3`, { headers })).json();
  assert.deepEqual(recent.messages.map((message: { id: string }) => message.id), ids.slice(1));
  const list = await (await app.request("/ai/conversations", { headers })).json();
  assert.equal(list.conversations[0].lastMessage, "a-2");
  assert.equal(list.conversations[0].lastRole, "assistant");
  // DCC-006: selecting another user's conversation still fails closed.
  assert.equal((await app.request(`/ai/chat-history?conversationId=${conversation.id}`, { headers: { "X-User-Id": "another-user" } })).status, 404);
});

test("history retention trims the earliest inserted same-second message", async () => {
  const created = await app.request("/ai/conversations", { method: "POST", headers, body: JSON.stringify({ title: "Retention" }) });
  const { conversation } = await created.json();
  const insert = getDb().prepare("INSERT INTO ai_chat_messages (id, userId, conversationId, role, content, createdAt) VALUES (?, ?, ?, 'user', ?, '2000-01-01 00:00:00')");
  for (let index = 0; index < 200; index++) {
    const id = `retention-${String(200 - index).padStart(3, "0")}`;
    insert.run(id, headers["X-User-Id"], conversation.id, id);
  }
  const response = await app.request("/ai/chat-history", { method: "POST", headers, body: JSON.stringify({ id: "retention-latest", conversationId: conversation.id, role: "assistant", content: "Latest reply" }) });
  assert.equal(response.status, 200);
  const history = await (await app.request(`/ai/chat-history?conversationId=${conversation.id}&limit=500`, { headers })).json();
  assert.equal(history.messages.length, 200);
  assert.equal(history.messages[0].id, "retention-199");
  assert.equal(history.messages.at(-1).id, "retention-latest");
  assert.equal(history.messages.some((message: { id: string }) => message.id === "retention-200"), false);
});
