// Past chats in chrome.storage.
//
// The chat a panel shows is stored under its tab's id ("t12"): that is how the
// panel finds it again. The id means nothing once the chat is put aside (New
// chat, another chat opened in its place) or the browser restarts, because tab
// ids start over. Such a chat is "filed": moved to an id of its own ("c…"),
// from where the history can open it in any panel. Nothing is deleted on the
// way: the copy is written before the original is removed.

import { getSessionConversation, sessionConversationKey } from "./storage.js";

const META_PREFIX = "autobot_session_meta_";
const CONVERSATION_PREFIX = "autobot_conversation_";
const TITLE_CHARS = 60;
const PREVIEW_CHARS = 140;
const CHAT_ID = /^[a-z0-9_-]{1,80}$/i;
// Ids that name a tab ("t12") or a window ("w3") of the running browser.
const TAB_CHAT_ID = /^[tw]\d+$/;

export const isChatId = (id) => typeof id === "string" && CHAT_ID.test(id);
export const isTabChatId = (id) => typeof id === "string" && TAB_CHAT_ID.test(id);

export function newChatId(now = Date.now()) {
  return `c${now.toString(36)}${crypto.randomUUID().slice(0, 8)}`;
}

// The preview is one plain line: the marks of formatted text are left out.
export function plainPreview(text) {
  return String(text || "")
    .replace(/```[a-z0-9]*/gi, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}|>|[-*+])\s+/gm, "")
    .replace(/\*+(?=\S)|(?<=\S)\*+/g, "")
    .replace(/~~|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const isAsked = (message) =>
  message?.role === "user" && !message.auto && typeof message.content === "string" && message.content.trim() !== "";

// A chat is named after what the user asked first. A stored name that belongs
// to another conversation (an older version kept the name when the chat was
// cleared) is replaced by this chat's own first message.
function titleOf(meta, conversation) {
  const kept = String(meta?.title || "").trim();
  const first = conversation[0];
  if (kept && !(isAsked(first) && !first.content.trim().startsWith(kept))) return kept;
  const asked = conversation.find(isAsked);
  return asked ? asked.content.trim().slice(0, TITLE_CHARS) : kept;
}

const timeOf = (value) => (Number.isInteger(value) ? value : null);

// What the history list shows of a chat. It never carries what a task saved.
function entryOf(id, meta, conversation) {
  return {
    id,
    title: titleOf(meta, conversation) || "New chat",
    preview: plainPreview(meta?.preview).slice(0, PREVIEW_CHARS),
    createdAt: timeOf(meta?.createdAt),
    updatedAt: timeOf(meta?.updatedAt),
    tabId: Number.isInteger(meta?.tabId) ? meta.tabId : null,
    groupId: Number.isInteger(meta?.groupId) ? meta.groupId : null,
    groupTitle: meta?.groupTitle || "Akron",
  };
}

const metaOf = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

// Every stored chat that has messages, newest first. A panel that was only
// opened has no messages and is not a chat yet.
export async function listChats() {
  const all = await chrome.storage.local.get(null);
  const chats = [];
  for (const [key, conversation] of Object.entries(all)) {
    if (!key.startsWith(CONVERSATION_PREFIX)) continue;
    if (!Array.isArray(conversation) || !conversation.length) continue;
    const id = key.slice(CONVERSATION_PREFIX.length);
    if (!isChatId(id)) continue;
    chats.push(entryOf(id, metaOf(all[META_PREFIX + id]), conversation));
  }
  return chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// One stored chat with its messages, or null when it has none.
export async function readChat(id) {
  if (!isChatId(id)) return null;
  const metaKey = META_PREFIX + id;
  const [conversation, stored] = await Promise.all([getSessionConversation(id), chrome.storage.local.get(metaKey)]);
  if (!conversation.length) return null;
  const meta = metaOf(stored[metaKey]);
  return { id, conversation, meta: { ...meta, title: titleOf(meta, conversation) || null } };
}

export async function removeChat(id) {
  if (!isChatId(id)) return;
  await chrome.storage.local.remove([META_PREFIX + id, sessionConversationKey(id)]);
}

// Moves the given chats to ids of their own; one without messages is only
// removed. Returns { oldId: newId } for the chats that were kept.
async function fileStored(ids, all) {
  const writes = {};
  const removes = [];
  const filed = {};
  for (const id of ids) {
    const conversation = all[CONVERSATION_PREFIX + id];
    const meta = metaOf(all[META_PREFIX + id]);
    removes.push(META_PREFIX + id, CONVERSATION_PREFIX + id);
    if (!Array.isArray(conversation) || !conversation.length) continue;
    const newId = newChatId();
    writes[CONVERSATION_PREFIX + newId] = conversation;
    // A filed chat belongs to no tab and no group.
    writes[META_PREFIX + newId] = { ...meta, title: titleOf(meta, conversation) || null, tabId: null, groupId: null };
    filed[id] = newId;
  }
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);
  if (removes.length) await chrome.storage.local.remove(removes);
  return filed;
}

// Files one chat. Returns its new id, or null when it had no messages.
export async function fileChat(id) {
  if (!isChatId(id)) return null;
  const keys = [META_PREFIX + id, CONVERSATION_PREFIX + id];
  const filed = await fileStored([id], await chrome.storage.local.get(keys));
  return filed[id] || null;
}

// Files every chat stored under the id of a tab or window that is gone:
// `isOpen(id)` says which ids are still open. After a browser restart none is,
// because tab ids start over. Returns how many chats were kept.
export async function fileTabChats(isOpen = () => false) {
  const all = await chrome.storage.local.get(null);
  const ids = new Set();
  for (const key of Object.keys(all)) {
    const prefix = [META_PREFIX, CONVERSATION_PREFIX].find((start) => key.startsWith(start));
    if (!prefix) continue;
    const id = key.slice(prefix.length);
    if (isTabChatId(id) && !isOpen(id)) ids.add(id);
  }
  return Object.keys(await fileStored([...ids], all)).length;
}
