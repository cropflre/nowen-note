import crypto from "crypto";

export type WeChatFavoriteItemKind =
  | "text"
  | "image"
  | "emoji"
  | "video"
  | "voice"
  | "file"
  | "link"
  | "location"
  | "chatHistory"
  | "contact"
  | "other";

export interface NormalizedWeChatFavoriteItem {
  kind: WeChatFavoriteItemKind;
  title: string;
  description: string;
  url?: string;
  mediaRefs: string[];
  mimeHint?: string;
  size?: number;
  duration?: number;
  sourceName?: string;
  sourceTime?: string;
  location?: {
    latitude?: string;
    longitude?: string;
    name?: string;
    address?: string;
  };
}

export interface NormalizedWeChatFavorite {
  externalId: string;
  localId?: string;
  type: string;
  title: string;
  textBlocks: string[];
  items: NormalizedWeChatFavoriteItem[];
  tags: string[];
  source?: {
    name?: string;
    username?: string;
    conversation?: string;
  };
  createdAt?: string;
  updatedAt?: string;
  rawType?: number;
}

export interface WeChatDataAnalysisParseResult {
  adapter: "wechat-data-analysis-v1";
  favorites: NormalizedWeChatFavorite[];
  warnings: string[];
}

const FAVORITE_TYPE_LABELS: Record<number, string> = {
  1: "text",
  2: "image",
  3: "voice",
  4: "video",
  5: "link",
  6: "location",
  7: "music",
  8: "file",
  14: "chatHistory",
  16: "product",
  18: "note",
  20: "channels",
  37: "emoji",
};

const KIND_ALIASES: Record<string, WeChatFavoriteItemKind> = {
  text: "text",
  note: "text",
  image: "image",
  picture: "image",
  emoji: "emoji",
  sticker: "emoji",
  video: "video",
  voice: "voice",
  audio: "voice",
  file: "file",
  attachment: "file",
  link: "link",
  music: "link",
  product: "link",
  miniprogram: "link",
  mini_program: "link",
  channels: "link",
  finder: "link",
  location: "location",
  chathistory: "chatHistory",
  chat_history: "chatHistory",
  contact: "contact",
  card: "contact",
};

const MAX_TEXT = 200_000;
const MAX_TITLE = 240;
const MAX_TAGS = 100;
const MAX_ITEMS = 10_000;

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function cleanText(value: unknown, max = MAX_TEXT): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
      .replace(/\u0000/g, "")
      .replace(/\r\n?/g, "\n")
      .slice(0, max)
      .trim();
  }
  return "";
}

function firstText(row: Record<string, any>, keys: string[], max = MAX_TEXT): string {
  for (const key of keys) {
    const value = cleanText(row[key], max);
    if (value) return value;
  }
  return "";
}

function safeHttpUrl(value: unknown): string {
  const raw = cleanText(value, 4_000);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:"
      ? parsed.toString()
      : "";
  } catch {
    return "";
  }
}

function toEpoch(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.trunc(value) : Math.trunc(value * 1000);
  }
  const raw = cleanText(value, 100);
  if (!raw) return null;
  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    return raw.length <= 10 ? n * 1000 : n;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate(value: unknown): string | undefined {
  const epoch = toEpoch(value);
  if (!epoch) return undefined;
  const date = new Date(epoch);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toISOString();
}

function normalizeTags(value: unknown): string[] {
  const candidates: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，;；|]/)
      : [];
  const names = candidates
    .map((item) => {
      const obj = asObject(item);
      return cleanText(obj?.name ?? obj?.tagName ?? item, 30);
    })
    .filter(Boolean);
  return Array.from(new Set(names)).slice(0, MAX_TAGS);
}

function pushRef(target: string[], value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((item) => pushRef(target, item));
    return;
  }
  const raw = cleanText(value, 1_000);
  if (!raw || /^(?:https?:|data:|blob:)/i.test(raw)) return;
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized && !target.includes(normalized)) target.push(normalized);
}

