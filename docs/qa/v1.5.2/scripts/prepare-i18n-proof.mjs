import fs from 'node:fs';
import path from 'node:path';
const [checkout, evidence] = process.argv.slice(2);
const frontend = path.join(checkout, 'frontend');
fs.writeFileSync(path.join(frontend, '.qa-i18n.setup.ts'), `import i18n from './src/i18n';\nawait i18n.changeLanguage('zh-CN');\n`);
fs.writeFileSync(path.join(frontend, '.qa-i18n.config.ts'), `import base from './vitest.config';\nexport default {...base, test: {...base.test, setupFiles:['./.qa-i18n.setup.ts'], include:['src/components/__tests__/SyncStatusBadge.mobile.test.tsx','src/components/settings/__tests__/ServerConnectionSettings.test.tsx','.qa-i18n-resources.test.ts']}};\n`);
fs.writeFileSync(path.join(frontend, '.qa-i18n-resources.test.ts'), `import {it,expect} from 'vitest';
import fs from 'node:fs';
import i18n from './src/i18n';
it('production merged resources contain each requested namespace in both languages', async()=>{
  const report:any={};
  const flatten=(value:any,prefix=''):string[]=>Object.entries(value).flatMap(([key,child])=>typeof child==='string'?[prefix+key]:flatten(child,prefix+key+'.'));
  for(const language of ['zh-CN','en']) {
    report[language]={};
    for(const namespace of ['syncBadge','serverConnection']) {
      const value=i18n.getResource(language,'translation',namespace);expect(value).toBeTruthy();
      const keys=flatten(value); expect(keys.length).toBeGreaterThan(8);
      report[language][namespace]=Object.fromEntries(keys.map(key=>{const text=i18n.getResource(language,'translation',namespace+'.'+key);expect(typeof text).toBe('string');return[key,text]}));
    }
  }
  fs.writeFileSync(${JSON.stringify(path.join(evidence,'production-i18n-resources.json'))},JSON.stringify(report,null,2));
  await i18n.changeLanguage('zh-CN');
});
`);
