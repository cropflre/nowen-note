import crypto from "node:crypto";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const response = (body = "success", status = 200, contentType = "text/plain") => ({ status, contentType, body });
const cdata = (value) => `<![CDATA[${String(value).replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

export function field(xml, name) {
  if (typeof xml !== "string" || xml.length > 131072 || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/^\s*<xml>[\s\S]*<\/xml>\s*$/.test(xml)) throw new Error("Invalid XML");
  const matches = [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))];
  if (matches.length > 1) throw new Error("Duplicate XML field");
  let text = matches[0]?.[1] || "";
  if (text.startsWith("<![CDATA[") && text.endsWith("]]>")) return text.slice(9, -3).replace(/]]><!\[CDATA\[/g, "");
  if (text.includes("<")) throw new Error("Invalid XML field");
  return text.replace(/&#(\d+);|&#x([a-fA-F0-9]+);|&(amp|lt|gt|quot|apos);/g, (_, decimal, hex, named) => decimal || hex ? String.fromCodePoint(parseInt(decimal || hex, decimal ? 10 : 16)) : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[named]));
}

export function unframe(value, appId) {
  const buffer = Buffer.from(value, "base64");
  const padding = buffer.at(-1);
  if (!padding || padding > 32 || buffer.length < 32 || !buffer.subarray(-padding).every((byte) => byte === padding)) throw new Error("Invalid padding");
  const packet = buffer.subarray(0, -padding);
  if (packet.length < 20) throw new Error("Invalid frame");
  const length = packet.readUInt32BE(16);
  if (!appId || length > 131072 || 20 + length >= packet.length || packet.subarray(20 + length).toString("utf8") !== appId) throw new Error("AppID mismatch");
  return packet.subarray(20, 20 + length).toString("utf8");
}

async function encrypt(nowen, text, appId) {
  const body = Buffer.from(text);
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  const packet = Buffer.concat([crypto.randomBytes(16), length, body, Buffer.from(appId)]);
  const padding = 32 - packet.length % 32;
  return nowen.secrets.crypt({ connection: "encoding-key", operation: "encrypt", data: Buffer.concat([packet, Buffer.alloc(padding, padding)]).toString("base64") });
}

async function reply(nowen, settings, message, text, encrypted) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = `<xml><ToUserName>${cdata(message.sender)}</ToUserName><FromUserName>${cdata(message.receiver)}</FromUserName><CreateTime>${timestamp}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content>${cdata(text)}</Content></xml>`;
  if (!encrypted) return response(body, 200, "text/xml");
  const value = await encrypt(nowen, body, settings["app-id"]);
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = await nowen.secrets.digest({ connection: "callback-token", algorithm: "sha1", parts: [timestamp, nonce, value], sort: true });
  return response(`<xml><Encrypt>${cdata(value)}</Encrypt><MsgSignature>${cdata(signature)}</MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce>${cdata(nonce)}</Nonce></xml>`, 200, "text/xml");
}

async function verifyMessage(input, nowen) {
  const settings = await nowen.settings.get();
  const query = input.query;
  if (!/^\d{10}$/.test(query.timestamp || "") || Math.abs(Date.now() / 1000 - Number(query.timestamp)) > 300 || typeof query.nonce !== "string" || query.nonce.length > 128) return response("Invalid signature", 401);
  let encrypted = input.method === "GET" ? query.encrypt_type === "aes" || Boolean(query.msg_signature) : Boolean(field(input.body, "Encrypt"));
  if (settings.mode === "encrypted" && !encrypted && input.method !== "GET") return response("Encryption required", 401);
  const ciphertext = encrypted ? (input.method === "GET" ? query.echostr : field(input.body, "Encrypt")) : null;
  const expected = await nowen.secrets.digest({ connection: "callback-token", algorithm: "sha1", parts: [query.timestamp, query.nonce, ...(ciphertext ? [ciphertext] : [])], sort: true });
  const actual = encrypted ? query.msg_signature : query.signature;
  if (!/^[a-f0-9]{40}$/i.test(actual || "") || !crypto.timingSafeEqual(Buffer.from(actual.toLowerCase()), Buffer.from(expected))) return response("Invalid signature", 401);
  const plaintext = encrypted ? unframe(await nowen.secrets.crypt({ connection: "encoding-key", operation: "decrypt", data: ciphertext }), settings["app-id"]) : input.body;
  if (input.method === "GET") return response(encrypted ? plaintext : String(query.echostr || "").slice(0, 1024));
  const message = { sender: field(plaintext, "FromUserName"), receiver: field(plaintext, "ToUserName"), type: field(plaintext, "MsgType"), id: field(plaintext, "MsgId") };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(message.sender)) return response("Invalid sender", 400);
  const text = message.type === "text" ? field(plaintext, "Content").trim() : message.type === "link" ? field(plaintext, "Url").trim() : "";
  return { ...response(), message: { ...message, text, event: message.type === "event" ? field(plaintext, "Event") : "", scene: message.type === "event" ? field(plaintext, "EventKey").replace(/^qrscene_/, "") : "", encrypted } };
}

const actions = {
  "verify-message": async ({ input, nowen }) => verifyMessage(input, nowen),
  "reply-message": async ({ input, nowen }) => reply(nowen, await nowen.settings.get(), input.message, input.text, input.encrypted),
  "capture-article": async ({ input, nowen }) => {
    const key = `assistant:${input.itemId}`;
    const prior = await nowen.storage.get({ key });
    if (prior) return prior;
    // Store a per-item receipt before reporting success to the queue.
    const note = await nowen.capture.importUrl({ url: input.url, notebookId: input.notebookId });
    await nowen.storage.set({ key, value: note });
    return note;
  },
  "bind-code": async ({ nowen }) => {
    const code = crypto.randomBytes(16).toString("hex");
    await nowen.storage.set({ key: "bind-code", value: { hash: hash(code), expires: Date.now() + 600000 } });
    return { text: `请在 10 分钟内向公众号发送：绑定 ${code}` };
  },
  unbind: async ({ nowen }) => {
    await nowen.storage.delete({ key: "bound-openid" });
    await nowen.storage.delete({ key: "bind-code" });
    return { success: true };
  },
  "handle-message": async ({ input, nowen }) => {
    const verified = await verifyMessage(input, nowen);
    if (!verified.message) return verified;
    const settings = await nowen.settings.get();
    const { encrypted, text, ...message } = verified.message;
    if (!text) return response();
    if (text.startsWith("绑定 ")) {
      const code = await nowen.storage.get({ key: "bind-code" });
      if (!code || code.expires < Date.now() || code.hash !== hash(text.slice(3).trim())) return reply(nowen, settings, message, "绑定码无效或已过期。", encrypted);
      await nowen.storage.set({ key: "bound-openid", value: message.sender });
      await nowen.storage.delete({ key: "bind-code" });
      return reply(nowen, settings, message, "绑定成功。发送文字或 HTTPS 文章链接即可保存。", encrypted);
    }
    if (await nowen.storage.get({ key: "bound-openid" }) !== message.sender) return reply(nowen, settings, message, "请先在 Nowen 插件中生成绑定码。", encrypted);
    if (!settings["notebook-id"]) return reply(nowen, settings, message, "请先配置目标笔记本。", encrypted);
    if (!/^\d{1,30}$/.test(message.id)) return response("Missing MsgId", 400);
    return { ...response(), enqueue: { key: message.id, input: { sender: message.sender, messageId: message.id, text } } };
  },
  "capture-message": async ({ input, nowen }) => {
    if (await nowen.storage.get({ key: "bound-openid" }) !== input.sender) throw new Error("Binding changed");
    const key = `message:${input.messageId}`;
    const prior = await nowen.storage.get({ key });
    if (prior) return prior;
    const settings = await nowen.settings.get();
    if (!settings["notebook-id"]) throw new Error("请配置目标笔记本");
    const tags = String(settings.tags || "").split(",").map((value) => value.trim()).filter(Boolean);
    let note;
    if (/^https:\/\/\S+$/i.test(input.text)) {
      note = await nowen.capture.importUrl({ url: input.text, notebookId: settings["notebook-id"], tags });
    } else {
      note = await nowen.notes.create({ notebookId: settings["notebook-id"], title: input.text.slice(0, 60), content: input.text, contentFormat: "markdown" });
      // Save the receipt before optional tagging so retry cannot duplicate the note.
      await nowen.storage.set({ key, value: note });
      const notebook = await nowen.notebooks.get({ notebookId: settings["notebook-id"] });
      const existing = await nowen.tags.list();
      for (const name of new Set(tags)) {
        const tag = existing.find((item) => item.name === name && item.workspaceId === notebook.workspaceId) || await nowen.tags.create({ name, workspaceId: notebook.workspaceId });
        await nowen.tags.addToNote({ noteId: note.id, tagId: tag.id });
      }
    }
    await nowen.storage.set({ key, value: note });
    return note;
  },
};

export default { actions };
