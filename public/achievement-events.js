import { isCharacterSkin, isRetiredCharacterSkin } from "./skins.js";

const pending = new Map();
const PENDING_KEY = "waifu-agent-usage-achievement-pending-v1";
try {
  const saved = JSON.parse(globalThis.localStorage?.getItem(PENDING_KEY) || "[]");
  if (Array.isArray(saved)) {
    for (const operation of saved) {
      if (
        (operation?.kind === "share" && typeof operation.receipt === "string" && operation.receipt) ||
        (operation?.kind === "skin" && isCharacterSkin(operation.characterId))
      )
        pending.set(JSON.stringify(operation), operation);
    }
    if (saved.some((operation) => operation?.kind === "skin" && isRetiredCharacterSkin(operation.characterId))) {
      persistPending();
    }
  }
} catch {
  /* Restricted storage must not affect the completed product action. */
}

function persistPending() {
  try {
    globalThis.localStorage?.setItem(PENDING_KEY, JSON.stringify([...pending.values()]));
  } catch {
    /* The current page can still retry from memory. */
  }
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw Object.assign(new Error("Achievement operation could not be recorded"), {
      retryable: !response.status || response.status >= 500 || response.status === 429,
    });
  return response;
}

async function submit(operation) {
  const key = JSON.stringify(operation);
  pending.set(key, operation);
  persistPending();
  try {
    await post("/api/achievements/operations", operation);
    pending.delete(key);
    persistPending();
    return true;
  } catch (error) {
    if (error.retryable === false) {
      pending.delete(key);
      persistPending();
    }
    return false;
  }
}

export async function recordAchievementShare(receipt) {
  try {
    const captured = await receipt;
    if (typeof captured !== "string" || !captured) return false;
    return submit({ kind: "share", receipt: captured });
  } catch {
    return false;
  }
}

export function recordAchievementSkin(characterId) {
  if (!isCharacterSkin(characterId)) return Promise.resolve(false);
  return submit({ kind: "skin", characterId });
}

export function retryAchievementOperations() {
  return Promise.all([...pending.values()].map(submit));
}
