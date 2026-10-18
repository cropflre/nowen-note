import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-b'], {
  cwd: path.join(root, 'frontend'), stdio: 'inherit',
});
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--mode', 'harmony'], {
  cwd: path.join(root, 'frontend'), stdio: 'inherit',
});
const target = path.join(root, 'nowen-harmony/entry/src/main/resources/rawfile/web');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(path.join(root, 'frontend/dist'), target, { recursive: true });
await cp(path.join(root, 'nowen-harmony/runtime/harmony-runtime.js'), path.join(target, 'harmony-runtime.js'));
const index = path.join(target, 'index.html');
await writeFile(index, (await readFile(index, 'utf8')).replace('<head>',
  '<head>\n<script src="/harmony-runtime.js"></script>'));
console.log('HarmonyOS bundled frontend ready:', target);
