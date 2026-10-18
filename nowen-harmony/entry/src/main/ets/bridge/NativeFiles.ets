import { fileIo as fs } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { NativeResult } from './NativeTypes';

export interface FileOptions {
  path: string;
  from?: string;
  to?: string;
  directory?: string;
  toDirectory?: string;
  data?: string;
  encoding?: string;
  recursive?: boolean;
  offset?: number;
  chunkSize?: number;
}

export class HarmonyFiles {
  private base64: util.Base64Helper = new util.Base64Helper();
  private context: common.UIAbilityContext;
  constructor(context: common.UIAbilityContext) { this.context = context; }

  path(value: string, directory: string = 'DATA'): string {
    if (!['DATA', 'CACHE'].includes(directory)) throw new Error('Unsupported storage directory');
    const root = directory === 'CACHE' ? this.context.cacheDir : this.context.filesDir;
    const relative = value.startsWith('file://') ? value.substring(7) : value;
    if (relative.startsWith('/')) {
      if (!relative.startsWith(root + '/')) throw new Error('File outside application storage');
    }
    if (relative.indexOf('\\') >= 0 || relative.indexOf('\0') >= 0 || relative.split('/').includes('..')) {
      throw new Error('Invalid file path');
    }
    return relative.startsWith('/') ? relative : root + '/' + relative;
  }

  private info(path: string, name: string = ''): NativeResult {
    const stat = fs.statSync(path);
    return { name, type: stat.isDirectory() ? 'directory' : 'file', size: stat.size,
      mtime: stat.mtime * 1000, ctime: stat.ctime * 1000, uri: 'file://' + path };
  }

  read(path: string, offset: number = 0, length?: number): Uint8Array {
    const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
    try {
      const size = fs.statSync(path).size;
      const count = Math.max(0, Math.min(length === undefined ? size : length, size - offset));
      const data = new ArrayBuffer(count);
      if (count === 0) return new Uint8Array(data);
      const actual = fs.readSync(file.fd, data, { offset, length: count });
      return new Uint8Array(data, 0, actual);
    } finally { fs.closeSync(file); }
  }

  async call(method: string, options: FileOptions): Promise<NativeResult> {
    if (method === 'rename' && !options.from) throw new Error('Missing rename source');
    const path = this.path(method === 'rename' ? options.from! : options.path, options.directory);
    try {
      if (method === 'mkdir') { fs.mkdirSync(path, options.recursive === true); return {}; }
      if (method === 'rmdir') { fs.rmdirSync(path); return {}; }
      if (method === 'stat') return this.info(path);
      if (method === 'getUri') return { uri: 'file://' + path };
      if (method === 'readdir') {
        return { files: fs.listFileSync(path).map((name: string) => this.info(path + '/' + name, name)) };
      }
      if (method === 'deleteFile') { fs.unlinkSync(path); return {}; }
      if (method === 'rename') {
        fs.renameSync(path, this.path(options.to || '', options.toDirectory || options.directory)); return {};
      }
      if (method === 'writeFile' || method === 'appendFile') {
        const parent = path.substring(0, path.lastIndexOf('/'));
        if (options.recursive && !fs.accessSync(parent)) fs.mkdirSync(parent, true);
        const data = options.encoding ? new util.TextEncoder().encodeInto(options.data || '')
          : this.base64.decodeSync(options.data || '');
        const mode = fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY
          | (method === 'appendFile' ? fs.OpenMode.APPEND : fs.OpenMode.TRUNC);
        const file = fs.openSync(path, mode);
        try {
          const count = fs.writeSync(file.fd, data.buffer as ArrayBuffer);
          if (count !== data.byteLength) throw new Error('Incomplete file write');
          fs.fsyncSync(file.fd);
        } finally { fs.closeSync(file); }
        return { uri: 'file://' + path };
      }
      if (method === 'readFile' || method === 'readChunk') {
        const bytes = this.read(path, options.offset || 0,
          method === 'readChunk' ? Math.min(options.chunkSize || 196608, 1048576) : undefined);
        return { data: options.encoding ? util.TextDecoder.create('utf-8').decodeToString(bytes)
          : (bytes.byteLength ? this.base64.encodeToStringSync(bytes) : ''), bytes: bytes.byteLength };
      }
    } catch (error) {
      // Capacitor's missing-file code is used by attachment recovery; distinguish
      // genuine absence from permission, quota and write failures.
      if (!fs.accessSync(path) && ['stat', 'readFile', 'readChunk', 'deleteFile', 'readdir'].includes(method)) {
        throw new Error('OS-PLUG-FILE-0008');
      }
      throw error as Error;
    }
    throw new Error('Unsupported filesystem operation');
  }
}
