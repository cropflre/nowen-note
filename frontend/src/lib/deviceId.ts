/**
 * 设备 ID 管理
 *
 * 用于会话去重：同一设备（浏览器 + localStorage）登录时复用 session，
 * 避免活跃会话列表无限膨胀。
 *
 * deviceId 存储在 localStorage，永久有效（除非用户清除浏览器数据）。
 */

const DEVICE_ID_KEY = "nowen-device-id";

/**
 * 获取当前设备的 deviceId。
 * 首次访问时自动生成并持久化。
 */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = generateDeviceId();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // localStorage 不可用时（隐私模式等），返回临时 ID
    return generateDeviceId();
  }
}

/**
 * 生成随机设备 ID。
 * 格式：dev_<时间戳base36>_<随机字符串>
 */
function generateDeviceId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `dev_${ts}_${rand}`;
}