function inferKind(row: Record<string, any>, favoriteType?: number): WeChatFavoriteItemKind {
  const raw = firstText(row, ["renderType", "kind", "typeLabel", "mediaType"], 80)
    .replace(/[\s-]/g, "")
    .toLowerCase();
  if (KIND_ALIASES[raw]) return KIND_ALIASES[raw];

  const numeric = Number(row.dataType ?? row.type ?? favoriteType ?? 0);
  if (favoriteType === 14 || favoriteType === 18) {
    const recordKinds: Record<number, WeChatFavoriteItemKind> = {
      1: "text", 2: "image", 3: "contact", 4: "voice", 5: "video",
      6: "link", 7: "location", 8: "file", 17: "chatHistory",
      19: "link", 22: "link", 23: "link", 29: "link", 36: "link", 37: "emoji",
    };
    if (recordKinds[numeric]) return recordKinds[numeric];
  }
  const directKinds: Record<number, WeChatFavoriteItemKind> = {
    1: "text", 2: "image", 3: "voice", 4: "video", 5: "link",
    6: "location", 7: "link", 8: "file", 14: "chatHistory",
    16: "link", 18: "text", 20: "link", 37: "emoji",
  };
  return directKinds[numeric] || "other";
}

function normalizeLocation(row: Record<string, any>): NormalizedWeChatFavoriteItem["location"] | undefined {
  const source = asObject(row.location) || asObject(row.locitem) || row;
  const latitude = firstText(source, ["latitude", "lat", "locationLat"], 80);
  const longitude = firstText(source, ["longitude", "lng", "locationLng"], 80);
  const name = firstText(source, ["poiname", "name", "label", "locationPoiname"], 500);
  const address = firstText(source, ["address", "label", "locationLabel"], 1_000);
  return latitude || longitude || name || address
    ? { latitude, longitude, name, address }
    : undefined;
}

