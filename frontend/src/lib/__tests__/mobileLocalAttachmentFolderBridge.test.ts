import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { installMobileLocalAttachmentFolderBridge } from "@/lib/mobileLocalAttachmentFolderBridge";
import type { NativeDatabase } from "@/lib/nativeDatabase";

interface FolderRow {
  id:string;
  userId:string;
  name:string;
  parentId:string|null;
  createdAt:string;
  updatedAt:string;
}

function createFakeDb() {
  const folders:FolderRow[]=[];
  const assignments=new Map<string,string|null>([["file-1",null]]);
  let hasFolderColumn=false;
  const db:NativeDatabase={
    async run(sql,values=[]){
      const normalized=sql.replace(/\s+/g," ").trim();
      if(normalized.startsWith("ALTER TABLE attachments ADD COLUMN folderId")){
        hasFolderColumn=true;return {changes:0};
      }
      if(normalized.startsWith("CREATE TABLE")||normalized.startsWith("CREATE INDEX"))return {changes:0};
      if(normalized.startsWith("INSERT INTO mobile_local_attachment_folders")){
        const [id,userId,name,parentId,createdAt,updatedAt]=values as [string,string,string,string|null,string,string];
        folders.push({id,userId,name,parentId,createdAt,updatedAt});return {changes:1};
      }
      if(normalized.startsWith("UPDATE attachments SET folderId=?,updatedAt=?")){
        assignments.set(String(values[3]??values[2]),String(values[0]));return {changes:1};
      }
      if(normalized.startsWith("UPDATE attachments SET folderId=NULL")){
        const folderId=String(values[2]);
        for(const [id,current] of assignments)if(current===folderId)assignments.set(id,null);
        return {changes:1};
      }
      if(normalized.startsWith("UPDATE mobile_local_attachment_folders SET parentId=NULL"))return {changes:0};
      if(normalized.startsWith("DELETE FROM mobile_local_attachment_folders")){
        const id=String(values[0]);const index=folders.findIndex((folder)=>folder.id===id);
        if(index>=0)folders.splice(index,1);return {changes:index>=0?1:0};
      }
      if(normalized.startsWith("UPDATE mobile_local_attachment_folders SET name=")){
        const [name,updatedAt,id]=values as [string,string,string,string];
        const folder=folders.find((item)=>item.id===id);
        if(folder){folder.name=name;folder.updatedAt=updatedAt;}return {changes:folder?1:0};
      }
      return {changes:0};
    },
    async query<T>(sql,values=[]){
      const normalized=sql.replace(/\s+/g," ").trim();
      if(normalized.startsWith("PRAGMA table_info(attachments)"))return (hasFolderColumn?[{name:"id"},{name:"folderId"}]:[{name:"id"}]) as T[];
      if(normalized.includes("FROM mobile_local_attachment_folders WHERE id=?")){
        return folders.filter((folder)=>folder.id===String(values[0])&&folder.userId===String(values[1])) as T[];
      }
      if(normalized.includes("SELECT id FROM mobile_local_attachment_folders")&&normalized.includes("WHERE userId=? AND name=?")){
        const [userId,name,parentId,,excludeId]=values as [string,string,string|null,string|null,string|undefined];
        return folders.filter((folder)=>folder.userId===userId&&folder.name===name&&folder.parentId===parentId&&folder.id!==excludeId).map((folder)=>({id:folder.id})) as T[];
      }
      if(normalized.includes("FROM mobile_local_attachment_folders f")){
        return folders.map((folder)=>({...folder,fileCount:[...assignments.values()].filter((id)=>id===folder.id).length})) as T[];
      }
      if(normalized.startsWith("SELECT id,folderId FROM attachments")){
        return [...assignments].map(([id,folderId])=>({id,folderId})) as T[];
      }
      return [] as T[];
    },
    async transaction<T>(work:(tx:NativeDatabase)=>Promise<T>){return work(db);},
    async close(){},
  };
  return {db,folders,assignments};
}

const originalFiles={
  list:api.files.list,
  get:api.files.get,
  upload:api.files.upload,
};
const originalFolders={...api.attachmentFolders};
let restore:(()=>void)|null=null;

afterEach(()=>{
  restore?.();restore=null;
  (api.files as any).list=originalFiles.list;
  (api.files as any).get=originalFiles.get;
  (api.files as any).upload=originalFiles.upload;
  (api as any).attachmentFolders={...originalFolders};
  vi.restoreAllMocks();
});

describe("mobile local attachment folder bridge",()=>{
  it("persists folders and upload assignment locally without fetch",async()=>{
    const {db,assignments}=createFakeDb();
    const baseItem={
      id:"file-1",filename:"demo.txt",mimeType:"text/plain",size:4,createdAt:"2026-08-27T00:00:00.000Z",
      category:"file",url:"blob:local",hash:null,folderId:null,folderName:null,primaryNote:null,
    } as any;
    (api.files as any).list=vi.fn(async()=>({items:[baseItem],total:1,page:1,pageSize:10}));
    (api.files as any).get=vi.fn(async()=>baseItem);
    (api.files as any).upload=vi.fn(async()=>baseItem);
    const fetchSpy=vi.spyOn(globalThis,"fetch");
    restore=installMobileLocalAttachmentFolderBridge(db,"android-local-user");

    const folder=await api.attachmentFolders.create("资料");
    expect(folder).toMatchObject({name:"资料",parentId:null,fileCount:0});

    const uploaded=await api.files.upload(new File(["demo"],"demo.txt",{type:"text/plain"}),{folderId:folder.id});
    expect(uploaded).toMatchObject({id:"file-1",folderId:folder.id,folderName:"资料"});
    expect(assignments.get("file-1")).toBe(folder.id);

    const listed=await api.files.list({page:1,pageSize:10});
    expect(listed.items[0]).toMatchObject({folderId:folder.id,folderName:"资料"});
    expect((await api.attachmentFolders.list()).folders[0]).toMatchObject({id:folder.id,fileCount:1});

    await api.attachmentFolders.remove(folder.id);
    expect(assignments.get("file-1")).toBeNull();
    expect((await api.attachmentFolders.list()).folders).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
