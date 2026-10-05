import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "computer.config.json"), "utf8"));
const workspace = path.resolve(root, config.workspace || "workspace");
const apps = Object.fromEntries(Object.entries(config.apps || {}).map(([k, v]) => [k.toLowerCase(), v]));
fs.mkdirSync(workspace, { recursive: true });

// Resolves a user/model-supplied path inside the workspace; throws if it escapes it.
function inWorkspace(p = ".") {
  const full = path.resolve(workspace, p);
  const rel = path.relative(workspace, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path is outside the workspace folder.");
  return full;
}

const fn = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

// Each tool: def (OpenAI schema), label (shown on screen), confirm(args) -> spoken summary or null, run(args).
export const nativeTools = [
  {
    def: fn("list_files", "List files and folders in the user's workspace folder.", {
      path: { type: "string", description: "Sub-folder, relative to the workspace. Default: the workspace root." },
    }),
    label: () => "Looking at files",
    confirm: () => null,
    async run({ path: p }) {
      const entries = fs.readdirSync(inWorkspace(p), { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)";
    },
  },
  {
    def: fn("read_file", "Read a text file from the workspace folder.", { path: { type: "string" } }, ["path"]),
    label: ({ path: p }) => `Reading ${p}`,
    confirm: () => null,
    async run({ path: p }) {
      const text = fs.readFileSync(inWorkspace(p), "utf8");
      return text.length > 8000 ? `${text.slice(0, 8000)}\n…(truncated)` : text;
    },
  },
  {
    def: fn(
      "write_file",
      "Create or change a text file in the workspace folder.",
      {
        path: { type: "string" },
        content: { type: "string" },
        append: { type: "boolean", description: "Add to the end instead of replacing the file." },
      },
      ["path", "content"],
    ),
    label: ({ path: p }) => `Writing ${p}`,
    confirm: ({ path: p, content = "", append }) => {
      const exists = fs.existsSync(inWorkspace(p));
      const verb = append ? "add to" : exists ? "overwrite" : "create";
      return `${verb} the file ${p} with ${String(content).length} characters`;
    },
    async run({ path: p, content, append }) {
      const full = inWorkspace(p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      (append ? fs.appendFileSync : fs.writeFileSync)(full, String(content));
      return `Saved ${p}.`;
    },
  },
  {
    def: fn(
      "open_app",
      `Open a desktop application. Only these apps are allowed: ${Object.keys(apps).join(", ")}.`,
      { name: { type: "string", enum: Object.keys(apps) } },
      ["name"],
    ),
    label: ({ name }) => `Opening ${name}`,
    confirm: ({ name }) => `open ${name}`,
    async run({ name }) {
      const cmd = apps[String(name).toLowerCase()];
      if (!cmd) return `Not allowed. Allowed apps: ${Object.keys(apps).join(", ")}.`;
      spawn("cmd", ["/c", "start", "", cmd], { detached: true, stdio: "ignore" }).unref();
      return `Opened ${name}.`;
    },
  },
  {
    def: fn(
      "open_url",
      "Open a web page (http or https) in the user's default browser.",
      { url: { type: "string" } },
      ["url"],
    ),
    label: () => "Opening a web page",
    confirm: ({ url }) => `open ${new URL(url).hostname} in your browser`,
    async run({ url }) {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https links are allowed.");
      spawn("rundll32", ["url.dll,FileProtocolHandler", u.href], { detached: true, stdio: "ignore" }).unref();
      return `Opened ${u.href}.`;
    },
  },
  {
    def: fn("take_screenshot", "Take a screenshot of the whole screen and save it in the workspace."),
    label: () => "Taking a screenshot",
    confirm: () => "take a screenshot of your screen",
    async run() {
      const dir = inWorkspace("screenshots");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      const script =
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;" +
        "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;" +
        "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;" +
        "$g=[System.Drawing.Graphics]::FromImage($bmp);" +
        "$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);" +
        "$bmp.Save($env:SHOT_PATH,[System.Drawing.Imaging.ImageFormat]::Png)";
      await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, SHOT_PATH: file } });
      return `Saved screenshot as screenshots/${path.basename(file)}.`;
    },
  },
];
