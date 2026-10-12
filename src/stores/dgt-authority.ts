import { defineStore } from 'pinia';
import { fetch } from '@tauri-apps/plugin-http';
import { lichessApiClient } from '../client';
import { useSettingsStore } from './settings';
import { useUserStore } from './user';
import { useLogStore } from './logs';
import { notify } from '../notify';
import {
  DEFAULT_RECONCILIATION,
  SPECTATOR_UNSUPPORTED,
  approveManualSequence,
  canPublish,
  changeConnectivity,
  createLegalGame,
  observeLiveChess,
  restoreKnownLegalPosition,
  resumeAutomatic,
  setManualPause,
  tickReconciliation,
  validateConfig,
  validateStoredGame,
  type LegalGame,
  type LiveChessObservation,
  type ReconciliationConfig,
} from '../dgt-authoritative';
import { legalBroadcastPgn, parseBroadcastPairings } from '../dgt-legal-pgn';

export interface RecorderOwner {
  serverUrl: string;
  username: string;
}

const uploadsInProgress = new Set<string>();
const uploadAttemptAt = new Map<string, number>();

export function gameKey(roundId: string, boardNumber: number): string {
  return roundId + ':' + boardNumber;
}

export const useDgtAuthorityStore = defineStore('dgt-authority', {
  state: () => ({
    activeRoundIds: [] as string[],
    games: {} as Record<string, LegalGame>,
    owners: {} as Record<string, RecorderOwner>,
    config: { ...DEFAULT_RECONCILIATION } as ReconciliationConfig,
    errors: {} as Record<string, string>,
    spectatorBlock: SPECTATOR_UNSUPPORTED,
  }),
  persist: {
    pick: ['activeRoundIds', 'games', 'owners', 'config'],
  },
  actions: {
    enabled(roundId: string): boolean {
      return this.activeRoundIds.includes(roundId);
    },
    setConfig(config: ReconciliationConfig) {
      this.config = { ...validateConfig(config) };
    },
    enable(roundId: string) {
      if (!/^[A-Za-z0-9]{8}$/.test(roundId)) throw new Error('Invalid Lichess round.');
      const user = useUserStore();
      if (!user.username || !user.accessToken) throw new Error('Sign in to Lichess before enabling recording.');
      if (!this.activeRoundIds.includes(roundId)) this.activeRoundIds.push(roundId);
      this.owners[roundId] = {
        serverUrl: useSettingsStore().lichessUrl,
        username: user.username,
      };
    },
    disable(roundId: string) {
      this.activeRoundIds = this.activeRoundIds.filter(id => id !== roundId);
      useLogStore().info('Authoritative WebSocket recording disabled for round ' + roundId + '.');
    },
    rehydrate() {
      for (const [key, source] of Object.entries(this.games)) {
        try {
          this.games[key] = validateStoredGame(source);
        } catch (error) {
          // A corrupt persistence entry cannot participate in automatic
          // publication. Preserve its data for diagnosis.
          this.errors[key] = 'Saved game requires manual review: ' + String(error);
          const game = this.games[key];
          game.offline = true;
          game.state = 'MANUAL_INTERVENTION';
          game.reason = this.errors[key];
        }
      }
      for (const roundId of this.activeRoundIds) {
        if (!this.owners[roundId]) {
          this.errors[roundId] = 'Recorder owner identity missing after restart. Disable and re-enable the round.';
        }
      }
    },
    async loadPairings(roundId: string, assignments: { roundId: string; boardNumber: number; serialnr: string }[]) {
      if (!this.enabled(roundId)) throw new Error('Enable authoritative WebSocket recording first.');
      const owner = this.owners[roundId];
      const user = useUserStore();
      const settings = useSettingsStore();
      if (!owner || owner.serverUrl !== settings.lichessUrl || owner.username !== user.username ||
          !user.accessToken) throw new Error('Lichess account/server changed. Pairings cannot be imported.');
      const response = await fetch(settings.lichessUrl + '/api/broadcast/round/' + roundId + '.pgn', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + user.accessToken.access_token,
          Accept: 'application/x-chess-pgn',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Lichess pairing download failed (' + response.status + ').');
      const source = await response.text();
      const metadata = parseBroadcastPairings(roundId, source);
      const missing = metadata.filter(entry => !assignments.some(
        a => a.roundId === roundId && a.boardNumber === entry.boardNumber,
      ));
      if (missing.length) throw new Error('Assign physical DGT boards before importing: ' +
        missing.map(g => g.boardNumber).join(', ') + '.');
      const now = Date.now();
      const additions: Record<string, LegalGame> = {};
      for (const meta of metadata) {
        const assignment = assignments.find(item => item.roundId === roundId && item.boardNumber === meta.boardNumber)!;
        const key = gameKey(roundId, meta.boardNumber);
        const existing = this.games[key];
        if (existing) {
          if (existing.white !== meta.white || existing.black !== meta.black ||
              existing.initialFen !== meta.initialFen || existing.serialnr !== assignment.serialnr) {
            throw new Error('Board ' + meta.boardNumber +
              ' differs from its saved legal game. Review the existing history; it will not be overwritten.');
          }
        } else {
          additions[key] = createLegalGame(meta, assignment.serialnr, now);
        }
      }
      Object.assign(this.games, additions);
      delete this.errors[roundId];
      useLogStore().info('Loaded ' + metadata.length + ' Lichess pairings for round ' + roundId +
        ' without importing any unverified moves.');
      return metadata.length;
    },
    onBoard(serialnr: string, observation: LiveChessObservation, now = Date.now()) {
      for (const [key, source] of Object.entries(this.games)) {
        if (source.serialnr !== serialnr || !this.enabled(source.roundId)) continue;
        if (this.errors[key]) continue;
        let game: LegalGame;
        try {
          game = observeLiveChess(source, observation, now, this.config);
        } catch (error) {
          game = { ...source, state: 'MANUAL_INTERVENTION', offline: false,
            reason: 'Unexpected reconstruction failure: ' + String(error),
            spectatorNotice: 'unsupported' };
        }
        this.updateGame(key, source, game);
      }
    },
    tick(now = Date.now()) {
      for (const [key, source] of Object.entries(this.games)) {
        if (!this.enabled(source.roundId) || this.errors[key]) continue;
        try {
          const game = tickReconciliation(source, now, this.config);
          this.updateGame(key, source, game);
        } catch (error) {
          this.errors[key] = 'Recorder validation failed: ' + String(error);
          source.state = 'MANUAL_INTERVENTION';
          source.offline = true;
          source.reason = this.errors[key];
          useLogStore().error(this.errors[key]);
        }
      }
    },
    connectionChanged(connected: boolean, now = Date.now()) {
      for (const [key, source] of Object.entries(this.games)) {
        if (!this.enabled(source.roundId)) continue;
        const game = changeConnectivity(source, connected, now);
        this.updateGame(key, source, game);
      }
    },
    updateGame(key: string, previous: LegalGame, next: LegalGame) {
      this.games[key] = next;
      if (next.state !== previous.state) {
        if (next.state === 'RECONCILIATION_REQUIRED' || next.state === 'MANUAL_INTERVENTION') {
          const text = 'Board ' + next.boardNumber + ': ' + (next.reason || 'position reconciliation required') +
            ' Publication suspended. Spectator notice: unsupported by Lichess OAuth API.';
          useLogStore().error(text);
        } else if (next.state === 'RECOVERED') {
          const message = 'Board ' + next.boardNumber + ': legal game recovered. ' +
            (next.reason || 'Publication may resume.');
          useLogStore().info(message);
          void notify('DGT recording restored', message);
        } else if (next.state === 'PENDING_VERIFICATION' && previous.state === 'LIVE') {
          useLogStore().info('Board ' + next.boardNumber + ': physical move in progress; checking legal position.');
        }
      }
      if (next.moves.length !== previous.moves.length) {
        useLogStore().info('Board ' + next.boardNumber + ': accepted ' + next.moves.length +
          ' legal half-moves (source: physical DGT verification).');
      }
    },
    resumeAuto(key: string) {
      const source = this.requireGame(key);
      this.games[key] = resumeAutomatic(source, Date.now());
    },
    manualPause(key: string, paused: boolean) {
      const source = this.requireGame(key);
      this.games[key] = setManualPause(source, paused, Date.now());
    },
    approveMoves(key: string, sanText: string, fullFen: string) {
      const source = this.requireGame(key);
      const moves = sanText.trim().split(/\s+/).filter(Boolean);
      const game = approveManualSequence(source, moves, fullFen, Date.now());
      this.updateGame(key, source, game);
    },
    restoreKnown(key: string, fullFen: string) {
      const source = this.requireGame(key);
      const game = restoreKnownLegalPosition(source, fullFen, Date.now());
      this.updateGame(key, source, game);
    },
    requireGame(key: string): LegalGame {
      const game = this.games[key];
      if (!game) throw new Error('No authoritative game is configured for ' + key + '.');
      if (this.errors[key]) throw new Error(this.errors[key]);
      return game;
    },
    async publishAll(now = Date.now()) {
      const user = useUserStore();
      const settings = useSettingsStore();
      for (const [key, game] of Object.entries(this.games)) {
        if (!this.enabled(game.roundId) || !canPublish(game) || this.errors[key] || uploadsInProgress.has(key))
          continue;
        const owner = this.owners[game.roundId];
        if (!owner || owner.serverUrl !== settings.lichessUrl ||
            owner.username !== user.username || !user.accessToken) {
          this.errors[game.roundId] = 'Lichess session differs from the recorder owner. Uploads halted.';
          continue;
        }
        let pgn: string;
        try {
          pgn = legalBroadcastPgn(game);
        } catch (error) {
          this.errors[key] = 'Legal PGN generation failed: ' + String(error);
          useLogStore().error(this.errors[key]);
          continue;
        }
        if (game.lastPublishedPgn === pgn || now - (uploadAttemptAt.get(key) || 0) < 4000) continue;
        uploadAttemptAt.set(key, now);
        uploadsInProgress.add(key);
        try {
          // Always push the last confirmed legal position, never a physical
          // board snapshot, and never an inferred end-of-game result.
          const result = await lichessApiClient({ 'Content-Type': 'text/plain' }).POST(
            '/api/broadcast/round/{broadcastRoundId}/push',
            {
              params: { path: { broadcastRoundId: game.roundId } },
              body: pgn,
              bodySerializer: body => body,
            },
          );
          if (result.error || !result.response.ok ||
              !result.data?.games?.some(item => !item.error)) {
            throw new Error('Lichess did not acknowledge this legal game (' + result.response.status + ').');
          }
          // Another event may have arrived during the HTTP request. The
          // acknowledgement belongs to this exact PGN, not the newer state.
          const current = this.games[key];
          if (current) {
            this.games[key] = { ...current, lastPublishedPgn: pgn, lastPublishedAt: Date.now() };
          }
        } catch (error) {
          useLogStore().error('Board ' + game.boardNumber + ' Lichess upload failed: ' + String(error));
        } finally {
          uploadsInProgress.delete(key);
        }
      }
    },
  },
});

let publisherTimer: ReturnType<typeof setInterval> | undefined;
export function startDgtAuthoritativePublisher(): () => void {
  const store = useDgtAuthorityStore();
  store.rehydrate();
  const tick = () => {
    store.tick();
    void store.publishAll();
  };
  publisherTimer = setInterval(tick, 1500);
  return () => {
    if (publisherTimer) clearInterval(publisherTimer);
    publisherTimer = undefined;
  };
}
