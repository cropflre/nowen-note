import { relationalStore } from '@kit.ArkData';

interface SqlChanges { changes: number; lastId?: number; }

// Wire results for the existing Capacitor interfaces. ArkTS requires explicit
// object shapes, including nested SQLite changes and filesystem entry metadata.
export interface NativeResult {
  result?: boolean;
  values?: Record<string, relationalStore.ValueType>[];
  changes?: SqlChanges;
  uri?: string;
  files?: NativeResult[];
  name?: string;
  type?: string;
  size?: number;
  mtime?: number;
  ctime?: number;
  data?: Object;
  bytes?: number;
  value?: Object | null;
  removed?: boolean;
  status?: number;
  headers?: Object;
  url?: string;
  connected?: boolean;
  connectionType?: string;
  isActive?: boolean;
  id?: string;
  version?: string;
  build?: string;
}

export interface NativeFailure { message: string; code: string; }
export interface NativeEvent {
  keyboardHeight?: number;
  connected?: boolean;
  connectionType?: string;
  isActive?: boolean;
}
