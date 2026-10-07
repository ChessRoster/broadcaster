import { expect, it } from 'vitest';
import { liveChessInstallation } from '../src/livechess-platform';

it('uses the Windows installation default only on Windows', () => {
  expect(liveChessInstallation('windows').defaultPath).toBe(
    'C:\\Program Files\\Digital Game Technology\\DGT LiveChess',
  );
  for (const platform of ['macos', 'linux', 'unknown']) {
    expect(liveChessInstallation(platform).defaultPath).toBe('');
    expect(liveChessInstallation(platform).placeholder).not.toContain('C:');
  }
});

it('explains the platform-specific installation selection', () => {
  expect(liveChessInstallation('macos').help).toContain('.app bundle');
  expect(liveChessInstallation('macos').help).toContain('Rosetta');
  expect(liveChessInstallation('linux').placeholder).toBe('/opt/DGTLiveChess');
  expect(liveChessInstallation('linux').help).toContain('bundled Java runtime');
  expect(liveChessInstallation('windows').help).toContain('app and runtime folders');
});
