import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DesktopOfflineSyncGate from '@/components/DesktopOfflineSyncGate';
import { enqueue, flushQueue, getQueue, getQueueLength, updateItem } from '@/lib/offlineQueue';

const state=vi.hoisted(()=>({flush:vi.fn()}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('@/lib/api',()=>({getServerUrl:()=> 'https://nas.test'}));
vi.mock('@/lib/authSession',()=>({getAccessToken:()=> 'remote-token'}));
vi.mock('@/lib/offlineScope',()=>({STORAGE_KEY_PREFIX:'nowen-offline-queue:v2',getOfflineQueueStorageKey:()=> 'nowen-offline-queue:v2:nas:user'}));
vi.mock('@/lib/syncEngine',()=>({syncNow:state.flush}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

beforeEach(()=>{localStorage.clear();vi.clearAllMocks();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

function retainEdit(noteId:string) {
  enqueue({type:'updateNote',noteId,url:`/notes/${noteId}`,method:'PUT',body:{content:`local edit ${noteId}`,contentFormat:'markdown',version:1}});
  return getQueue().find(item=>item.noteId===noteId)!;
}

it('DCC-003: automatic download replays retained legacy edits before starting the NAS baseline', async () => {
  retainEdit('legacy-note');
  state.flush.mockImplementation(async()=>{await flushQueue(async()=>({ok:true,status:200,data:{id:'legacy-note',version:2}}));return {ok:true,pending:getQueueLength()};});
  const migrate=vi.fn(async()=>({ok:false,error:'stop after observing the migration request'}));
  const desktopWindow=window as unknown as {nowenDesktop?:object};
  desktopWindow.nowenDesktop={isDesktop:true,getAppInfo:async()=>({runtime:'remote',localRuntimeAvailable:true}),startLiteMigration:migrate};
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try {
    await act(async()=>{root.render(<DesktopOfflineSyncGate><span>editor</span></DesktopOfflineSyncGate>);});
    expect(state.flush).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith('https://nas.test','remote-token');
    expect(host.textContent).not.toContain('editor');
  } finally {act(()=>root.unmount());host.remove();delete desktopWindow.nowenDesktop;}
});

it('DCC-003: blocked legacy edits remain exportable and retry preserves unresolved conflicts', async () => {
  const conflict=retainEdit('conflicted-note'), blocked=retainEdit('blocked-note');
  updateItem(conflict.id,{conflict:true,blocked:true,errorCode:'VERSION_CONFLICT',localPayload:conflict.body});
  updateItem(blocked.id,{blocked:true,retryable:false,errorCode:'FORBIDDEN',retryCount:1});
  state.flush.mockImplementation(async()=>({ok:false,pending:getQueueLength()}));
  const migrate=vi.fn();
  const desktopWindow=window as unknown as {nowenDesktop?:object};
  desktopWindow.nowenDesktop={isDesktop:true,getAppInfo:async()=>({runtime:'remote',localRuntimeAvailable:true}),startLiteMigration:migrate};
  const create=vi.fn((blob:unknown)=>{expect(blob).toBeInstanceOf(Blob);return 'blob:pending-edits';});
  const OriginalURL=URL;
  vi.stubGlobal('URL',class extends OriginalURL {static createObjectURL=create;static revokeObjectURL=vi.fn();});
  const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try {
    await act(async()=>{root.render(<DesktopOfflineSyncGate><span>editor</span></DesktopOfflineSyncGate>);});
    const buttons=[...host.querySelectorAll('button')];
    const exportButton=buttons.find(button=>button.textContent==='offlineAvailability.exportLegacyEdits');
    const retryButton=buttons.find(button=>button.textContent==='offlineAvailability.retryLegacyEdits');
    expect(host.textContent).toContain('offlineAvailability.legacyEditsRetained');
    expect(exportButton).toBeDefined();expect(retryButton).toBeDefined();
    act(()=>exportButton!.click());
    expect(click).toHaveBeenCalledOnce();
    const blob=create.mock.calls[0][0] as Blob;
    const json=await new Promise<string>(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.readAsText(blob);});
    const diagnostic=JSON.parse(json);
    expect(diagnostic.items.map((item:{id:string})=>item.id)).toEqual([conflict.id,blocked.id]);
    expect(json).toContain('local edit conflicted-note');expect(json).not.toContain('remote-token');
    await act(async()=>retryButton!.click());
    const queue=getQueue();
    expect(queue.map(item=>item.id)).toEqual([conflict.id,blocked.id]);
    expect(queue[0]).toMatchObject({conflict:true,errorCode:'VERSION_CONFLICT',localPayload:conflict.body});
    expect(queue[1].blocked).toBeUndefined();expect(queue[1].retryCount).toBe(0);
    expect(queue[1].body).toEqual(blocked.body);
    expect(state.flush).toHaveBeenCalledTimes(2);expect(migrate).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('editor');
  } finally {act(()=>root.unmount());host.remove();delete desktopWindow.nowenDesktop;}
});

it('DCC-009: Web and Android without a desktop bridge open their existing workspace without desktop sync', async () => {
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try {
    await act(async()=>{root.render(<DesktopOfflineSyncGate><span>editor</span></DesktopOfflineSyncGate>);});
    expect(host.textContent).toBe('editor');
    expect(state.flush).not.toHaveBeenCalled();
  } finally {act(()=>root.unmount());host.remove();}
});
