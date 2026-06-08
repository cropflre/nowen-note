/**
 * PreferenceStore - 持久化存储封装
 *
 * 使用 @ohos.data.preferences 做 key-value 持久化，
 * 替代 Web 端的 localStorage。
 */
import dataPreferences from '@ohos.data.preferences';

const STORE_NAME = 'nowen_note_prefs';
let preferences: dataPreferences.Preferences | null = null;

/** 初始化（必须在 UIAbility onCreate 中调用） */
export async function initPreferenceStore(context: Context): Promise<void> {
  try {
    preferences = await dataPreferences.getPreferences(context, STORE_NAME);
  } catch (err) {
    console.error('[PreferenceStore] init failed:', err);
  }
}

function getStore(): dataPreferences.Preferences {
  if (!preferences) {
    throw new Error('[PreferenceStore] not initialized, call initPreferenceStore first');
  }
  return preferences;
}

/** 读取字符串 */
export async function getString(key: string, defaultValue: string = ''): Promise<string> {
  try {
    const store = getStore();
    const val = await store.get(key, defaultValue);
    return val as string;
  } catch {
    return defaultValue;
  }
}

/** 写入字符串 */
export async function setString(key: string, value: string): Promise<void> {
  try {
    const store = getStore();
    await store.put(key, value);
    await store.flush();
  } catch (err) {
    console.error('[PreferenceStore] setString failed:', err);
  }
}

/** 删除 */
export async function remove(key: string): Promise<void> {
  try {
    const store = getStore();
    await store.delete(key);
    await store.flush();
  } catch (err) {
    console.error('[PreferenceStore] remove failed:', err);
  }
}
