import { relationalStore } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { NativeResult } from './NativeTypes';

export interface DatabaseOptions {
  database: string;
  statement?: string;
  statements?: string;
  values?: relationalStore.ValueType[];
  encrypted?: boolean;
  dbNames?: string[];
}

// Keep SQL, migrations, account binding and transaction ownership in the shared
// NativeDatabase/Repository. This adapter only supplies the SQLite transport.
export class HarmonyDatabase {
  private stores: Map<string, relationalStore.RdbStore> = new Map();
  private opened: Set<string> = new Set();
  private transactions: Set<string> = new Set();

  private context: common.UIAbilityContext;
  constructor(context: common.UIAbilityContext) { this.context = context; }

  async call(method: string, options: DatabaseOptions): Promise<NativeResult> {
    if (method === 'checkConnectionsConsistency') {
      const expected = options.dbNames || [];
      let consistent = expected.every((name: string) => this.stores.has(name));
      for (const name of this.stores.keys()) {
        if (!expected.includes(name)) {
          const store = this.stores.get(name)!;
          if (this.transactions.has(name)) store.rollBack();
          await store.close(); this.stores.delete(name); this.opened.delete(name); this.transactions.delete(name);
          consistent = false;
        }
      }
      return { result: consistent };
    }
    if (!/^nowen_local_[a-f0-9]{16}$/.test(options.database)) throw new Error('Invalid account database');
    const name = options.database;
    if (method === 'createConnection') {
      if (options.encrypted) throw new Error('Encrypted database mode is not supported');
      if (!this.stores.has(name)) {
        this.stores.set(name, await relationalStore.getRdbStore(this.context, {
          name: name + '.db', securityLevel: relationalStore.SecurityLevel.S1,
        }));
      }
      return {};
    }
    if (method === 'isDBOpen') return { result: this.opened.has(name) };
    const store = this.stores.get(name);
    if (!store) throw new Error('Database connection is not available');
    if (method === 'open') { this.opened.add(name); return {}; }
    if (method === 'close' || method === 'closeConnection') {
      if (this.transactions.has(name)) { store.rollBack(); this.transactions.delete(name); }
      await store.close(); this.stores.delete(name); this.opened.delete(name); return {};
    }
    if (!this.opened.has(name)) throw new Error('Database is closed');
    const sql = options.statement || options.statements || '';
    const values = options.values || [];
    if (method === 'query') {
      const result = await store.querySql(sql, values);
      const rows: Record<string, relationalStore.ValueType>[] = [];
      try {
        while (result.goToNextRow()) {
          const row: Record<string, relationalStore.ValueType> = {};
          result.columnNames.forEach((column: string, index: number) => {
            row[column] = result.isColumnNull(index) ? null : result.getValue(index);
          });
          rows.push(row);
        }
      } finally { result.close(); }
      return { values: rows };
    }
    if (method === 'execute' || method === 'run') {
      const command = sql.trim().replace(/;$/, '').toUpperCase();
      if (command === 'BEGIN IMMEDIATE' || command === 'BEGIN') { store.beginTransaction(); this.transactions.add(name); }
      else if (command === 'COMMIT') { store.commit(); this.transactions.delete(name); }
      else if (command === 'ROLLBACK') { store.rollBack(); this.transactions.delete(name); }
      else if (method === 'run') {
        // querySql uses the reader pool, so SELECT changes()/last_insert_rowid()
        // there cannot report the preceding writer's result. execute returns
        // the writer's row id for our single-row INSERTs, or affected row count.
        const result = await store.execute(sql, values);
        if (/^(INSERT|REPLACE)\b/.test(command)) {
          const lastId = Number(result);
          return { changes: { changes: lastId >= 0 ? 1 : 0, lastId } };
        }
        return { changes: { changes: typeof result === 'number' ? result : 0 } };
      } else await store.executeSql(sql, values);
      return { changes: { changes: 0 } };
    }
    throw new Error('Unsupported database operation');
  }
}
