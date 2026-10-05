import { makeRegistry } from "./registry.js";

// Everything available when running on your own machine: computer control plus any MCP servers.
// Imported lazily so the hosted (serverless) build never touches the local filesystem or spawns processes.
export async function initLocalTools() {
  const { nativeTools } = await import("./native.js");
  const { loadMcpTools } = await import("./mcp.js");
  const registry = makeRegistry([...nativeTools, ...(await loadMcpTools())]);
  console.log(`Tools ready: ${registry.definitions.map((d) => d.function.name).join(", ")}`);
  return registry;
}
