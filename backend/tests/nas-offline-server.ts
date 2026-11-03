// Real service/auth/sync routes; all data and listeners are test-local.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const directory = path.resolve(process.env.NOWEN_NAS_OFFLINE_PROFILE || '');
if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('nowen-nas-offline-')) throw new Error('An isolated offline test directory is required');
const data = path.join(directory, 'nas');
fs.mkdirSync(data, {recursive:true});
process.chdir(data);
process.env.DB_PATH = path.join(data, 'nas.db');
process.env.ELECTRON_USER_DATA = data;
process.env.BACKUP_DIR = path.join(data, 'backups');
process.env.NODE_ENV = 'test';
process.env.DISABLE_MDNS = '1';
process.env.BACKUP_AUTO_ENABLED = 'false';
process.env.CALENDAR_EXPORT_TIMER_DISABLED = '1';
void import('../../scripts/nas-offline-backend-fixture.cjs').then(() => import('../src/index.hardened.js')).then(async()=>{
  // Optional parent IPC seeds synthetic large files without exposing a test HTTP route.
  const {getDb}=await import('../src/db/schema');
  process.on('message',(message: {type?:string;userId?:string;noteId?:string;files?:Array<{id:string;path:string;size:number;hash:string}>})=>{
    if(message.type==='metrics'){process.send?.({type:'metrics',rssBytes:process.memoryUsage().rss,maxRSSKiB:process.resourceUsage().maxRSS});return;}
    if(message.type!=='seed-attachments')return;
    try{
      const db=getDb();
      if(!db.prepare('SELECT 1 FROM notes WHERE id=? AND userId=?').get(message.noteId,message.userId))throw new Error('Invalid synthetic owner');
      db.transaction(()=>{
        for(const file of message.files || []){
          const target=path.resolve(data,'attachments',file.path);
          if(!target.startsWith(path.join(data,'attachments')+path.sep)||fs.statSync(target).size!==file.size)throw new Error('Invalid synthetic file');
          db.prepare("INSERT INTO attachments(id,noteId,userId,filename,mimeType,size,path,hash,createdAt) VALUES (?,?,?,'capacity.bin','application/octet-stream',?,?,?,datetime('now'))")
            .run(file.id,message.noteId,message.userId,file.size,file.path,file.hash);
        }
      })();
      process.send?.({type:'seeded'});
    }catch(error){process.send?.({type:'seed-error',error:error instanceof Error?error.message:String(error)});}
  });
});
