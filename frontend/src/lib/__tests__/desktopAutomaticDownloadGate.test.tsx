import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DesktopOfflineSyncGate from '@/components/DesktopOfflineSyncGate';
import { enqueue, flushQueue, getQueue, getQueueLength, updateItem } from '@/lib/offlineQueue';

const state=vi.hoisted(()=>({flush:vi.fn(),serverUrl:'https://nas.test'}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string,values?:Record<string,unknown>)=>values?`${key} ${JSON.stringify(values)}`:key})}));
vi.mock('@/lib/api',()=>({getServerUrl:()=>state.serverUrl}));
vi.mock('@/lib/authSession',()=>({getAccessToken:()=> 'remote-token'}));
vi.mock('@/lib/offlineScope',()=>({STORAGE_KEY_PREFIX:'nowen-offline-queue:v2',getOfflineQueueStorageKey:()=> 'nowen-offline-queue:v2:nas:user'}));
vi.mock('@/lib/syncEngine',()=>({syncNow:state.flush}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

beforeEach(()=>{localStorage.clear();vi.clearAllMocks();state.serverUrl='https://nas.test';});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});

function retainEdit(noteId:string) {
  enqueue({type:'updateNote',noteId,url:`/notes/${noteId}`,method:'PUT',body:{content:`local edit ${noteId}`,contentFormat:'markdown',version:1}});
  return getQueue().find(item=>item.noteId===noteId)!;
}

it('DCC-006: local login recovery keeps remote credentials and retries download only after confirmation', async () => {
  vi.useFakeTimers();
  const migrate=vi.fn().mockResolvedValueOnce({ok:false,error:'LOCAL_ACCOUNT_REQUIRES_MANUAL_LOGIN'})
    .mockResolvedValue({ok:false,error:'download interrupted'});
  let finishReset!: (result:unknown)=>void;
  const reset=vi.fn().mockResolvedValueOnce({ok:false,cancelled:true})
    .mockImplementationOnce(()=>new Promise(resolve=>{finishReset=resolve;}));
  const desktopWindow=window as unknown as {nowenDesktop?:object};
  desktopWindow.nowenDesktop={isDesktop:true,getAppInfo:async()=>({runtime:'remote',localRuntimeAvailable:true}),startLiteMigration:migrate,resetLocalAuth:reset};
  localStorage.setItem('nowen-token','remote-token');
  localStorage.setItem('nowen-server-url','https://nas.test');
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  const button=(key:string)=>[...host.querySelectorAll('button')].find(item=>item.textContent===key)!;
  try {
    await act(async()=>{root.render(<DesktopOfflineSyncGate><span>editor</span></DesktopOfflineSyncGate>);});
    expect(host.textContent).toContain('offlineAvailability.localAccountRecoveryHint');
    expect(reset).not.toHaveBeenCalled();
    await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
    expect(migrate).toHaveBeenCalledOnce();
    await act(async()=>button('offlineAvailability.recoverLocalAccount').click());
    expect(migrate).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain('editor');
    await act(async()=>button('offlineAvailability.recoverLocalAccount').click());
    expect(button('offlineAvailability.continueOnline').disabled).toBe(true);
    expect(button('offlineAvailability.recoverLocalAccount').disabled).toBe(true);
    await act(async()=>finishReset({ok:true,token:'local-secret-token'}));
    expect(migrate).toHaveBeenCalledTimes(2);
    expect(migrate).toHaveBeenLastCalledWith('https://nas.test','remote-token');
    expect(localStorage.getItem('nowen-token')).toBe('remote-token');
    expect(localStorage.getItem('nowen-server-url')).toBe('https://nas.test');
    expect(host.textContent).not.toContain('local-secret-token');
  } finally {act(()=>root.unmount());host.remove();delete desktopWindow.nowenDesktop;}
});

it.each(['failure','server-change'])('local recovery %s cannot start a download or switch credentials', async (outcome) => {
  vi.useFakeTimers();
  const migrate=vi.fn().mockResolvedValue({ok:false,error:'LOCAL_ACCOUNT_REQUIRES_MANUAL_LOGIN'});
  let finishReset!: (result:unknown)=>void;
  const reset=vi.fn(()=>new Promise(resolve=>{finishReset=resolve;}));
  const desktopWindow=window as unknown as {nowenDesktop?:object};
  desktopWindow.nowenDesktop={isDesktop:true,getAppInfo:async()=>({runtime:'remote',localRuntimeAvailable:true}),startLiteMigration:migrate,resetLocalAuth:reset};
  localStorage.setItem('nowen-token','remote-token');
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try {
    await act(async()=>{root.render(<DesktopOfflineSyncGate><span>editor</span></DesktopOfflineSyncGate>);});
    await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='offlineAvailability.recoverLocalAccount')!.click());
    if (outcome==='server-change') state.serverUrl='https://other-nas.test';
    await act(async()=>finishReset(outcome==='failure' ? {ok:false,error:'recovery failed'} : {ok:true,token:'local-token'}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
    expect(migrate).toHaveBeenCalledOnce();
    expect(localStorage.getItem('nowen-token')).toBe('remote-token');
    expect(host.textContent).not.toContain('editor');
    if (outcome==='failure') expect(host.textContent).toContain('recovery failed');
  } finally {act(()=>root.unmount());host.remove();delete desktopWindow.nowenDesktop;}
});

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

