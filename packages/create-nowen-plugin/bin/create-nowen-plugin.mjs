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
rl.close();

const directoryName = directoryArg || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const target = path.resolve(directoryName);
const localSdk = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "nowen-plugin-sdk");
const sdkDependency = fs.existsSync(path.join(localSdk, "package.json")) ? `file:${localSdk.replace(/\\/g, "/")}` : "^1.0.0";
if (fs.existsSync(target) && fs.readdirSync(target).length > 0) throw new Error(`目标目录非空: ${target}`);
fs.mkdirSync(path.join(target, "src"), { recursive: true });
fs.mkdirSync(path.join(target, "scripts"), { recursive: true });

const files = {
  "manifest.json": JSON.stringify({
    id, name, description, version: "1.0.0", apiVersion: 1,
    engines: { nowen: ">=1.5.0 <2.0.0" }, runtime: "node-action", main: "dist/index.mjs",
    author: { name: author }, permissions: [],
    actions: [{ id: "hello", name: "Hello Nowen", description: "Return a greeting", execution: "interactive", input: { name: { type: "string", required: false } } }],
  }, null, 2) + "\n",
  "package.json": JSON.stringify({
    name: directoryName, version: "1.0.0", private: true, type: "module",
    scripts: { dev: "npm run build -- --watch", build: "esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.mjs", pack: "npm run build && node scripts/pack.mjs" },
    dependencies: { "@nowen/plugin-sdk": sdkDependency },
    devDependencies: { archiver: "^7.0.1", esbuild: "^0.24.0", typescript: "^5.7.3" },
  }, null, 2) + "\n",
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true }, include: ["src"] }, null, 2) + "\n",
  "nowen.config.ts": `export default { manifest: "manifest.json", output: "dist/${directoryName}-1.0.0.nowen-plugin" };\n`,
  "src/index.ts": `import { definePlugin } from "@nowen/plugin-sdk";\n\nexport default definePlugin({\n  actions: {\n    hello: async ({ input }) => ({ text: \`Hello \${input.name ?? "Nowen"}!\` }),\n  },\n});\n`,
  "scripts/pack.mjs": `import archiver from "archiver";\nimport fs from "node:fs";\nimport path from "node:path";\nconst manifest=JSON.parse(fs.readFileSync("manifest.json","utf8"));\nfs.mkdirSync("dist",{recursive:true});\nconst output=fs.createWriteStream(path.join("dist",\`${directoryName}-\${manifest.version}.nowen-plugin\`));\nconst archive=archiver("zip",{zlib:{level:9}});\narchive.pipe(output); archive.file("manifest.json",{name:"manifest.json"}); archive.file("dist/index.mjs",{name:"dist/index.mjs"});\nif(fs.existsSync("README.md")) archive.file("README.md",{name:"README.md"}); await archive.finalize();\n`,
  "README.md": `# ${name}\n\n${description}\n\n## Development\n\n\`npm install\`, then \`npm run dev\`, \`npm run build\`, or \`npm run pack\`.\n`,
};

for (const [relative, contents] of Object.entries(files)) {
  const destination = path.join(target, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents, { flag: "wx" });
}
stdout.write(`\nCreated ${name} in ${target}\nNext: cd ${directoryName} && npm install && npm run pack\n`);
