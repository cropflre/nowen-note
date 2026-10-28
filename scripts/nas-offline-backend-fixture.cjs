const { Server } = require('node:net');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const directory = path.resolve(process.env.NOWEN_NAS_OFFLINE_PROFILE || '');
if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('nowen-nas-offline-')) throw new Error('An isolated offline acceptance profile is required');
const isLoopback = hostname => ['127.0.0.1','localhost','::1','[::1]'].includes(hostname);
function assertLocal(input) {
  const hostname = typeof input === 'string' || input instanceof URL ? new URL(input).hostname
    : input?.url ? new URL(input.url).hostname : input?.hostname || input?.host || 'localhost';
  if (!isLoopback(hostname)) throw new Error('Acceptance network is restricted to loopback');
}
const fetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  assertLocal(input);
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const marker = path.join(directory,'snapshot-outage-injected');
  if (process.env.NOWEN_NAS_OFFLINE_INTERRUPT === '1' && url.pathname === '/api/sync/v2/snapshot' && !fs.existsSync(marker)) {
    fs.writeFileSync(marker,'injected');
    console.warn('[offline-acceptance] injected first-download outage');
    return Promise.resolve(new Response(JSON.stringify({error:'isolated test interruption'}),{status:503}));
  }
  return fetch(input, ...args);
};
for (const module of [http,https]) for (const method of ['get','request']) {
  const original = module[method];
  module[method] = function (input,...args) { assertLocal(input); return original.call(this,input,...args); };
}
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  args[1] = '127.0.0.1';
  this.prependListener('request',(request,response)=>response.once('finish',()=>{
    if(response.statusCode !== 401)return;
    let userId='none';try{userId=JSON.parse(Buffer.from((request.headers.authorization||'').split('.')[1],'base64url').toString()).userId;}catch{}
    console.warn('[offline-auth-denied]',request.url,'user='+userId);
  }));
  return Reflect.apply(listen, this, args);
};
