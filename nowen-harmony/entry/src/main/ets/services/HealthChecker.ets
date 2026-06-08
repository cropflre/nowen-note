/**
 * HealthChecker - 服务端连通性校验
 *
 * 使用 @ohos.net.http 进行 HTTP 请求（ArkTS 标准方式）。
 * fetch() 在部分鸿蒙版本可能不稳定，http 模块更可靠。
 */
import { http } from '@kit.NetworkKit';

/** 健康检查结果 */
export interface HealthCheckResult {
  ok: boolean;
  version?: string;
  error?: string;
}

/**
 * 校验服务端连通性
 * @param serverUrl 服务端地址（不含尾部斜杠）
 * @param timeoutMs 超时毫秒数
 */
export async function checkServerHealth(
  serverUrl: string,
  timeoutMs: number = 8000
): Promise<HealthCheckResult> {
  const url = `${serverUrl}/api/health`;
  let httpRequest: http.HttpRequest | null = null;

  try {
    httpRequest = http.createHttp();

    const response = await httpRequest.request(
      url,
      {
        method: http.RequestMethod.GET,
        readTimeout: timeoutMs,
        connectTimeout: timeoutMs,
        header: {
          'Accept': 'application/json',
        },
        expectDataType: http.HttpDataType.OBJECT,
      }
    );

    if (response.responseCode === 200) {
      const data = response.result as Record<string, string>;
      return {
        ok: true,
        version: data?.version || data?.status || '',
      };
    } else {
      return {
        ok: false,
        error: `HTTP ${response.responseCode}`,
      };
    }
  } catch (err) {
    const errMsg = JSON.stringify(err);
    if (errMsg.includes('timeout') || errMsg.includes('Timeout')) {
      return { ok: false, error: '连接超时，请检查地址和网络' };
    }
    return { ok: false, error: `连接失败: ${errMsg.substring(0, 100)}` };
  } finally {
    if (httpRequest) {
      httpRequest.destroy();
    }
  }
}
