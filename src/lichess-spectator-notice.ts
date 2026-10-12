import { SPECTATOR_INTERRUPTION, SPECTATOR_UNSUPPORTED } from './dgt-authoritative';

/** The public Lichess Broadcast REST API supports PGN push, not a per-game
 * pause or pinned chapter-description mutation. descChapter in StudySocket
 * is an internal browser-session WebSocket operation; study:write OAuth
 * tokens do not imply access to that session protocol.
 *
 * This adapter deliberately performs no network action and never claims the
 * warning reached spectators. It is an explicit blocked capability until
 * Lichess exposes an authenticated supported endpoint.
 */
export interface SpectatorNoticeResult {
  status: 'unsupported';
  visibleToSpectators: false;
  attempted: false;
  message: string;
  reason: string;
}

export function spectatorNoticeForInterruption(): SpectatorNoticeResult {
  return {
    status: 'unsupported',
    visibleToSpectators: false,
    attempted: false,
    message: SPECTATOR_INTERRUPTION,
    reason: SPECTATOR_UNSUPPORTED,
  };
}

export function spectatorNoticeForRecovery(): SpectatorNoticeResult {
  return {
    status: 'unsupported',
    visibleToSpectators: false,
    attempted: false,
    message: '',
    reason: SPECTATOR_UNSUPPORTED,
  };
}
