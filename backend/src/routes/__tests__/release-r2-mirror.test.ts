import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchVerifiedR2Mirror,
  validateMirrorManifest,
  isMirrorEligibleName
} from "../release-r2-mirror.js";

const tag="v1.5.5";
const all=[
"Nowen-Note-1.5.5-setup.exe",
"Nowen-Note-1.5.5-arm64.dmg",
"Nowen-Note-1.5.5-x64.dmg",
"Nowen-Note-1.5.5-x86_64.AppImage",
"Nowen-Note-1.5.5-amd64.deb",
"Nowen-Note-1.5.5.apk",
"nowen-note-1.5.5-fpk-r1.fpk",
"nowen-clipper-0.5.0-edge.zip",
"nowen-clipper-0.5.0-firefox.zip",
"nowen-clipper-0.5.0.zip"
];
const release={tag,draft:false,prerelease:false,assets:[
 ...all, "Nowen-Note-1.5.5-portable.exe", "amd64_io.nowen.note_1.5.5.0001.upk"
].map((name,i)=>({
name,size:1000+i,browserDownloadUrl:
  "https://github.com/cropflre/nowen-note/releases/download/"+tag+"/"+name
}))};
const manifest={schema:1,version:tag,assets:all.map(name=>{
 const asset=release.assets.find(a=>a.name===name)!;
 return {name,size:asset.size};
})};

test("R2 only trusts the ten published installers, fnOS FPK and Clipper",()=>{
 const result=validateMirrorManifest(release,manifest);
 assert.equal(result.available,true);
 if(!result.available) return;
 assert.equal(result.assets.length,10);
 for(const asset of result.assets) {
   assert.equal(asset.downloadUrl,
     "https://download.nowen.cn/v1.5.5/"+asset.name);
 }
 for(const ignored of ["amd64_io.nowen.note_1.5.5.0001.upk","Nowen-Note-1.5.5-portable.exe"]) {
   assert.equal(isMirrorEligibleName(ignored,tag),false);
   assert.ok(!result.assets.some(a=>a.name===ignored));
 }
});

test("R2 missing, stale, tampered or mismatched manifests always fail closed",()=>{
 const mutations=[
 {},
 {...manifest,version:"v1.5.6"},
 {...manifest,assets:manifest.assets.slice(1)},
 {...manifest,assets:manifest.assets.map((a,i)=>i===0?{...a,size:a.size+1}:a)},
 {...manifest,assets:manifest.assets.map((a,i)=>i===0?{...a,name:"amd64_io.nowen.note_1.5.5.0001.upk"}:a)},
 {...manifest,assets:manifest.assets.map((a,i)=>i===0?manifest.assets[1]:a)}
 ];
 for(const input of mutations)assert.equal(validateMirrorManifest(release,input).available,false);
 assert.equal(validateMirrorManifest({...release,prerelease:true},manifest).available,false);
 assert.equal(validateMirrorManifest({...release,tag:"v1.5.6"},manifest).available,false);
 const malicious={...release,assets:release.assets.map((a,i)=>i===0?{...a,browserDownloadUrl:"https://evil.test/installer.exe"}:a)};
 assert.equal(validateMirrorManifest(malicious,manifest).available,false);
});

test("Mirror request errors and redirects cannot break GitHub downloads",async()=>{
 const ok=await fetchVerifiedR2Mirror(release,async () => new Response(JSON.stringify(manifest),{status:200}));
 assert.equal(ok.available,true);
 const missing=await fetchVerifiedR2Mirror(release,async()=>new Response("not found",{status:404}));
 assert.equal(missing.available,false);
 const broken=await fetchVerifiedR2Mirror(release,async()=>{throw new Error("network failure")});
 assert.equal(broken.available,false);
});
