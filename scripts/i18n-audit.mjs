import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'frontend/package.json'));
const ts = require('typescript');
const base = process.argv.includes('--base');
const guard = process.argv.includes('--guard');
const files = execFileSync('git', ['ls-files', 'frontend/src/**/*.tsx'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n').filter((name) => name && !name.includes('/__tests__/'));
const findings = [];
for (const file of files) {
  const source = base ? execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' }) : readFileSync(path.join(root, file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    let text = '';
    if (ts.isJsxText(node)) text = node.getText(ast).trim();
    else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) && /^(title|aria-label|placeholder|alt)$/.test(node.name.getText(ast))) text = node.initializer.text;
    else if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteral(node.expression)) text = node.expression.text;
    text = text.replace(/\s+/g, ' ').trim();
    const kind = /[\u3400-\u9fff]/u.test(text) ? 'zh' : /^[A-Za-z]+(?:[ '\u2019-]+[A-Za-z]+)+[.!?…]?$/.test(text) ? 'en' : null;
    if (kind) findings.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, kind, text });
    ts.forEachChild(node, visit);
  };
  visit(ast);
}
const guarded = new Set(['frontend/src/components/NoteTemplatePickerDialog.tsx', 'frontend/src/components/KnowledgeSearchScopeSwitch.tsx', 'frontend/src/components/KnowledgeSearchScopeMenuButton.tsx']);
const summary = { base: base ? 'HEAD' : 'working tree', files: files.length, zhCandidates: findings.filter((f) => f.kind === 'zh').length, enCandidates: findings.filter((f) => f.kind === 'en').length, filesWithCandidates: new Set(findings.map((f) => f.file)).size, guardedFindings: findings.filter((f) => guarded.has(f.file)) };
if (process.argv.includes('--json')) console.log(JSON.stringify({ summary, findings }, null, 2));
else console.log(JSON.stringify(summary, null, 2));
if (guard && summary.guardedFindings.length) process.exitCode = 1;
