import { EncryptedContentError, validatePassphrase } from "./envelope";

export const MIN_NEW_PASSPHRASE_CHARACTERS = 12;
export const hasStrongNewPassphrase = (value: string): boolean => Array.from(value).length >= MIN_NEW_PASSPHRASE_CHARACTERS;
/** New passwords only. Never use this check when unlocking an existing v1 object. */
export function validateNewPassphrase(value: string): void {
  validatePassphrase(value).fill(0);
  if (!hasStrongNewPassphrase(value)) throw new EncryptedContentError("invalid");
}
