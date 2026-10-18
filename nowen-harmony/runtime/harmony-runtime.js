(function () {
  'use strict';
  if (window.location.origin !== 'https://localhost' || window.top !== window) return;
  const pending = new Map();
  const listeners = new Map();
  let sequence = 0;
  function request(plugin, method, options) {
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('原生操作超时，请重试'));
      }, plugin === 'CapacitorHttp' ? 600000 : 60000);
      pending.set(id, { resolve, reject, timer });
      try { window.NowenNative.postMessage(JSON.stringify({ id, plugin, method, options: options || {} })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  function emit(plugin, event, data) {
    for (const entry of listeners.values()) {
      if (entry.plugin === plugin && entry.event === event) entry.callback(data);
    }
  }
  window.__HARMONY__ = true;
  window.CapacitorCustomPlatform = { name: 'harmony' };
  window.__harmonyBridge__ = {
    isHarmonyOS: true, request,
    resolve(id, value, error) {
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id); clearTimeout(call.timer);
      if (error) { const failure = new Error(error.message); failure.code = error.code; call.reject(failure); }
      else call.resolve(value);
    },
    emit,
    async back() {
      // Let the shared Android handler consume overlays/editor/list in the same order.
      if (![...listeners.values()].some(entry => entry.plugin === 'App' && entry.event === 'backButton')) {
        await request('App', 'exitApp');
      } else emit('App', 'backButton', { canGoBack: history.length > 1 });
    },
    async seedServer(url) {
      if (url && !localStorage.getItem('nowen-server-url')) localStorage.setItem('nowen-server-url', url);
    },
  };
  const methods = {
    CapacitorSQLite: ['createConnection', 'closeConnection', 'checkConnectionsConsistency', 'open', 'close', 'isDBOpen', 'execute', 'query', 'run'],
    Filesystem: ['stat', 'mkdir', 'rmdir', 'writeFile', 'appendFile', 'readFile', 'deleteFile', 'rename', 'readdir', 'getUri', 'readFileInChunks'],
    CapacitorHttp: ['request', 'get', 'post', 'put', 'patch', 'delete'],
    App: ['exitApp', 'getInfo', 'getState'],
    Network: ['getStatus'],
    Keyboard: ['hide', 'setResizeMode', 'setScroll', 'setAccessoryBarVisible'],
    StatusBar: ['setOverlaysWebView', 'setStyle', 'setBackgroundColor', 'show', 'hide'],
    SplashScreen: ['hide'],
    Browser: ['open', 'close'],
  };
  window.Capacitor = {
    platform: 'harmony', isNativePlatform: () => true, getPlatform: () => 'harmony',
    convertFileSrc: path => path.startsWith('file://')
      ? 'https://localhost/_nowen_file_/' + encodeURIComponent(path.slice(7)) : path,
    PluginHeaders: Object.entries(methods).map(([name, names]) => ({ name, methods: [
      ...names.map(method => ({ name: method, rtype: method === 'readFileInChunks' ? 'callback' : 'promise' })),
      { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' },
    ] })),
    nativePromise(plugin, method, options) {
      if (method === 'removeListener') { listeners.delete(options.callbackId); return Promise.resolve(); }
      if (plugin === 'Keyboard' && method !== 'hide') return Promise.resolve();
      if (plugin === 'SplashScreen') return Promise.resolve();
      if (plugin === 'CapacitorHttp' && method !== 'request') return request(plugin, 'request', { ...options, method: method.toUpperCase() });
      return request(plugin, method, options);
    },
    nativeCallback(plugin, method, options, callback) {
      const id = 'listener-' + (++sequence);
      if (method === 'addListener') {
        listeners.set(id, { plugin, event: options.eventName, callback });
        return id;
      }
      if (plugin === 'Filesystem' && method === 'readFileInChunks') {
        (async () => {
          let offset = 0;
          while (true) {
            const chunk = await request('Filesystem', 'readChunk', { ...options, offset });
            callback({ data: chunk.data });
            if (!chunk.data) break;
            offset += chunk.bytes;
          }
        })().catch(error => callback(null, error));
        return id;
      }
      throw new Error('不支持的原生回调');
    },
  };
  document.addEventListener('visibilitychange', () => emit('App', 'appStateChange', { isActive: !document.hidden }));
  window.addEventListener('online', () => emit('Network', 'networkStatusChange', { connected: true, connectionType: 'unknown' }));
  window.addEventListener('offline', () => emit('Network', 'networkStatusChange', { connected: false, connectionType: 'none' }));
})();