it('DCC-003: failed desktop download can open the remote workspace without losing retained edits or retrying in the background', async () => {
  vi.useFakeTimers();
  const edit=retainEdit('conflicted-note');
  updateItem(edit.id,{conflict:true,blocked:true,errorCode:'VERSION_CONFLICT',localPayload:edit.body});
  const retained=getQueue();
  state.flush.mockResolvedValue({ok:false,pending:1});
  localStorage.setItem('nowen-server-url','https://nas.test');
  localStorage.setItem('nowen-token','remote-token');
  const migrate=vi.fn(async()=>({ok:false,error:'fetch failed'}));
  const desktopWindow=window as unknown as {nowenDesktop?:object};
  desktopWindow.nowenDesktop={isDesktop:true,getAppInfo:async()=>({runtime:'remote',localRuntimeAvailable:true}),startLiteMigration:migrate};
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try {
    await act(async()=>{root.render(<DesktopOfflineSyncGate><span>editor</span></DesktopOfflineSyncGate>);});
    expect(host.textContent).not.toContain('editor');
    expect(host.textContent).toContain('offlineAvailability.onlineOnlyHint');
    const online=[...host.querySelectorAll('button')].find(button=>button.textContent==='offlineAvailability.continueOnline');
    expect(online).toBeDefined();
    await act(async()=>online!.click());
    expect(host.textContent).toBe('editor');
    expect(getQueue()).toEqual(retained);
    expect(localStorage.getItem('nowen-server-url')).toBe('https://nas.test');
    expect(localStorage.getItem('nowen-token')).toBe('remote-token');
    await act(async()=>{vi.advanceTimersByTime(15_000);window.dispatchEvent(new Event('online'));});
    expect(migrate).not.toHaveBeenCalled();
    expect(state.flush).toHaveBeenCalledOnce();
  } finally {act(()=>root.unmount());host.remove();delete desktopWindow.nowenDesktop;}
});

it('failed desktop download offers manual retry and prevents online handoff during an active retry', async () => {
  vi.useFakeTimers();
  let resolveRetry!: (value:{ok:boolean;error:string})=>void;
  const migrate=vi.fn().mockResolvedValueOnce({ok:false,error:'fetch failed'})
    .mockImplementationOnce(()=>new Promise(resolve=>{resolveRetry=resolve;}));
  const desktopWindow=window as unknown as {nowenDesktop?:object};
  desktopWindow.nowenDesktop={isDesktop:true,getAppInfo:async()=>({runtime:'remote',localRuntimeAvailable:true}),startLiteMigration:migrate};
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try {
    await act(async()=>{root.render(<DesktopOfflineSyncGate><span>editor</span></DesktopOfflineSyncGate>);});
    const button=(key:string)=>[...host.querySelectorAll('button')].find(item=>item.textContent===key)!;
    expect(button('offlineAvailability.retryLegacyEdits')).toBeDefined();
    await act(async()=>button('offlineAvailability.retryLegacyEdits').click());
    expect(migrate).toHaveBeenCalledTimes(2);
    expect(migrate).toHaveBeenLastCalledWith('https://nas.test','remote-token');
    expect(button('offlineAvailability.continueOnline').disabled).toBe(true);
    await act(async()=>{button('offlineAvailability.continueOnline').click();vi.advanceTimersByTime(5_000);});
    expect(host.textContent).not.toContain('editor');
    expect(migrate).toHaveBeenCalledTimes(2);
    await act(async()=>resolveRetry({ok:false,error:'still offline'}));
    expect(button('offlineAvailability.continueOnline').disabled).toBe(false);
    await act(async()=>button('offlineAvailability.continueOnline').click());
    expect(host.textContent).toBe('editor');
    await act(async()=>vi.advanceTimersByTime(15_000));
    expect(migrate).toHaveBeenCalledTimes(2);
  } finally {act(()=>root.unmount());host.remove();delete desktopWindow.nowenDesktop;}
});