function normalizeItem(value: unknown, favoriteType?: number): NormalizedWeChatFavoriteItem | null {
  const row = asObject(value);
  if (!row) return null;
  const kind = inferKind(row, favoriteType);
  const mediaRefs: string[] = [];
  [
    "mediaPath", "localPath", "filePath", "path", "relativePath", "src",
    "imagePath", "videoPath", "voicePath", "thumbPath", "attachmentPath",
    "fullMd5", "thumbMd5", "imageMd5", "emojiMd5", "videoMd5",
    "videoThumbMd5", "fileMd5", "dataId", "imageFileId", "videoFileId",
    "videoThumbFileId", "fileFileId", "emojiFileId",
  ].forEach((key) => pushRef(mediaRefs, row[key]));
  ["imageMd5Candidates", "imageFileIdCandidates", "mediaRefs", "paths"].forEach((key) => pushRef(mediaRefs, row[key]));

  const location = kind === "location" ? normalizeLocation(row) : undefined;
  const title = firstText(row, ["title", "datatitle", "fileName", "filename", "typeLabel"], MAX_TITLE);
  const description = firstText(row, ["description", "content", "datadesc", "summary", "text"], MAX_TEXT);
  const url = safeHttpUrl(row.url ?? row.mediaUrl ?? row.link ?? row.webUrl ?? row.imageUrl ?? row.videoUrl);
  const mimeHint = firstText(row, ["mimeType", "mime", "contentType", "dataFormat", "fileExt"], 120);
  const size = Number(row.fullSize ?? row.fileSize ?? row.size ?? 0);
  const duration = Number(row.duration ?? row.voiceLength ?? 0);

  if (!title && !description && !url && mediaRefs.length === 0 && !location) return null;
  return {
    kind,
    title,
    description,
    ...(url ? { url } : {}),
    mediaRefs,
    ...(mimeHint ? { mimeHint } : {}),
    ...(Number.isFinite(size) && size > 0 ? { size } : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
    sourceName: firstText(row, ["sourceName", "from", "senderDisplayName"], 300) || undefined,
    sourceTime: firstText(row, ["sourceTime", "createTimeText", "updateTimeText"], 100) || undefined,
    ...(location ? { location } : {}),
  };
}

function stableExternalId(row: Record<string, any>, normalizedSeed: unknown): string {
  const serverId = firstText(row, ["serverId", "favServerId", "favoriteServerId"], 200);
  if (serverId && serverId !== "0") return `server:${serverId}`;
  const localId = firstText(row, ["localId", "favLocalId", "favoriteLocalId", "id"], 200);
  if (localId && localId !== "0") return `local:${localId}`;
  return `hash:${crypto.createHash("sha256").update(JSON.stringify(normalizedSeed)).digest("hex")}`;
}

function fallbackTitle(type: string, date?: string): string {
  const day = date ? date.slice(0, 10) : "";
  const labels: Record<string, string> = {
    text: "微信收藏文本", image: "微信收藏图片", voice: "微信收藏语音",
    video: "微信收藏视频", link: "微信收藏链接", location: "微信收藏位置",
    music: "微信收藏音乐", file: "微信收藏文件", chatHistory: "微信收藏聊天记录",
    product: "微信收藏商品", note: "微信收藏笔记", channels: "微信收藏视频号",
    emoji: "微信收藏表情",
  };
  return `${labels[type] || "微信收藏"}${day ? ` ${day}` : ""}`;
}

function normalizeFavoriteRow(row: Record<string, any>): NormalizedWeChatFavorite {
  const rawType = Number(row.type ?? row.favoriteType ?? row.favType ?? 0) || 0;
  const type = FAVORITE_TYPE_LABELS[rawType]
    || firstText(row, ["typeLabel", "kind", "renderType"], 80)
    || "other";
  const createdAt = normalizeDate(row.createTime ?? row.createdAt ?? row.updateTime ?? row.updateTimeText);
  const updatedAt = normalizeDate(row.updateTime ?? row.updatedAt ?? row.createTime ?? row.updateTimeText);

  const textBlocks = (Array.isArray(row.textBlocks) ? row.textBlocks : [])
    .map((value) => cleanText(value))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
  const directText = firstText(row, ["text", "content", "description"], MAX_TEXT);
  if (directText && !textBlocks.includes(directText)) textBlocks.push(directText);

  const rawItems = [
    ...(Array.isArray(row.attachments) ? row.attachments : []),
    ...(Array.isArray(row.items) ? row.items : []),
    ...(Array.isArray(row.dataItems) ? row.dataItems : []),
  ].slice(0, MAX_ITEMS);
  const items = rawItems
    .map((value) => normalizeItem(value, rawType))
    .filter((value): value is NormalizedWeChatFavoriteItem => Boolean(value));

  const title = firstText(row, ["title", "favTitle", "name", "summary"], MAX_TITLE)
    || items.find((item) => item.title)?.title
    || textBlocks.find(Boolean)?.slice(0, 80)
    || fallbackTitle(type, createdAt);
  const seed = { rawType, title, textBlocks, items, createdAt };
  const externalId = stableExternalId(row, seed);
  const localId = firstText(row, ["localId", "favLocalId", "id"], 200) || undefined;

  return {
    externalId,
    ...(localId ? { localId } : {}),
    type,
    title,
    textBlocks,
    items,
    tags: normalizeTags(row.tags ?? row.tagList ?? row.labels),
    source: {
      name: firstText(row, ["sourceName", "senderDisplayName", "from"], 300) || undefined,
      username: firstText(row, ["sourceUsername", "senderUsername", "fromUser"], 300) || undefined,
      conversation: firstText(row, ["conversationName", "conversationUsername", "sourceChatName"], 300) || undefined,
    },
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(rawType ? { rawType } : {}),
  };
}

function messageGroupKey(row: Record<string, any>, index: number): string {
  const localId = firstText(row, ["localId"], 200);
  const id = firstText(row, ["id"], 500);
  const idMatch = id.match(/^favorite_([^_]+)_([^_]+)_/i);
  if (localId && localId !== "0") return `local:${localId}`;
  if (idMatch?.[1] && idMatch[1] !== "0") return `local:${idMatch[1]}`;
  const serverId = firstText(row, ["serverId"], 200);
  if (serverId && serverId !== "0") return `server:${serverId}`;
  if (idMatch?.[2] && idMatch[2] !== "0") return `server:${idMatch[2]}`;
  return `row:${index}`;
}

function favoritesFromMessages(messages: unknown[]): NormalizedWeChatFavorite[] {
  const groups = new Map<string, Record<string, any>>();
  messages.slice(0, 100_000).forEach((value, index) => {
    const message = asObject(value);
    if (!message) return;
    const key = messageGroupKey(message, index);
    let group = groups.get(key);
    if (!group) {
      group = {
        localId: message.localId,
        serverId: message.serverId,
        type: message.type,
        title: message.title,
        updateTime: message.createTime,
        updateTimeText: message.createTimeText,
        sourceName: message.senderDisplayName || message.from,
        sourceUsername: message.senderUsername,
        conversationUsername: message._mediaUsername,
        textBlocks: [],
        attachments: [],
      };
      groups.set(key, group);
    }
    const kind = inferKind(message, Number(message.type || 0));
    const content = firstText(message, ["content", "description", "text"], MAX_TEXT);
    if (kind === "text" && content) {
      group.textBlocks.push(content);
    } else {
      group.attachments.push({ ...message, renderType: kind });
    }
    if (!group.title && message.title) group.title = message.title;
  });
  return Array.from(groups.values()).map(normalizeFavoriteRow);
}

function arraysFromEnvelope(payload: unknown): { favorites?: unknown[]; messages?: unknown[]; recognized: boolean } {
  if (Array.isArray(payload)) {
    const looksLikeMessages = payload.some((value) => {
      const row = asObject(value);
      return Boolean(row?.renderType || String(row?.id || "").startsWith("favorite_"));
    });
    return looksLikeMessages
      ? { messages: payload, recognized: true }
      : { favorites: payload, recognized: true };
  }
  const row = asObject(payload);
  if (!row) return { recognized: false };
  if (String(row.dataset || "").toLowerCase() === "favorites" && Array.isArray(row.items)) {
    return { favorites: row.items, recognized: true };
  }
  for (const key of ["favorites", "items", "data", "records"]) {
    if (Array.isArray(row[key])) return { favorites: row[key], recognized: true };
  }
  if (Array.isArray(row.messages)) return { messages: row.messages, recognized: true };
  if (Array.isArray(row.conversations)) {
    const messages = row.conversations.flatMap((value: unknown) => {
      const conversation = asObject(value);
      return Array.isArray(conversation?.messages) ? conversation.messages : [];
    });
    if (messages.length) return { messages, recognized: true };
  }
  const nested = asObject(row.data);
  if (nested) return arraysFromEnvelope(nested);
  return { recognized: false };
}

export function parseWeChatDataAnalysisPayload(payload: unknown): WeChatDataAnalysisParseResult | null {
  const arrays = arraysFromEnvelope(payload);
  if (!arrays.recognized) return null;
  const favorites = arrays.messages
    ? favoritesFromMessages(arrays.messages)
    : (arrays.favorites || [])
      .map((value) => asObject(value))
      .filter((value): value is Record<string, any> => Boolean(value))
      .slice(0, 100_000)
      .map(normalizeFavoriteRow);
  if (favorites.length === 0) return null;
  const unique = new Map<string, NormalizedWeChatFavorite>();
  favorites.forEach((favorite) => {
    const existing = unique.get(favorite.externalId);
    if (!existing) {
      unique.set(favorite.externalId, favorite);
      return;
    }
    existing.textBlocks = Array.from(new Set([...existing.textBlocks, ...favorite.textBlocks]));
    existing.items.push(...favorite.items);
    existing.tags = Array.from(new Set([...existing.tags, ...favorite.tags]));
  });
  return {
    adapter: "wechat-data-analysis-v1",
    favorites: Array.from(unique.values()),
    warnings: [],
  };
}

export function jsonDepth(value: unknown, limit = 64): number {
  const visit = (node: unknown, depth: number): number => {
    if (depth > limit) return depth;
    if (Array.isArray(node)) {
      return node.reduce((max, child) => Math.max(max, visit(child, depth + 1)), depth);
    }
    const row = asObject(node);
    if (row) {
      return Object.values(row).reduce((max, child) => Math.max(max, visit(child, depth + 1)), depth);
    }
    return depth;
  };
  return visit(value, 1);
}
