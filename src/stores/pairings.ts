import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { fetch } from '@tauri-apps/plugin-http';
import { useUserStore } from './user';
import { useSettingsStore } from './settings';
import { PairingMapping, PairingTour, matchingIdentity, nextTourMapping, syncPairings } from '../pairings';

export const usePairingsStore = defineStore('pairings', {
  state: () => ({
    installDirectory: '',
    mappings: [] as PairingMapping[],
    tours: [] as PairingTour[],
  }),
  persist: true,
});

export function startPairingSync() {
  const store = usePairingsStore();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const user = useUserStore();
      const settings = useSettingsStore();
      const authorized = (item: { lichessUrl: string; username?: string; enabled: boolean; message: string }) => {
        if (matchingIdentity(item, settings.lichessUrl, user.username) && user.accessToken) return true;
        if (item.enabled) {
          item.enabled = false;
          item.message = 'Paused: Lichess server or signed-in account changed. Review and resume explicitly.';
          store.$persist();
        }
        return false;
      };
      const download = async (origin: string, path: string, accept: string) => {
        // Recheck immediately before sending a token; persisted origins never select the credential destination.
        if (origin !== settings.lichessUrl || !user.accessToken) throw new Error('Lichess session changed.');
        const response = await fetch(`${settings.lichessUrl}${path}`, {
          headers: {
            Accept: accept,
            Authorization: `Bearer ${user.accessToken.access_token}`,
            'User-Agent': settings.version + ' as:' + user.username,
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`Lichess download failed (${response.status}).`);
        return response;
      };
      const selected = new Set<PairingMapping>();
      const allowed = (item: PairingMapping) => {
        const governing = store.tours.find(
          t =>
            t.lichessUrl === item.lichessUrl &&
            t.tournamentId === item.tournamentId &&
            t.knownRoundIds.includes(item.roundId),
        );
        return authorized(item) && (!governing || governing.enabled);
      };
      for (const tour of store.tours) {
        if (!tour.enabled || !authorized(tour)) continue;
        try {
          const response = await download(
            tour.lichessUrl,
            `/api/broadcast/${encodeURIComponent(tour.tourId)}`,
            'application/json',
          );
          const data: { rounds: { id: string }[] } = await response.json();
          if (!tour.enabled || !authorized(tour)) continue;
          const mapping = nextTourMapping(
            tour,
            data.rounds.map(r => r.id),
            store.mappings,
          );
          if (mapping) {
            if (!store.mappings.includes(mapping)) store.mappings.push(mapping);
            selected.add(
              store.mappings.find(m => m.lichessUrl === mapping.lichessUrl && m.roundId === mapping.roundId)!,
            );
            tour.message = `Following Lichess round ${mapping.roundId} → LiveChess round ${mapping.roundNumber}.`;
          } else tour.message = 'All discovered rounds imported. Waiting for the next Lichess round.';
          store.$persist();
        } catch (error) {
          tour.message = String(error instanceof Error ? error.message : error);
        }
      }
      for (const mapping of store.mappings) {
        if (!authorized(mapping)) continue;
        const automatic = store.tours.some(
          t =>
            t.lichessUrl === mapping.lichessUrl &&
            t.tournamentId === mapping.tournamentId &&
            t.knownRoundIds.includes(mapping.roundId),
        );
        if (automatic && !selected.has(mapping)) continue;
        await syncPairings(mapping, {
          requestId: () => crypto.randomUUID(),
          // Persist synchronously before crossing the native mutation boundary.
          persist: () => store.$persist(),
          fetchPgn: async item => {
            if (!allowed(item)) throw new Error('Pairing import paused or Lichess session changed.');
            const response = await download(
              item.lichessUrl,
              `/api/broadcast/round/${encodeURIComponent(item.roundId)}.pgn`,
              'application/x-chess-pgn',
            );
            if (!allowed(item)) throw new Error('Pairing import paused or Lichess session changed.');
            return response.text();
          },
          importPgn: (item, pgn, requestId) =>
            allowed(item)
              ? invoke('livechess_import', {
                  tournamentId: item.tournamentId,
                  roundNumber: item.roundNumber,
                  pgn,
                  requestId,
                })
              : Promise.reject(new Error('Pairing import paused or Lichess session changed.')),
        });
      }
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 15000);
  return () => clearInterval(timer);
}