it('DCC-005: shows live desktop download stages and actual attachment progress without claiming a completed local copy', async () => {
  vi.useFakeTimers();
  const getProgress=vi.fn().mockResolvedValue({ok:true,progress:{stage:'downloading',downloaded:120,applied:100}});
  const migrate=vi.fn(()=>new Promise(()=>{}));
  const desktopWindow=window as unknown as {nowenDesktop?:object};
  desktopWindow.nowenDesktop={isDesktop:true,getAppInfo:async()=>({runtime:'remote',localRuntimeAvailable:true}),startLiteMigration:migrate,getLiteMigrationProgress:getProgress};
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try {
    await act(async()=>{root.render(<DesktopOfflineSyncGate><span>editor</span></DesktopOfflineSyncGate>);});
    const bar=()=>host.querySelector('[role="progressbar"]')!;
    expect(bar()).not.toBeNull();
    expect(bar().hasAttribute('aria-valuenow')).toBe(false);
    expect(host.textContent).toContain('offlineAvailability.downloadStages.downloading');
    expect(host.textContent).toContain('"downloaded":120,"applied":100');
    getProgress.mockResolvedValue({ok:true,progress:{stage:'attachments',downloaded:140,applied:140,attachmentsDone:4,attachmentsPending:6}});
    await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
    expect(bar().getAttribute('aria-valuenow')).toBe('40');
    expect(host.textContent).toContain('"done":4,"total":10');
    getProgress.mockResolvedValue({ok:true,progress:{stage:'verifying',downloaded:140,applied:140,attachmentsDone:10,attachmentsPending:0}});
    await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
    expect(bar().hasAttribute('aria-valuenow')).toBe(false);
    expect(host.textContent).toContain('offlineAvailability.downloadStages.verifying');
    getProgress.mockResolvedValue({ok:true,progress:{stage:'complete'}});
    await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
    expect(host.textContent).not.toContain('editor');
    expect(bar().hasAttribute('aria-valuenow')).toBe(false);
  } finally {act(()=>root.unmount());host.remove();delete desktopWindow.nowenDesktop;}
  const calls=getProgress.mock.calls.length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(getProgress).toHaveBeenCalledTimes(calls);
});

it('a failed progress read does not fail the download and late polling results cannot replace a failed download', async () => {
  vi.useFakeTimers();
  let finish!: (value:{ok:boolean;error:string})=>void;
  let finishPoll!: (value:unknown)=>void;
  const getProgress=vi.fn().mockRejectedValueOnce(new Error('progress temporarily unavailable'))
    .mockImplementationOnce(()=>new Promise(resolve=>{finishPoll=resolve;}));
  const desktopWindow=window as unknown as {nowenDesktop?:object};
  desktopWindow.nowenDesktop={isDesktop:true,getAppInfo:async()=>({runtime:'remote',localRuntimeAvailable:true}),startLiteMigration:()=>new Promise(resolve=>{finish=resolve;}),getLiteMigrationProgress:getProgress};
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  try {
    await act(async()=>{root.render(<DesktopOfflineSyncGate><span>editor</span></DesktopOfflineSyncGate>);});
    expect(host.textContent).not.toContain('progress temporarily unavailable');
    await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
    await act(async()=>finish({ok:false,error:'download failed'}));
    await act(async()=>finishPoll({ok:true,progress:{stage:'attachments',attachmentsDone:10,attachmentsPending:0}}));
    expect(host.textContent).toContain('download failed');
    expect(host.textContent).not.toContain('"done":10');
    const online=[...host.querySelectorAll('button')].find(button=>button.textContent==='offlineAvailability.continueOnline')!;
    await act(async()=>online.click());
    await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
    expect(getProgress).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe('editor');
  } finally {act(()=>root.unmount());host.remove();delete desktopWindow.nowenDesktop;}
});

async function mountFailingGate(migrateResult:unknown) {
  vi.useFakeTimers();
  const migrate=vi.fn().mockResolvedValue(migrateResult);
  const reset=vi.fn().mockResolvedValue({ok:true,token:'local-token'});
  const desktopWindow=window as unknown as {nowenDesktop?:object};
  desktopWindow.nowenDesktop={isDesktop:true,getAppInfo:async()=>({runtime:'remote',localRuntimeAvailable:true}),startLiteMigration:migrate,resetLocalAuth:reset};
  localStorage.setItem('nowen-token','remote-token');
  const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
  await act(async()=>{root.render(<DesktopOfflineSyncGate><span>editor</span></DesktopOfflineSyncGate>);});
  return {
    host,migrate,reset,
    recoverButton:()=>[...host.querySelectorAll('button')].find(item=>item.textContent==='offlineAvailability.recoverLocalAccount'),
    cleanup:()=>{act(()=>root.unmount());host.remove();delete desktopWindow.nowenDesktop;},
  };
}

