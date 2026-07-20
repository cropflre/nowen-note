const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profilesPath = path.join(root, 'src/lib/serverProfiles.ts');
const packagePath = path.join(root, 'package.json');

const oldBlock = `export function listServerProfiles(): ServerProfile[] {
  const stored = readProfilesFromKey(STORAGE_KEY);
  return stored.length > 0 ? stored : bootstrapServerProfiles();
}`;
const newBlock = `export function listServerProfiles(): ServerProfile[] {
  try {
    if (localStorage.getItem(STORAGE_KEY) !== null) return readProfilesFromKey(STORAGE_KEY);
  } catch { /* fall through to bootstrap */ }
  return bootstrapServerProfiles();
}`;

const source = fs.readFileSync(profilesPath, 'utf8');
if (!source.includes(oldBlock)) {
  throw new Error('Issue #343 finalizer could not find listServerProfiles bootstrap block');
}
fs.writeFileSync(profilesPath, source.replace(oldBlock, newBlock));

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
delete packageJson.scripts.postinstall;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
fs.unlinkSync(__filename);

console.log('[issue343] applied initialized-empty profile guard and removed one-shot installer');
