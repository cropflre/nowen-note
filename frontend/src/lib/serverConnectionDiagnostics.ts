export type ServerConnectionIssue =
  | "httpsRequired"
  | "certificateExpired"
  | "certificateNotYetValid"
  | "hostnameMismatch"
  | "certificateUntrusted"
  | "tlsFailed";

export interface ServerConnectionDiagnostic {
  kind: ServerConnectionIssue;
  expiresAt?: number;
  validFrom?: number;
}

export function classifyConnectionFailure(message: string): ServerConnectionDiagnostic | undefined {
  if (/CertificateExpiredException|certificate (?:has )?expired/i.test(message)) return { kind: "certificateExpired" };
  if (/CertificateNotYetValidException|certificate (?:is )?not yet valid/i.test(message)) return { kind: "certificateNotYetValid" };
  if (/Hostname .+ not verified|hostname mismatch|ERR_CERT_COMMON_NAME_INVALID|No subject alternative.*matching|No subjectAltNames on the certificate match/i.test(message)) return { kind: "hostnameMismatch" };
  if (/Trust anchor for certification path not found|unable to find valid certification path|CERT_AUTHORITY_INVALID|self.signed certificate/i.test(message)) return { kind: "certificateUntrusted" };
  // A generic date error can also mean a future certificate or an incorrect device clock.
  if (/SSLHandshakeException|SSLPeerUnverifiedException|CERT_DATE_INVALID|ERR_CERT_|certificate verify failed|Chain validation failed/i.test(message)) return { kind: "tlsFailed" };
  return undefined;
}

/** Diagnostic only: native code retains system trust/hostname validation and sends no credentials. */
export async function inspectAndroidServerTls(serverUrl: string): Promise<ServerConnectionDiagnostic | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    const { Capacitor, registerPlugin } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return undefined;
    const plugin = registerPlugin<{ inspect(options: { url: string }): Promise<Partial<ServerConnectionDiagnostic>> }>("ServerTlsDiagnostics");
    const result = await Promise.race([
      plugin.inspect({ url: url.origin }),
      new Promise<undefined>((resolve) => { timeout = setTimeout(() => resolve(undefined), 12000); }),
    ]);
    if (!result?.kind || !["certificateExpired", "certificateNotYetValid", "hostnameMismatch", "certificateUntrusted", "tlsFailed"].includes(result.kind)) return undefined;
    return {
      kind: result.kind,
      ...(Number.isFinite(result.expiresAt) ? { expiresAt: result.expiresAt } : {}),
      ...(Number.isFinite(result.validFrom) ? { validFrom: result.validFrom } : {}),
    };
  } catch {
    // Older installed shells and Web do not expose this diagnostic plugin.
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
