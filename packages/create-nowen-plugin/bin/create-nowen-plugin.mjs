#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";

const cliArgs = process.argv.slice(2);
const valueOf = (flag) => {
  const index = cliArgs.indexOf(flag);
  return index >= 0 ? cliArgs[index + 1] : "";
};
const directoryArg = cliArgs.find((value, index) => !value.startsWith("--") && (index === 0 || !cliArgs[index - 1].startsWith("--"))) || "";
const rl = readline.createInterface({ input: stdin, output: stdout });
const name = valueOf("--name") || (await rl.question("Plugin Name (Hello Nowen): ")).trim() || "Hello Nowen";
const suggestedId = `com.example.${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
const id = valueOf("--id") || (await rl.question(`Plugin ID (${suggestedId}): `)).trim() || suggestedId;
const description = valueOf("--description") || (await rl.question("Description: ")).trim() || "A Nowen community plugin";
const author = valueOf("--author") || (await rl.question("Author: ")).trim() || "community";
const publisher = valueOf("--publisher") || id.split(".")[0];
const repository = valueOf("--repository") || `https://github.com/${publisher}/${id.split(".").pop()}`;
const template = valueOf("--template") || (await rl.question("Plugin Type (hello/content/ai/importer/exporter/connector/automation): ")).trim() || "hello";
rl.close();

const templates = {
  hello: { action: "hello", actionName: "Hello Nowen", permissions: [], input: { name: { type: "string", required: false } }, body: 'return { text: `Hello ${input.name ?? "Nowen"}!` };' },
  content: { action: "process-content", actionName: "Process Content", permissions: ["notes:read", "notes:write"], input: { noteId: { type: "string", required: true } }, body: 'const note = await nowen.notes.get({ noteId: String(input.noteId) }); return { data: note };' },
  ai: { action: "ai-action", actionName: "AI Action", permissions: ["external:fetch", "secrets:use"], input: { prompt: { type: "string", required: true } }, body: 'return { text: String(input.prompt) };' },
  importer: { action: "import-content", actionName: "Import Content", permissions: ["notes:write", "notebooks:read"], input: { content: { type: "string", required: true } }, body: 'return { data: { accepted: String(input.content).length } };' },
  exporter: { action: "export-content", actionName: "Export Content", permissions: ["notes:read"], input: { noteId: { type: "string", required: true } }, body: 'return { data: await nowen.notes.get({ noteId: String(input.noteId) }) };' },
  connector: { action: "connect", actionName: "Connector", permissions: ["external:fetch", "secrets:use"], input: { url: { type: "string", required: true } }, body: 'return { data: await nowen.external.fetch({ url: String(input.url), connection: "service" }) };' },
  automation: { action: "automate", actionName: "Automation", permissions: ["tasks:read", "tasks:write"], input: { title: { type: "string", required: true } }, body: 'nowen.progress({ current: 1, total: 1, message: "Done" }); return { data: await nowen.tasks.create({ title: String(input.title) }) };' },
};
const selected = templates[template] || templates.hello;

const directoryName = directoryArg || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const target = path.resolve(directoryName);
const localSdk = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "nowen-plugin-sdk");
const localCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "nowen-plugin-cli");
const sdkDependency = fs.existsSync(path.join(localSdk, "package.json")) ? `file:${localSdk.replace(/\\/g, "/")}` : "^2.0.0";
const cliDependency = fs.existsSync(path.join(localCli, "package.json")) ? `file:${localCli.replace(/\\/g, "/")}` : "^2.0.0";
if (fs.existsSync(target) && fs.readdirSync(target).length > 0) throw new Error(`目标目录非空: ${target}`);
fs.mkdirSync(path.join(target, "src"), { recursive: true });
fs.mkdirSync(path.join(target, "scripts"), { recursive: true });

const files = {
  "manifest.json": JSON.stringify({
    id, name, description, version: "1.0.0", apiVersion: 2, publisher,
    engines: { nowen: ">=1.5.0 <2.0.0" }, runtime: "sandbox-js", main: "dist/index.js",
    categories: [template === "hello" ? "development" : template], keywords: [template], repository, license: "MIT",
    permissions: selected.permissions,
    ...(template === "ai" ? { connections: [{ id: "openai", name: "OpenAI", type: "bearer" }] } : {}),
    ...(template === "connector" ? { connections: [{ id: "service", name: "Service API", type: "bearer" }] } : {}),
    actions: [{ id: selected.action, name: selected.actionName, description, execution: template === "automation" ? "background" : "interactive", input: selected.input }],
  }, null, 2) + "\n",
  "package.json": JSON.stringify({
    name: directoryName, version: "1.0.0", private: true, type: "module",
    scripts: { dev: "nowen-plugin dev", build: "nowen-plugin build", validate: "nowen-plugin validate", doctor: "nowen-plugin doctor", test: "nowen-plugin test", pack: "npm run build && nowen-plugin pack" },
    dependencies: { "@nowen/plugin-sdk": sdkDependency },
    devDependencies: { "nowen-plugin": cliDependency, esbuild: "^0.24.0", typescript: "^5.7.3" },
  }, null, 2) + "\n",
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true }, include: ["src"] }, null, 2) + "\n",
  "nowen.config.ts": `export default { manifest: "manifest.json", output: "dist/${directoryName}-1.0.0.nowen-plugin" };\n`,
  "src/index.ts": `import { definePlugin } from "@nowen/plugin-sdk";\n\nexport default definePlugin({\n  actions: {\n    "${selected.action}": async ({ input, nowen }) => { ${selected.body} },\n  },\n});\n`,
  "README.md": `# ${name}\n\n${description}\n\n## Development\n\n\`npm install\`, then \`npm run dev\`, \`npm run build\`, or \`npm run pack\`.\n`,
};

for (const [relative, contents] of Object.entries(files)) {
  const destination = path.join(target, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents, { flag: "wx" });
}
stdout.write(`\nCreated ${name} in ${target}\nNext: cd ${directoryName} && npm install && npm run pack\n`);
