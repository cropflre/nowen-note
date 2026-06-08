/**
 * NetworkMonitor - 网络状态监听
 *
 * 封装 @ohos.net.connection，提供网络状态检测。
 */
import { connection } from '@kit.NetworkKit';

export type NetworkType = 'wifi' | 'cellular' | 'none' | 'unknown';

/**
 * 获取当前网络类型
 * API 12 使用 getDefaultNet + getNetCapabilities
 */
export function getNetworkType(): NetworkType {
  try {
    const netHandle = connection.getDefaultNetSync();
    if (!netHandle || netHandle.netId === 0) {
      return 'none';
    }
    const caps = connection.getNetCapabilitiesSync(netHandle);
    if (!caps || !caps.bearerTypes) {
      return 'unknown';
    }
    // bearerTypes: NetBearType 枚举
    // 0 = BEARER_CELLULAR, 1 = BEARER_WIFI, ...
    const bearers = caps.bearerTypes;
    for (const b of bearers) {
      if (b === 1) return 'wifi';
      if (b === 0) return 'cellular';
    }
    return 'unknown';
  } catch (e) {
    console.warn('[NetworkMonitor] getNetworkType error:', JSON.stringify(e));
    return 'unknown';
  }
}

/** 判断是否有网络连接 */
export function isOnline(): boolean {
  const type = getNetworkType();
  return type !== 'none';
}
