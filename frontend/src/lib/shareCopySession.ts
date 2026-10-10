import type { Share } from "@/types";

/**
 * Keep plaintext credentials only during the current share-dialog session.
 * The API returns bcrypt hashes and NEVER supplies the original password.
 */
type ShareIdentity = Pick<Share, "id" | "shareToken" | "hasPassword" | "credentialVersion">;
type SessionPassword = {
  password: string;
  token: string;
  credentialVersion: number;
};

export class ShareCopySession {
  private readonly known = new Map<string, SessionPassword>();

  /** Call only after the create/reset-password request succeeds. */
  remember(share: ShareIdentity, submittedPassword: string): void {
    const password = submittedPassword.trim();
    if (!share.hasPassword) {
      this.forget(share.id);
      return;
    }
    if (!password || !Number.isSafeInteger(share.credentialVersion)) return;
    this.known.set(share.id, {
      password,
      token: share.shareToken,
      credentialVersion: share.credentialVersion!,
    });
  }

  get(share: ShareIdentity): string | null {
    const saved = this.known.get(share.id);
    if (!saved) return null;
    if (!share.hasPassword || saved.token !== share.shareToken ||
      saved.credentialVersion !== share.credentialVersion) {
      this.forget(share.id);
      return null;
    }
    return saved.password;
  }

  forget(shareId: string): void { this.known.delete(shareId); }
  clear(): void { this.known.clear(); }
}

export function formatShareWithPassword(
  noteTitle: string,
  url: string,
  password: string,
  labels: { note: string; link: string; password: string },
): string {
  return [
    `${labels.note}${noteTitle.replace(/[\r\n]+/g, " ").trim()}`,
    `${labels.link}${url}`,
    `${labels.password}${password}`,
  ].join("\n");
}
