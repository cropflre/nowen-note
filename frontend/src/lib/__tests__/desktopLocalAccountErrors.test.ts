import { describe, expect, it } from 'vitest';
import { isLocalAccountBootstrapFailure, needsLocalAccountRecovery } from '@/lib/desktopLocalSession';

describe('desktop local account failure classification', () => {
  it('DCC-006: confirmed recovery is offered for every reason the reset endpoint repairs and for the unknown fallback', () => {
    for (const code of [
      'LOCAL_ACCOUNT_REQUIRES_MANUAL_LOGIN',
      'LOCAL_ACCOUNT_NOT_FOUND',
      'LOCAL_ACCOUNT_DISABLED',
      'ACCOUNT_LOCKED',
      'local-account-unavailable',
    ]) expect(needsLocalAccountRecovery(code), code).toBe(true);
  });

  it('DCC-006: transport and secret failures are explained without offering a reset that cannot help', () => {
    for (const code of ['BACKEND_UNAVAILABLE', 'HTTP_403', 'HTTP_500']) {
      expect(isLocalAccountBootstrapFailure(code), code).toBe(true);
      expect(needsLocalAccountRecovery(code), code).toBe(false);
    }
    for (const other of ['', 'download interrupted', 'LOCAL_ACCOUNT_DISABLED', 'HTTP_4', 'HTTP_4033']) {
      expect(isLocalAccountBootstrapFailure(other), other).toBe(false);
    }
  });
});
