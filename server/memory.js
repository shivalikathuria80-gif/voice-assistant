import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatJSON } from "./providers.js";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const file = path.join(dataDir, "memory.json");
const MAX_FACTS = 40;
const MAX_HISTORY = 30;
const TABLE = "assistant_memory";
const ROW_ID = "default";

let store = { facts: [], history: [] };

// Storage backend: Supabase when SUPABASE_URL + SUPABASE_SERVICE_KEY are set (hosted), otherwise a local JSON file.
const supabase = () => process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY;
const sbFetch = (query, init = {}) =>
  fetch(`${process.env.SUPABASE_URL}/rest/v1/${TABLE}${query}`, {
    ...init,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

// Refreshes the in-memory copy from storage. Call at the start of every turn (serverless instances share nothing).
export async function loadMemory() {
  try {
    if (supabase()) {
      const res = await sbFetch(`?id=eq.${ROW_ID}&select=facts,history`);
      if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
      const [row] = await res.json();
      store = { facts: row?.facts ?? [], history: row?.history ?? [] };
    } else {
      store = { facts: [], history: [], ...JSON.parse(fs.readFileSync(file, "utf8")) };
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("memory load failed:", err.message);
  }
}

async function persist() {
  if (supabase()) {
    const res = await sbFetch("?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: ROW_ID, facts: store.facts, history: store.history, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    return;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(store, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

export const getFacts = () => [...store.facts];
export const getHistory = () => [...store.history];

export async function saveHistory(history) {
  store.history = history.slice(-MAX_HISTORY);
  await persist();
}

export async function forgetAll() {
  store = { facts: [], history: [] };
  await persist();
}

export const isForgetCommand = (text) =>
  /\b(forget (everything|all|what you know)|clear (your |my )?memory|wipe (your |my )?memory|reset (your |my )?memory)\b/i.test(text);

export function memoryPrompt() {
  if (!store.facts.length) return "";
  return `\n\nThings you remember about the user (use naturally, never recite the list):\n${store.facts.map((f) => `- ${f}`).join("\n")}`;
}

// Runs after a turn; returns the updated facts when something changed.
export async function learnFrom(userText, assistantText) {
  const result = await chatJSON([
    {
      role: "system",
      content:
        "You maintain long-term memory for a voice assistant. From the latest exchange, extract durable facts about the user worth remembering across conversations (name, preferences, people, projects, routines, goals), and corrections to existing facts. " +
        "Ignore small talk, questions, and anything temporary. Write each fact as a short third-person sentence like \"Name is Sam\". " +
        'Reply with JSON only: {"add": [string], "remove": [string]}. "remove" must contain exact text of existing facts that are now wrong or outdated. Use empty arrays if nothing applies.',
    },
    {
      role: "user",
      content: `Existing facts:\n${store.facts.map((f) => `- ${f}`).join("\n") || "(none)"}\n\nUser said: ${userText}\nAssistant replied: ${assistantText}`,
    },
  ]);

  const norm = (s) => s.trim().toLowerCase();
  const remove = new Set((result.remove || []).filter((s) => typeof s === "string").map(norm));
  const before = store.facts.length;
  let facts = store.facts.filter((f) => !remove.has(norm(f)));
  const have = new Set(facts.map(norm));
  for (const f of result.add || []) {
    if (typeof f !== "string" || !f.trim() || have.has(norm(f))) continue;
    facts.push(f.trim().slice(0, 200));
    have.add(norm(f));
  }
  facts = facts.slice(-MAX_FACTS);
  if (facts.length === before && facts.every((f, i) => f === store.facts[i])) return null;
  store.facts = facts;
  await persist();
  return getFacts();
}
