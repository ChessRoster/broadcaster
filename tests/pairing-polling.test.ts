import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { startPairingSync, usePairingsStore } from '../src/stores/pairings';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  invoke: vi.fn(),
  user: { username: 'operator', accessToken: { access_token: 'secret' } },
  settings: { lichessUrl: 'https://lichess.org', version: 'test' },
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: mocks.fetch }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../src/stores/user', () => ({ useUserStore: () => mocks.user }));
vi.mock('../src/stores/settings', () => ({ useSettingsStore: () => mocks.settings }));
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setActivePinia(createPinia());
  mocks.user.username = 'operator';
  mocks.settings.lichessUrl = 'https://lichess.org';
});
afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

it('pauses stale server and account mappings before making any network or import calls', async () => {
  const store = usePairingsStore();
  store.$persist = vi.fn();
  store.mappings.push({
    roundId: 'round001',
    lichessUrl: 'https://old.example',
    username: 'operator',
    tournamentId: 'uuid',
    roundNumber: 1,
    expectedBoards: 1,
    enabled: true,
    completed: false,
    message: '',
  });
  store.tours.push({
    tourId: 'tour0001',
    lichessUrl: 'https://lichess.org',
    username: 'old-operator',
    tournamentId: 'uuid',
    startRoundId: 'round002',
    localStartingRound: 2,
    expectedBoards: 1,
    enabled: true,
    knownRoundIds: [],
    message: '',
  });
  stop = startPairingSync();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(store.mappings[0].enabled).toBe(false);
  expect(store.tours[0].enabled).toBe(false);
});

it('automatically imports appended rounds in order and stops a paused tournament', async () => {
  const store = usePairingsStore();
  store.$persist = vi.fn();
  store.tours.push({
    tourId: 'tour0001',
    lichessUrl: 'https://lichess.org',
    username: 'operator',
    tournamentId: 'uuid',
    startRoundId: 'round002',
    localStartingRound: 1,
    expectedBoards: 1,
    enabled: true,
    knownRoundIds: [],
    message: '',
  });
  const rounds = [{ id: 'round001' }, { id: 'round002' }];
  mocks.fetch.mockImplementation(async (url: string) =>
    url.endsWith('.pgn')
      ? {
          ok: true,
          text: async () => '[White "Alice"]\n[Black "Bob"]\n[Round "2.1"]\n[Result "*"]\n\n*',
        }
      : { ok: true, json: async () => ({ rounds }) },
  );
  mocks.invoke.mockResolvedValue({ status: 'imported' });
  stop = startPairingSync();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(store.mappings[0].roundId).toBe('round002');
  expect(store.mappings[0].completed).toBe(true);
  rounds.push({ id: 'round003' });
  await vi.advanceTimersByTimeAsync(15000);
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  expect(mocks.invoke.mock.calls[1][1].roundNumber).toBe(2);
  store.tours[0].enabled = false;
  rounds.push({ id: 'round004' });
  await vi.advanceTimersByTimeAsync(15000);
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it('honors tournament pause while a child round download is in flight', async () => {
  const store = usePairingsStore();
  store.$persist = vi.fn();
  store.tours.push({
    tourId: 'tour0001',
    lichessUrl: 'https://lichess.org',
    username: 'operator',
    tournamentId: 'uuid',
    startRoundId: 'round002',
    localStartingRound: 1,
    expectedBoards: 1,
    enabled: true,
    knownRoundIds: [],
    message: '',
  });
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('.pgn')) {
      store.tours[0].enabled = false;
      return { ok: true, text: async () => '[White "Alice"]\n[Black "Bob"]\n[Round "2.1"]\n[Result "*"]\n\n*' };
    }
    return { ok: true, json: async () => ({ rounds: [{ id: 'round002' }] }) };
  });
  stop = startPairingSync();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(store.mappings[0].pending).toBeUndefined();
  await vi.advanceTimersByTimeAsync(15000);
  expect(mocks.invoke).not.toHaveBeenCalled();
});
