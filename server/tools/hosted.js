import { makeRegistry } from "./registry.js";

// Tools that are safe to expose over plain HTTP (no approval channel, no access to a local machine).
const webSearch = {
  def: {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information (news, facts, weather, prices, anything recent).",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A short search query." } },
        required: ["query"],
      },
    },
  },
  label: () => "Searching the web",
  confirm: () => null,
  async run({ query }) {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: String(query).slice(0, 300), max_results: 4, include_answer: true }),
    });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const data = await res.json();
    const lines = [];
    if (data.answer) lines.push(`Summary: ${data.answer}`);
    for (const r of data.results ?? []) lines.push(`- ${r.title}: ${String(r.content).slice(0, 300)}`);
    const text = lines.join("\n") || "No results.";
    return text.length > 3000 ? `${text.slice(0, 3000)}\n…(truncated)` : text;
  },
};

export function hostedRegistry() {
  return makeRegistry(process.env.TAVILY_API_KEY ? [webSearch] : []);
}