async function expectRecoveryOffered(code:string) {
  const gate=await mountFailingGate({ok:false,error:code});
  try {
    expect(gate.host.textContent).toContain('offlineAvailability.localAccountRecoveryHint');
    expect(gate.recoverButton()).toBeDefined();
    await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
    expect(gate.migrate).toHaveBeenCalledOnce();
    expect(gate.reset).not.toHaveBeenCalled();
    expect(gate.host.textContent).not.toContain('editor');
  } finally {gate.cleanup();}
}

it('DCC-006: a disabled local account is offered confirmed recovery instead of silent retries', () => expectRecoveryOffered('LOCAL_ACCOUNT_DISABLED'));

it('DCC-006: a locked local account is offered confirmed recovery instead of silent retries', () => expectRecoveryOffered('ACCOUNT_LOCKED'));

it('DCC-006: a transient local backend failure explains itself and keeps retrying without offering a reset', async () => {
  const gate=await mountFailingGate({ok:false,error:'BACKEND_UNAVAILABLE'});
  try {
    expect(gate.host.textContent).toContain('offlineAvailability.localAccountUnavailableHint');
    expect(gate.host.textContent).toContain('BACKEND_UNAVAILABLE');
    expect(gate.recoverButton()).toBeUndefined();
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(gate.migrate.mock.calls.length).toBeGreaterThan(1);
    expect(gate.reset).not.toHaveBeenCalled();
  } finally {gate.cleanup();}
});

const structuralFailure = {
  ok: false,
  progress: {
    stage: 'failed',
    error: '同步数据的目录或引用结构与本机不一致（NOTEBOOK_PARENT_NOT_FOUND），已停止自动重试。',
    errorCode: 'DATA_STRUCTURE',
    retryable: false,
    diagnostic: { stage: 'lite-migration:applying', step: 'notebook.link', reason: 'NOTEBOOK_PARENT_NOT_FOUND', sqliteCode: 'SQLITE_CONSTRAINT_TRIGGER', parentState: 'deleted' },
  },
};

it('DCC-003: a structural download failure stops the 5-second retry loop and the online-event retry, and shows redacted diagnostics', async () => {
  const gate=await mountFailingGate(structuralFailure);
  const button=(key:string)=>[...gate.host.querySelectorAll('button')].find(item=>item.textContent===key);
  try {
    expect(gate.migrate).toHaveBeenCalledOnce();
    expect(gate.host.textContent).toContain('NOTEBOOK_PARENT_NOT_FOUND');
    expect(gate.host.textContent).toContain('offlineAvailability.structureHint');
    expect(gate.host.textContent).not.toContain('offlineAvailability.onlineOnlyHint');
    expect(gate.host.textContent).toContain('DATA_STRUCTURE · lite-migration:applying · notebook.link · NOTEBOOK_PARENT_NOT_FOUND · SQLITE_CONSTRAINT_TRIGGER · parent=deleted');
    await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);window.dispatchEvent(new Event('online'));});
    expect(gate.migrate).toHaveBeenCalledOnce();
    expect(gate.host.textContent).not.toContain('editor');
    expect(button('offlineAvailability.continueOnline')?.disabled).toBe(false);
  } finally {gate.cleanup();}
});

it('DCC-003: after a structural failure the user can still retry by hand once the data is repaired, and a retryable failure keeps its automatic retry', async () => {
  const gate=await mountFailingGate(structuralFailure);
  const button=(key:string)=>[...gate.host.querySelectorAll('button')].find(item=>item.textContent===key)!;
  try {
    gate.migrate.mockResolvedValueOnce({ok:false,error:'fetch failed'});
    await act(async()=>button('offlineAvailability.retryLegacyEdits').click());
    expect(gate.migrate).toHaveBeenCalledTimes(2);
    // 这次是可重试的失败（断网）：自动重试恢复，且提示回到"稍后重试"的说法。
    expect(gate.host.textContent).toContain('offlineAvailability.onlineOnlyHint');
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(gate.migrate.mock.calls.length).toBeGreaterThan(2);
  } finally {gate.cleanup();}
});

it('DCC-003: a legacy backend that does not report retryable keeps the previous retrying behavior', async () => {
  const gate=await mountFailingGate({ok:false,progress:{stage:'failed',error:'download interrupted'}});
  try {
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(gate.migrate.mock.calls.length).toBeGreaterThan(1);
  } finally {gate.cleanup();}
});
