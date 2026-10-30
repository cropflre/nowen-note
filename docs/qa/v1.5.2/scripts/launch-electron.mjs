import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const [electron, ...args] = process.argv.slice(2);
for (let i = 0; i < args.length - 1; i++) if (args[i] === '--import' && /^[A-Za-z]:[\\/]/.test(args[i + 1])) args[i + 1] = pathToFileURL(args[i + 1]).href;
const child = spawn(electron, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true });
child.once('error', (error) => { console.error(error); process.exitCode = 1; });
child.once('close', (code) => { process.exitCode = code ?? 1; });
