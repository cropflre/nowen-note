/**
 * mDNS / Bonjour 服务广播
 *
 * 目的：让局域网内的桌面客户端 / 移动客户端能"免输入"发现本服务端，
 * 避免用户手动记忆/敲打 IP:PORT。
 *
 * 协议约定（对客户端是公开契约，改动需谨慎）：
 *   - service type:  _nowen-note._tcp.local.
 *   - port:          真实 HTTP 监听端口
 *   - txt:
 *       v    = 服务端版本（如 "1.0.2"）
 *       path = HTTP 基路径（预留，目前恒为 "/"，便于将来反代到子路径）
 *       name = 人类可读的实例名（默认取 hostname）
 *       https= "0" | "1" （预留，目前恒为 "0"；客户端按 https:// 拼接）
 *
 * 失败策略：mDNS 在部分企业 AP / 容器网络下会被拦截。这里**不让广播失败影响主
 * 流程**——任何异常都只打 warn，服务端继续跑，客户端改手动输入即可。
 */

import os from "os";

// 延迟 require，避免该可选依赖缺失时直接 crash 服务端。
// bonjour-service 是纯 JS（dns-sd socket 基于 dgram），在 Node 与 Electron 里都能跑。
let bonjourInstance: any = null;
let publishedService: any = null;

export interface PublishOptions {
  port: number;
  version: string;
  /** 实例名，默认 `nowen-note@${hostname}` */
  name?: string;
}

/**
 * 启动 mDNS 广播。返回是否成功。重复调用会先停掉旧的。
 *
 * 重名策略：
 *   - 默认 name = `nowen-note@${hostname}`。
 *   - 同机多实例（Electron 内嵌 backend + Node dev、或两个 dev）会因 name 完全相同
 *     而被 bonjour-service 的 probe 判定为冲突，抛 "Service name is already in use
 *     on the network"。
 *   - 这里把端口拼进 name —— `nowen-note@${hostname}:${port}`，同机同端口只可能有
 *     一份，冲突概率骤降；真还冲突则交给下面的 error 回调兜底（仅 warn，不影响主
 *     流程）。如果用户显式传了 name，则尊重用户选择，不自动追加端口。
 */
export function publishMdns(opts: PublishOptions): boolean {
  stopMdns();

  try {
    // 使用 require 而非 import，原因：
    //   1. 该包可能未安装（用户精简部署）
    //   2. CJS 导出在 ESM 下拿的是 default 引用，require 更直接
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Bonjour } = require("bonjour-service");
    bonjourInstance = new Bonjour();

    const hostname = os.hostname() || "nowen-note";
    // 端口作为天然去重维度拼进 name，避免同机多实例 probe 冲突
    const name = opts.name || `nowen-note@${hostname}:${opts.port}`;

    publishedService = bonjourInstance.publish({
      // 注意：bonjour-service 要求 type 不带下划线前缀和 ._tcp 后缀，它内部会拼
      name,
      type: "nowen-note",
      protocol: "tcp",
      port: opts.port,
      txt: {
        v: opts.version,
        path: "/",
        https: "0",
        // txt 里回传 hostname + port，便于客户端展示人类可读名字
        name: `nowen-note@${hostname}`,
        port: String(opts.port),
      },
    });

    // 防御性订阅：bonjour-service 1.2.x 的 registry 在 probe 到重名时其实是
    // `console.log(new Error(...))` 直接打印错误对象（并不 throw、也不 emit），
    // 所以这里的 'error' 监听在当前版本收不到；保留是为了将来版本改成 emit-error
    // 后能无缝兜住，不至于变成 unhandled error。
    publishedService.on?.("error", (err: unknown) => {
      const msg = (err as Error)?.message || String(err);
      if (/already in use/i.test(msg)) {
        console.warn(
          `[discovery] mDNS name "${name}" 已被占用（可能是同机另一实例/Electron 客户端），` +
            `本实例不对外广播，服务继续运行。`,
        );
      } else {
        console.warn("[discovery] mdns publish error:", msg);
      }
      // 出错后主动清掉句柄，避免 stopMdns 时对已 teardown 的 service 再操作
      try {
        publishedService?.stop?.();
      } catch {
        /* ignore */
      }
      publishedService = null;
    });

    console.log(
      `[discovery] mDNS published: _nowen-note._tcp.local. name="${name}" port=${opts.port}`,
    );
    return true;
  } catch (err) {
    // 最常见：bonjour-service 未装 / UDP 5353 被占 / 无网络接口
    console.warn(
      "[discovery] mDNS publish failed (服务将继续，仅无法自动发现):",
      (err as Error)?.message || err,
    );
    return false;
  }
}

export function stopMdns(): void {
  try {
    if (publishedService) {
      publishedService.stop?.();
      publishedService = null;
    }
    if (bonjourInstance) {
      bonjourInstance.destroy?.();
      bonjourInstance = null;
    }
  } catch (err) {
    console.warn("[discovery] mdns stop failed:", err);
  }
}
