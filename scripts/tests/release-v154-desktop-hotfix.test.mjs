import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRemoteBaseline, assertRemoteStable, WINDOWS, MACOS, REPLACEMENTS,
  ORIGINAL_TAG_COMMIT, TAG,
} from '../release-v154-desktop-hotfix.mjs';
const tagRef={object:{sha:ORIGINAL_TAG_COMMIT,type:'commit'}};
const fakeAssets=()=>[...REPLACEMENTS,'Nowen-Note-1.5.4.apk','latest-linux.yml'].map((name,i)=>({
  id:i+1,name,size:100+i,digest:`sha256:${'a'.repeat(64)}`,
}));
const release=()=>({tag_name:TAG,draft:false,prerelease:false,assets:fakeAssets()});
test('exact Windows Full/Lite and macOS Intel/Apple Silicon asset matrix',()=>{
  assert.equal(WINDOWS.length,8);
  assert.equal(MACOS.length,9);
  assert.equal(REPLACEMENTS.length,17);
  assert.equal(new Set(REPLACEMENTS).size,17);
});
test('reject moved v1.5.4 tag and absent desktop assets',()=>{
  assert.doesNotThrow(()=>assertRemoteBaseline(release(),tagRef));
  assert.throws(()=>assertRemoteBaseline(release(),{object:{sha:'b'.repeat(40),type:'commit'}}),/tag was moved/);
  const missing=release();missing.assets=missing.assets.filter(x=>x.name!==MACOS[0]);
  assert.throws(()=>assertRemoteBaseline(missing,tagRef),/Missing original asset/);
});
test('only approved desktop files can change in existing Release',()=>{
  const a=release(),b=release();
  b.assets.find(x=>x.name===WINDOWS[0]).digest=`sha256:${'c'.repeat(64)}`;
  assert.doesNotThrow(()=>assertRemoteStable(a,b));
  b.assets.find(x=>x.name==='Nowen-Note-1.5.4.apk').digest=`sha256:${'c'.repeat(64)}`;
  assert.throws(()=>assertRemoteStable(a,b),/Unrelated Release asset/);
});
