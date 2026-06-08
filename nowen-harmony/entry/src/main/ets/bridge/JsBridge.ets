/**
 * JsBridge - ArkTS ↔ WebView 双向通信协议
 */

interface BridgeMessage {
  __harmony_bridge: boolean;
  event: string;
  data: Record<string, Object>;
  ts: number;
}

interface BridgeResult {
  event: string;
  data: Record<string, Object>;
}

/** 生成注入到 WebView 的桥接脚本 */
export function getInjectScript(): string {
  return `(function(){
if(window.__harmonyBridge__)return;
var _l={};
var b={
  isHarmonyOS:true,version:'1.0.0',
  postMessage:function(e,d){
    console.log('[HARMONY_BRIDGE]'+JSON.stringify({__harmony_bridge:true,event:e,data:d||{},ts:Date.now()}));
  },
  on:function(e,c){if(!_l[e])_l[e]=[];_l[e].push(c);},
  off:function(e,c){if(!_l[e])return;if(!c){delete _l[e];return;}_l[e]=_l[e].filter(function(x){return x!==c;});},
  _dispatch:function(e,d){var c=_l[e]||[];for(var i=0;i<c.length;i++){try{c[i](d);}catch(err){}}},
  getNetworkType:function(){return new Promise(function(r){b.on('__netResp',function h(d){b.off('__netResp',h);r(d.type);});b.postMessage('getNetworkType');});},
  pickFile:function(o){return new Promise(function(r,j){b.on('__fileResp',function h(d){b.off('__fileResp',h);if(d.error)j(new Error(d.error));else r(d);});b.postMessage('pickFile',o||{});});},
  clearServerConfig:function(){b.postMessage('clearServerConfig');}
};
window.__harmonyBridge__=b;window.__HARMONY__=true;
})();true;`;
}

/** 解析来自 WebView onConsole 的桥接消息 */
export function parseBridgeMessage(message: string): BridgeResult | null {
  if (!message || message.length < 17) {
    return null;
  }
  const prefix = '[HARMONY_BRIDGE]';
  if (message.indexOf(prefix) !== 0) {
    return null;
  }
  try {
    const json: string = message.substring(prefix.length);
    const parsed: BridgeMessage = JSON.parse(json) as BridgeMessage;
    if (parsed && parsed.__harmony_bridge === true) {
      const result: BridgeResult = { event: parsed.event, data: parsed.data };
      return result;
    }
  } catch {
    // ignore
  }
  return null;
}

/** 生成派发事件到 WebView 的 JS 代码 */
export function buildDispatchScript(eventName: string, data: Object): string {
  const dataJson: string = JSON.stringify(data);
  return 'window.__harmonyBridge__&&window.__harmonyBridge__._dispatch(' + JSON.stringify(eventName) + ',' + dataJson + ');true;';
}