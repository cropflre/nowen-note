// Synthetic files, uploaded through production routes; no existing user data.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const offlineText = 'NAS offline attachment preview: persisted file bytes';

export async function seedOfflineAttachments(server, token, note) {
  const png = await require('sharp')({create:{width:16,height:16,channels:4,background:'#3877eb'}}).png().toBuffer();
  const files = [
    {name:'offline-preview.txt',type:'text/plain',bytes:Buffer.from(offlineText)},
    {name:'offline-preview.png',type:'image/png',bytes:png},
  ];
  for (const file of files) {
    const form = new FormData();
    form.set('noteId',note.id);
    form.set('file',new Blob([file.bytes],{type:file.type}),file.name);
    const response = await fetch(`${server}/api/attachments`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form});
    assert.equal(response.status,201,`upload ${file.name}`);
    Object.assign(file,await response.json());
  }
  const content = `${note.content}\n\n${files.map(file=>`[${file.name}](${file.url})`).join('\n\n')}`;
  const response = await fetch(`${server}/api/notes/${note.id}`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({content,contentText:content,version:note.version})});
  assert.ok(response.ok,`reference attachments: ${response.status}`);
  return files;
}

export async function verifyOfflineAttachmentPreviews(page, expect, output, mobile = false) {
  const menu = mobile ? '[data-mobile-note-menu-trigger]:visible' : '[data-editor-more-menu="desktop"] > button';
  await page.locator(menu).first().click({noWaitAfter:true});
  await page.getByRole('button',{name:'附件',exact:true}).click({noWaitAfter:true});
  await expect(page.getByRole('heading',{name:'附件目录',exact:true})).toBeVisible();
  await page.locator('li').filter({hasText:'offline-preview.txt'}).last().click({noWaitAfter:true});
  await expect(page.locator('pre').filter({hasText:offlineText})).toBeVisible({timeout:20_000});
  await page.screenshot({path:path.join(output,'offline-text-preview.png')});
  await page.getByRole('button',{name:'关闭',exact:true}).last().click({noWaitAfter:true});
  await page.locator('li').filter({hasText:'offline-preview.png'}).last().click({noWaitAfter:true});
  const image = page.getByRole('img',{name:'offline-preview.png',exact:true}).last();
  await expect.poll(()=>image.evaluate(img=>img.complete && img.naturalWidth===16),{timeout:20_000}).toBe(true);
  await page.screenshot({path:path.join(output,'offline-image-preview.png')});
  await page.getByRole('button',{name:'关闭',exact:true}).last().click({noWaitAfter:true});
  const panel = page.getByRole('heading',{name:'附件目录',exact:true}).locator('..').locator('..').locator('..');
  await panel.locator('button:has(svg.lucide-x)').first().click({noWaitAfter:true});
}
