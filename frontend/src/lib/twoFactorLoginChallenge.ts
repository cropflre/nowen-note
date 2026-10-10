export const TWO_FACTOR_LOGIN_CHALLENGE_EVENT = "nowen:two-factor-login-challenge";

const STORAGE_KEY = "nowen.twoFactorLoginChallenge";
const DEFAULT_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 5 * 60;

export interface TwoFactorLoginChallenge {
  ticket: string;
  username: string;
  verifyUrl: string;
  createdAt: number;
  expiresAt: number;
}

export type AuthEndpointKind = "login" | "verify";

let memoryChallenge: TwoFactorLoginChallenge | null = null;
let bridgeInstalled = false;

function emitChallengeChanged(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(TWO_FACTOR_LOGIN_CHALLENGE_EVENT));
  } catch {
    /* ignore */
  }
}

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readStoredChallenge(storage: Storage | null): string | null {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function isValidVerifyUrl(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("/")) return /\/(?:api|publicapi)\/auth\/2fa\/verify\/?$/.test(value);
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && /\/(?:api|publicapi)\/auth\/2fa\/verify\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizeTtlSeconds(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(30, Math.floor(parsed)));
}

function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input || "");
}

export function classifyTwoFactorAuthEndpoint(input: RequestInfo | URL): AuthEndpointKind | null {
  const raw = inputUrl(input);
  if (!raw) return null;
  try {
    const base = typeof window !== "undefined" ? window.location.href : "http://localhost/";
    const pathname = new URL(raw, base).pathname.replace(/\/+$/, "");
    if (/\/(?:api|publicapi)\/auth\/login$/.test(pathname)) return "login";
    if (/\/(?:api|publicapi)\/auth\/2fa\/verify$/.test(pathname)) return "verify";
  } catch {
    /* ignore */
  }
  return null;
}

export function deriveTwoFactorVerifyUrl(input: RequestInfo | URL): string {
  const raw = inputUrl(input);
  const base = typeof window !== "undefined" ? window.location.href : "http://localhost/";
  const parsed = new URL(raw, base);
  parsed.pathname = parsed.pathname.replace(/\/auth\/login\/?$/, "/auth/2fa/verify");
  parsed.search = "";
  parsed.hash = "";

  if (raw.startsWith("/")) return parsed.pathname;
  return parsed.toString();
}

export function saveTwoFactorLoginChallenge(params: {
  ticket: string;
  username?: string;
  verifyUrl: string;
  expiresInSeconds?: unknown;
}, now = Date.now()): TwoFactorLoginChallenge | null {
  const ticket = String(params.ticket || "").trim();
  const verifyUrl = String(params.verifyUrl || "").trim();
  if (!ticket || !isValidVerifyUrl(verifyUrl)) return null;

  const ttlSeconds = normalizeTtlSeconds(params.expiresInSeconds);
  const challenge: TwoFactorLoginChallenge = {
    ticket,
    username: String(params.username || "").trim(),
    verifyUrl,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
  };

  memoryChallenge = challenge;
  const storage = getSessionStorage();
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(challenge));
  } catch {
    /* memory fallback remains available for this mount */
  }
  emitChallengeChanged();
  return challenge;
}

export function clearTwoFactorLoginChallenge(): void {
  memoryChallenge = null;
  const storage = getSessionStorage();
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  emitChallengeChanged();
}

export function readTwoFactorLoginChallenge(now = Date.now()): TwoFactorLoginChallenge | null {
  let candidate = memoryChallenge;
  const storage = getSessionStorage();
  const storedRaw = readStoredChallenge(storage);

  if (!candidate && storedRaw) {
    try {
      candidate = JSON.parse(storedRaw) as TwoFactorLoginChallenge;
    } catch {
      candidate = null;
    }
  }

  const valid = !!candidate
    && typeof candidate.ticket === "string"
    && candidate.ticket.length > 0
    && typeof candidate.username === "string"
    && typeof candidate.verifyUrl === "string"
    && isValidVerifyUrl(candidate.verifyUrl)
    && Number.isFinite(candidate.createdAt)
    && Number.isFinite(candidate.expiresAt)
    && candidate.expiresAt > now
    && candidate.expiresAt - candidate.createdAt <= MAX_TTL_SECONDS * 1000;

  if (!valid) {
    if (candidate || storedRaw) clearTwoFactorLoginChallenge();
    return null;
  }

  memoryChallenge = candidate;
  return candidate;
}

export function hasActiveTwoFactorLoginChallenge(now = Date.now()): boolean {
  return readTwoFactorLoginChallenge(now) !== null;
}

function isTwoFactorRequired(data: any): boolean {
  return data?.requires2FA === true
    || data?.requiresTwoFactor === true
    || data?.twoFactorRequired === true;
}

export function captureTwoFactorAuthResponse(
  kind: AuthEndpointKind,
  requestInput: RequestInfo | URL,
  responseOk: boolean,
  data: any,
): void {
  if (kind === "login") {
    if (responseOk && isTwoFactorRequired(data) && typeof data?.ticket === "string") {
      saveTwoFactorLoginChallenge({
        ticket: data.ticket,
        username: data.username,
        verifyUrl: deriveTwoFactorVerifyUrl(requestInput),
        expiresInSeconds: data.expiresIn ?? data.expiresInSeconds,
      });
      return;
    }

    if (responseOk && data?.token) clearTwoFactorLoginChallenge();
    return;
  }

  if (responseOk && data?.token) {
    clearTwoFactorLoginChallenge();
    return;
  }
  if (data?.code === "TFA_TICKET_EXPIRED" || data?.code === "TFA_NOT_ENABLED") {
    clearTwoFactorLoginChallenge();
  }
}

/**
 * Observe only the two login endpoints. The wrapper clones JSON responses and never consumes
 * the body returned to existing callers. It is installed after the Android HTTP bridge so all
 * runtimes share the same challenge persistence behavior.
 */
export function installTwoFactorLoginChallengeBridge(): void {
  if (bridgeInstalled || typeof window === "undefined" || typeof window.fetch !== "function") return;
  bridgeInstalled = true;

  const previousFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await previousFetch(input, init);
    const kind = classifyTwoFactorAuthEndpoint(input);
    if (!kind) return response;

    try {
      const data = await response.clone().json();
      captureTwoFactorAuthResponse(kind, input, response.ok, data);
    } catch {
      /* non-JSON auth response: existing caller owns the error handling */
    }
    return response;
  };
}
