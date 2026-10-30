// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

it('Harmony adapters retain committed data and pending Outbox on reopen, rollback and account isolation', () => {
  // Execute the actual ArkTS adapter against persistent SQLite, rather than
  // mirroring its SQL behavior in a second implementation.
  execFileSync(process.execPath, ['--test', 'scripts/tests/harmony-native.test.cjs'], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)), stdio: 'pipe',
  });
});
