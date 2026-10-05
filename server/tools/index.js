import { nativeTools } from "./native.js";
import { loadMcpTools } from "./mcp.js";

const byName = new Map();
let definitions = [];

export async function initTools() {
  const all = [...nativeTools, ...(await loadMcpTools())];
  for (const t of all) byName.set(t.def.function.name, t);
  definitions = all.map((t) => t.def);
  console.log(`Tools ready: ${definitions.map((d) => d.function.name).join(", ")}`);
}

export const getDefinitions = () => definitions;

// Describes what a call will do and whether the user must approve it first. null = unknown tool.
export function policy(name, args) {
  const t = byName.get(name);
  if (!t) return null;
  try {
    return { label: t.label(args), summary: t.confirm(args) };
  } catch (err) {
    return { label: "Using a tool", summary: null, error: err.message };
  }
}

export async function callTool(name, args) {
  return byName.get(name).run(args ?? {});
}
