import dns from "node:dns";

export type DnsFamily = 4 | 6;

type ResolveRecord = string | { address: string; ttl: number };
type ResolveCallback = (error: NodeJS.ErrnoException | null, records?: ResolveRecord[]) => void;
type ResolveFunction = (
  hostname: string,
  optionsOrCallback: unknown,
  callback?: ResolveCallback,
) => void;
type LookupAddress = { address: string; family: number };
type LookupFunction = (
  hostname: string,
  options: { all: true; family: DnsFamily; verbatim: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const INSTALL_MARKER = "__nowenSystemDnsLookupCompat";

function noDataError(hostname: string, family: DnsFamily): NodeJS.ErrnoException {
  const error = new Error(`No IPv${family} addresses found for ${hostname}`) as NodeJS.ErrnoException;
  error.code = "ENODATA";
  return error;
}

/**
 * Wrap dns.resolve4/resolve6 with a parallel dns.lookup fallback.
 *
 * dns.resolve* uses c-ares directly. In Docker, WSL, VPN and split-DNS
 * environments it can fail even though the operating-system resolver used by
 * fetch can resolve the same host. dns.lookup follows the system resolver, so
 * the first successful address list is returned to the existing SSRF checker
 * without weakening its private-IP rejection.
 */
export function createSystemLookupResolver(
  family: DnsFamily,
  originalResolve: ResolveFunction,
  lookup: LookupFunction = dns.lookup as unknown as LookupFunction,
): ResolveFunction {
  return function resolveWithSystemLookup(
    hostname: string,
    optionsOrCallback: unknown,
    callback?: ResolveCallback,
  ): void {
    const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
    const done = (typeof optionsOrCallback === "function" ? optionsOrCallback : callback) as ResolveCallback | undefined;
    if (typeof done !== "function") throw new TypeError("DNS resolve callback is required");

    let settled = false;
    let failures = 0;
    let firstError: NodeJS.ErrnoException | null = null;

    const succeed = (records: ResolveRecord[] | undefined) => {
      if (settled || !records?.length) return false;
      settled = true;
      done(null, records);
      return true;
    };

    const fail = (error: NodeJS.ErrnoException) => {
      if (settled) return;
      failures += 1;
      firstError ||= error;
      if (failures >= 2) {
        settled = true;
        done(firstError || error);
      }
    };

    const onResolve: ResolveCallback = (error, records) => {
      if (error) {
        fail(error);
        return;
      }
      if (!succeed(records)) fail(noDataError(hostname, family));
    };

    try {
      if (options === undefined) originalResolve(hostname, onResolve);
      else originalResolve(hostname, options, onResolve);
    } catch (error) {
      fail(error as NodeJS.ErrnoException);
    }

    try {
      lookup(hostname, { all: true, family, verbatim: true }, (error, addresses) => {
        if (error) {
          fail(error);
          return;
        }
        const unique = Array.from(new Set(addresses.map(({ address }) => address)));
        if (!unique.length) {
          fail(noDataError(hostname, family));
          return;
        }
        const wantsTtl = Boolean(options && typeof options === "object" && "ttl" in options && (options as { ttl?: boolean }).ttl);
        const records: ResolveRecord[] = wantsTtl
          ? unique.map((address) => ({ address, ttl: 0 }))
          : unique;
        succeed(records);
      });
    } catch (error) {
      fail(error as NodeJS.ErrnoException);
    }
  };
}

export function installSystemDnsLookupCompat(): void {
  const resolve4 = dns.resolve4 as typeof dns.resolve4 & { [INSTALL_MARKER]?: boolean };
  if (resolve4[INSTALL_MARKER]) return;

  const wrapped4 = createSystemLookupResolver(4, dns.resolve4.bind(dns) as unknown as ResolveFunction);
  const wrapped6 = createSystemLookupResolver(6, dns.resolve6.bind(dns) as unknown as ResolveFunction);
  Object.defineProperty(wrapped4, INSTALL_MARKER, { value: true });
  Object.defineProperty(wrapped6, INSTALL_MARKER, { value: true });

  dns.resolve4 = wrapped4 as unknown as typeof dns.resolve4;
  dns.resolve6 = wrapped6 as unknown as typeof dns.resolve6;
}
