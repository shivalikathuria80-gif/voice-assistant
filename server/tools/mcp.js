import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "mcp.config.json");

// Replaces ${VAR} with process.env.VAR; returns null if any referenced variable is empty.
function expand(env = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const val = String(v).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
    if (!val) return null;
    out[k] = val;
  }
  return out;
}

const safeName = (s) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

// Connects to every server in mcp.config.json; returns tools in the same shape as native.js.
export async function loadMcpTools() {
  if (!fs.existsSync(configPath)) return [];
  let servers;
  try {
    servers = JSON.parse(fs.readFileSync(configPath, "utf8")).servers ?? {};
  } catch (err) {
    console.warn("mcp.config.json is invalid:", err.message);
    return [];
  }

  const tools = [];
  await Promise.all(
    Object.entries(servers).map(async ([server, cfg]) => {
      const env = expand(cfg.env);
      if (!env) return console.warn(`MCP "${server}" skipped: an env variable in its config is empty.`);
      try {
        const client = new Client({ name: "voice-assistant", version: "0.1.0" });
        await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env }));
        const { tools: listed } = await client.listTools();
        for (const t of listed) {
          const name = safeName(`${server}__${t.name}`).slice(0, 64);
          const readOnly = t.annotations?.readOnlyHint === true;
          tools.push({
            def: {
              type: "function",
              function: {
                name,
                description: (t.description || t.name).slice(0, 500),
                parameters: t.inputSchema ?? { type: "object", properties: {} },
              },
            },
            label: () => `Using ${server}`,
            // Anything not explicitly marked read-only needs the user's approval.
            confirm: readOnly
              ? () => null
              : (args) => `use ${t.name.replace(/_/g, " ")} on ${server} with ${JSON.stringify(args).slice(0, 120)}`,
            async run(args) {
              const res = await client.callTool({ name: t.name, arguments: args });
              const text = (res.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
              if (res.isError) throw new Error(text || "tool error");
              return text.length > 4000 ? `${text.slice(0, 4000)}\n…(truncated)` : text;
            },
          });
        }
        console.log(`MCP "${server}": ${listed.length} tools`);
      } catch (err) {
        console.warn(`MCP "${server}" failed to start: ${err.message}`);
      }
    }),
  );
  return tools;
}
