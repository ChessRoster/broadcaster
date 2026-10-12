import { describe, expect, it } from 'vitest';
import { spectatorNoticeForInterruption, spectatorNoticeForRecovery } from '../src/lichess-spectator-notice';

describe('Lichess spectator notice API compatibility', () => {
  it('never claims to publish an unsupported pinned chapter warning', () => {
    const result = spectatorNoticeForInterruption();
    expect(result.status).toBe('unsupported');
    expect(result.attempted).toBe(false);
    expect(result.visibleToSpectators).toBe(false);
    expect(result.message).toContain('last confirmed legal position');
    expect(result.reason).toContain('descChapter');
  });

  it('never claims to clear an existing spectator comment on recovery', () => {
    const result = spectatorNoticeForRecovery();
    expect(result.status).toBe('unsupported');
    expect(result.attempted).toBe(false);
    expect(result.visibleToSpectators).toBe(false);
    expect(result.message).toBe('');
  });

  it('does not fetch or alter organizer comments or depend on OAuth browser cookies', () => {
    // There is deliberately no WebSocket/HTTP client in the adapter.
    // An integration test of a successful pinned chapter update cannot be
    // written against today's documented OAuth API because it has no such
    // mutation. Pretending a mocked success proved otherwise would be wrong.
    expect(spectatorNoticeForInterruption().reason).toContain('No browser cookies');
  });
});
