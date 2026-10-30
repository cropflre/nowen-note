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
    async run(sql:string,values:unknown[]=[]){
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
        assignments.set(String(values[2]),values[0] == null ? null : String(values[0]));return {changes:1};
      }
      if(normalized.startsWith("UPDATE attachments SET folderId=NULL")){
        const folderId=String(values[2]);
        for(const [id,current] of assignments)if(current===folderId)assignments.set(id,null);
        return {changes:1};
      }
      if(normalized.startsWith("UPDATE mobile_local_attachment_folders SET parentId=NULL"))return {changes:0};
      if(normalized.startsWith("UPDATE mobile_local_attachment_folders SET parentId=?")){
        const folder=folders.find((item)=>item.id===values[2]);
        if(folder)folder.parentId=values[0] as string|null;
        return {changes:folder?1:0};
      }
      if(normalized.startsWith("DELETE FROM mobile_local_attachment_folders")){
        const id=String(values[0]);const index=folders.findIndex((folder)=>folder.id===id);
        if(index>=0)folders.splice(index,1);return {changes:index>=0?1:0};
      }
      if(normalized.startsWith("UPDATE mobile_local_attachment_folders SET name=")){
        const [name,updatedAt,id]=values as [string,string,string];
        const folder=folders.find((item)=>item.id===id);
        if(folder){folder.name=name;folder.updatedAt=updatedAt;}return {changes:folder?1:0};
      }
      return {changes:0};
    },
    async query<T>(sql:string,values:unknown[]=[]){
      const normalized=sql.replace(/\s+/g," ").trim();
      if(normalized.startsWith("PRAGMA table_info(attachments)"))return (hasFolderColumn?[{name:"id"},{name:"folderId"}]:[{name:"id"}]) as T[];
      if(normalized.includes("FROM mobile_local_attachment_folders WHERE id=?")){
        return folders.filter((folder)=>folder.id===String(values[0])&&folder.userId===String(values[1])) as T[];
      }
      if(normalized.includes("SELECT id FROM mobile_local_attachment_folders")&&normalized.includes("WHERE userId=? AND name=?")){
        const userId=String(values[0]);
        const name=String(values[1]);
        const parentId=values[2] == null ? null : String(values[2]);
        const excludeId=values.length>4 && values[4] != null ? String(values[4]) : undefined;
        return folders
          .filter((folder)=>folder.userId===userId&&folder.name===name&&folder.parentId===parentId&&folder.id!==excludeId)
          .map((folder)=>({id:folder.id})) as T[];
      }
      if(normalized.includes("FROM mobile_local_attachment_folders f")){
        return folders.map((folder)=>({...folder,fileCount:[...assignments.values()].filter((id)=>id===folder.id).length})) as T[];
      }
      if(normalized.startsWith("SELECT id,folderId FROM attachments")){
        return [...assignments].map(([id,folderId])=>({id,folderId})) as T[];
      }
      if(normalized.startsWith("SELECT id FROM attachments WHERE folderId=?")){
        return [...assignments].filter(([,folderId])=>folderId===values[0]).map(([id])=>({id})) as T[];
      }
      if(normalized.startsWith("SELECT id FROM mobile_local_attachment_folders WHERE parentId=?")){
        return folders.filter((folder)=>folder.parentId===values[0]).map(({id})=>({id})) as T[];
      }
      if(normalized.startsWith("SELECT id FROM attachments WHERE id=?")){
        return (assignments.has(String(values[0])) ? [{id:String(values[0])}] : []) as T[];
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
  move:api.files.move,
};
const originalFolders={...api.attachmentFolders};
let restore:(()=>void)|null=null;

afterEach(()=>{
  restore?.();restore=null;
  api.files.list=originalFiles.list;
  api.files.get=originalFiles.get;
  api.files.upload=originalFiles.upload;
  api.files.move=originalFiles.move;
  api.attachmentFolders={...originalFolders};
  vi.restoreAllMocks();
});

describe("mobile local attachment folder bridge",()=>{
  it("moves and unarchives local files without remote requests and rejects a missing selection",async()=>{
    const nested = createFakeDb();
    restore=installMobileLocalAttachmentFolderBridge(nested.db,"android-local-user");
    const parent=await api.attachmentFolders.create("parent");
    const child=await api.attachmentFolders.create("child",parent.id);
    await expect(api.attachmentFolders.move(parent.id,child.id)).rejects.toMatchObject({code:"FOLDER_CYCLE"});
    await expect(api.attachmentFolders.remove(parent.id)).rejects.toMatchObject({code:"FOLDER_NOT_EMPTY"});
    await api.attachmentFolders.move(child.id,null);
    expect(nested.folders.find((folder)=>folder.id===child.id)?.parentId).toBeNull();
    restore();
    const {db,assignments}=createFakeDb();
    const fetchSpy=vi.spyOn(globalThis,"fetch");
    restore=installMobileLocalAttachmentFolderBridge(db,"android-local-user");
    const folder=await api.attachmentFolders.create("中文文件夹");
    await expect(api.files.move(["file-1","missing"],folder.id)).rejects.toThrow("文件不存在");
    expect(assignments.get("file-1")).toBeNull();
    await expect(api.files.move(["file-1"],folder.id)).resolves.toMatchObject({moved:1,folderName:"中文文件夹"});
    expect(assignments.get("file-1")).toBe(folder.id);
    await api.files.move(["file-1"],null);
    expect(assignments.get("file-1")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("persists folders and upload assignment locally without fetch",async()=>{
    const {db,assignments}=createFakeDb();
    const baseItem={
      id:"file-1",filename:"demo.txt",mimeType:"text/plain",size:4,createdAt:"2026-08-27T00:00:00.000Z",
      category:"file",url:"blob:local",hash:null,folderId:null,folderName:null,primaryNote:null,
    } as import("@/types").FileDetail;
    api.files.list=vi.fn(async()=>({items:[baseItem],total:1,page:1,pageSize:10}));
    api.files.get=vi.fn(async()=>baseItem);
    api.files.upload=vi.fn(async()=>baseItem);
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

    await expect(api.attachmentFolders.remove(folder.id)).rejects.toMatchObject({code:"FOLDER_NOT_EMPTY"});
    expect(assignments.get("file-1")).toBe(folder.id);
    await api.files.move(["file-1"],null);
    await api.attachmentFolders.remove(folder.id);
    expect(assignments.get("file-1")).toBeNull();
    expect((await api.attachmentFolders.list()).folders).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
