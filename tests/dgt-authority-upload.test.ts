import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDgtAuthorityStore, gameKey } from '../src/stores/dgt-authority';
import { useUserStore } from '../src/stores/user';
import { createLegalGame, observeLiveChess, STARTING_FEN, placement, replay } from '../src/dgt-authoritative';

const api = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('../src/client', () => ({
  lichessApiClient: () => ({ POST: api.push, GET: vi.fn() }),
}));
vi.mock('../src/notify', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));

function installGame(boardNumber: number, serialnr: string, moves: string[]) {
  const store = useDgtAuthorityStore();
  const game = createLegalGame({
    roundId: 'abcd1234',
    boardNumber,
    white: 'White ' + boardNumber,
    black: 'Black ' + boardNumber,
    initialFen: STARTING_FEN,
    headers: {
      Event: 'Example',
      White: 'White ' + boardNumber,
      Black: 'Black ' + boardNumber,
      Board: String(boardNumber),
      Result: '*',
    },
  }, serialnr, 0);
  let current = observeLiveChess(game, {
    board: placement(replay(STARTING_FEN, moves).fen()), san: moves, start: STARTING_FEN,
  }, 100);
  current = observeLiveChess(current, { board: placement(replay(STARTING_FEN, moves).fen()) }, 1500);
  store.games[gameKey('abcd1234', boardNumber)] = current;
  return current;
}

beforeEach(() => {
  setActivePinia(createPinia());
  api.push.mockReset();
  api.push.mockResolvedValue({
    response: { ok: true, status: 200 },
    data: { games: [{ moves: 1, tags: { White: 'Alice' } }] },
  });
  const user = useUserStore();
  user.username = 'testowner';
  user.accessToken = { access_token: 'fake-token' } as typeof user.accessToken;
  const store = useDgtAuthorityStore();
  store.activeRoundIds = ['abcd1234'];
  store.owners['abcd1234'] = { serverUrl: 'https://lichess.org', username: 'testowner' };
});

describe('authoritative PGN publication', () => {
  it('never sends pending, offline or manually paused games to Lichess', async () => {
    const store = useDgtAuthorityStore();
    const key = gameKey('abcd1234', 1);
    const game = createLegalGame({
      roundId: 'abcd1234', boardNumber: 1, white: 'A', black: 'B',
      initialFen: STARTING_FEN,
      headers: { Event: 'Test', White: 'A', Black: 'B', Board: '1' },
    }, '123', 0);
    store.games[key] = game;
    await store.publishAll(5000);
    expect(api.push).not.toHaveBeenCalled();
    store.games[key] = observeLiveChess(game, { board: placement(STARTING_FEN) }, 100);
    store.games[key].manualPause = true;
    await store.publishAll(10000);
    expect(api.push).not.toHaveBeenCalled();
    store.games[key].manualPause = false;
    store.games[key].offline = true;
    await store.publishAll(15000);
    expect(api.push).not.toHaveBeenCalled();
  });

  it('publishes one fully validated PGN from accepted moves without a result', async () => {
    const store = useDgtAuthorityStore();
    let game = installGame(1, '111', []);
    game = observeLiveChess(game, {
      board: placement(replay(STARTING_FEN, ['e4']).fen()),
      san: ['e4'],
      start: STARTING_FEN,
    }, 2000);
    store.games[gameKey('abcd1234', 1)] = game;
    store.tick(3500);
    await store.publishAll(10000);
    expect(api.push).toHaveBeenCalledTimes(1);
    const [, request] = api.push.mock.calls[0];
    expect(request.body).toContain('e4');
    expect(request.body).toContain('[Result "*"]');
    expect(request.body).not.toContain('1-0');
  });

  it('continues other boards if one has an illegal physical position', async () => {
    const store = useDgtAuthorityStore();
    installGame(1, '111', []);
    const second = installGame(2, '222', []);
    const key = gameKey('abcd1234', 2);
    store.games[key] = observeLiveChess(second, {
      board: '8/8/8/8/8/8/8/8',
    }, 2000);
    store.tick(12000);
    expect(store.games[key].state).toBe('RECONCILIATION_REQUIRED');
    await store.publishAll(16000);
    expect(api.push).toHaveBeenCalledTimes(1);
    expect(api.push.mock.calls[0][1].body).toContain('[Board "1"]');
    expect(api.push.mock.calls[0][1].body).not.toContain('[Board "2"]');
  });

  it('requires an authorized matching Lichess identity for publication', async () => {
    const store = useDgtAuthorityStore();
    installGame(1, '111', []);
    useUserStore().username = 'wrongaccount';
    await store.publishAll(10000);
    expect(api.push).not.toHaveBeenCalled();
    expect(store.errors['abcd1234']).toContain('Lichess session');
  });

  it('does not claim publication when the API rejects the push', async () => {
    const store = useDgtAuthorityStore();
    installGame(1, '111', []);
    api.push.mockResolvedValue({ response: { ok: false, status: 403 }, error: { error: 'Forbidden' } });
    await store.publishAll(10000);
    expect(store.games[gameKey('abcd1234', 1)].lastPublishedPgn).toBeUndefined();
  });
});
