import { describe, expect, it, vi } from 'vitest';
import {
  PairingMapping,
  PairingTour,
  matchingIdentity,
  nextTourMapping,
  pairingPgn,
  syncPairings,
} from '../src/pairings';

const game = (board: number, white = `White ${board}`) =>
  `[Event "Open"]\n[White "${white}"]\n[Black "Black ${board}"]\n[Board "${board}"]\n[Round "9"]\n[Result "*"]\n\n*`;
const mapping = (): PairingMapping => ({
  roundId: 'abcdefgh',
  lichessUrl: 'https://lichess.org',
  tournamentId: 'uuid',
  roundNumber: 2,
  expectedBoards: 2,
  enabled: true,
  completed: false,
  message: '',
});

describe('complete physical board pairing PGN', () => {
  it('uses explicit Round round.board suffixes and rejects mixed rounds or conflicting boards', () => {
    const source = (board: number, round = 5) =>
      game(board).replace(`[Board "${board}"]\n`, '').replace('[Round "9"]', `[Round "${round}.${board}"]`);
    expect(pairingPgn(source(2) + '\n\n' + source(1), 2, 7)).toContain('[Board "1"]');
    expect(() => pairingPgn(source(1) + '\n\n' + source(2, 6), 2, 7)).toThrow('same source round');
    expect(() => pairingPgn(game(1).replace('[Round "9"]', '[Round "5.2"]'), 1, 1)).toThrow('disagree');
    expect(() => pairingPgn(source(1) + '\n\n' + source(1), 2, 1)).toThrow('unique');
    expect(() => pairingPgn(game(1), 501, 1)).toThrow('500');
  });
  it('sorts physical boards, rewrites destination round and preserves escaped names', () => {
    const source = game(2) + '\n\n' + game(1, 'Alice \\"Ace\\"');
    const pgn = pairingPgn(source, 2, 3);
    expect(pgn.indexOf('[Board "1"]')).toBeLessThan(pgn.indexOf('[Board "2"]'));
    expect(pgn).toContain('[Round "3"]');
    expect(pgn).toContain('[White "Alice \\"Ace\\""]');
    expect(pairingPgn(pgn, 2, 3)).toBe(pgn);
  });
  it('rejects incomplete, duplicate, missing and noncontiguous boards', () => {
    expect(() => pairingPgn(game(1), 2, 1)).toThrow('Waiting for 2 boards');
    expect(() => pairingPgn(game(1) + '\n\n' + game(1), 2, 1)).toThrow('unique');
    expect(() => pairingPgn(game(1).replace('[Board "1"]', ''), 1, 1)).toThrow('explicit');
    expect(() => pairingPgn(game(2), 1, 1)).toThrow('unique');
    expect(() => pairingPgn(game(1).slice(0, -1), 1, 1)).toThrow('ending');
  });
  it('rejects live game feedback, results, positions and invalid headers', () => {
    expect(() => pairingPgn(game(1).replace('\n\n*', '\n\n1. e4 *'), 1, 1)).toThrow('moves');
    expect(() => pairingPgn(game(1).replace('[Result "*"]', '[Result "1-0"]'), 1, 1)).toThrow('unplayed');
    expect(() => pairingPgn(game(1).replace('[Result', '[FEN "anything"]\n[Result'), 1, 1)).toThrow('positions');
    expect(() => pairingPgn(game(1).replace('[Black "Black 1"]', '[Black "?"]'), 1, 1)).toThrow('names');
    expect(() => pairingPgn(game(1).replace('[Round', '[White "Changed"]\n[Round'), 1, 1)).toThrow('Duplicate');
  });
});

describe('automatic tournament round discovery', () => {
  const tour = (): PairingTour => ({
    tourId: 'tour1234',
    lichessUrl: 'https://lichess.org',
    username: 'operator',
    tournamentId: 'uuid',
    startRoundId: 'round002',
    localStartingRound: 3,
    expectedBoards: 2,
    knownRoundIds: [],
    enabled: true,
    message: '',
  });
  it('skips historical rounds, advances only after completion and discovers appended future rounds', () => {
    const config = tour();
    const first = nextTourMapping(config, ['round001', 'round002', 'round003'], [])!;
    expect(first.roundId).toBe('round002');
    expect(first.roundNumber).toBe(3);
    expect(nextTourMapping(config, ['round001', 'round002', 'round003'], [first])).toBe(first);
    first.completed = true;
    const second = nextTourMapping(config, ['round001', 'round002', 'round003'], [first])!;
    expect(second.roundNumber).toBe(4);
    second.completed = true;
    expect(nextTourMapping(config, ['round001', 'round002', 'round003'], [first, second])).toBeUndefined();
    const third = nextTourMapping(config, ['round001', 'round002', 'round003', 'round004'], [first, second])!;
    expect(third.roundId).toBe('round004');
    expect(third.roundNumber).toBe(5);
  });
  it('rejects reordered rounds and conflicting local destinations', () => {
    const config = tour();
    nextTourMapping(config, ['round001', 'round002', 'round003'], []);
    expect(() => nextTourMapping(config, ['round001', 'round002', 'round004', 'round003'], [])).toThrow(
      'order changed',
    );
    expect(() => nextTourMapping(tour(), ['round002'], [{ ...mapping(), roundNumber: 3 }])).toThrow('another mapping');
  });
  it('does not authorize persisted mappings on another origin or account', () => {
    const item = { lichessUrl: 'https://lichess.org', username: 'operator' };
    expect(matchingIdentity(item, 'https://lichess.org', 'operator')).toBe(true);
    expect(matchingIdentity(item, 'https://other.example', 'operator')).toBe(false);
    expect(matchingIdentity(item, 'https://lichess.org', 'different')).toBe(false);
    expect(matchingIdentity(item, 'https://lichess.org', null)).toBe(false);
    expect(matchingIdentity({ lichessUrl: item.lichessUrl }, item.lichessUrl, 'operator')).toBe(false);
  });
});

describe('once per mapped round and uncertainty reconciliation', () => {
  it('persists before mutation and retries the original content and id after a lost reply', async () => {
    const item = mapping();
    const fetchPgn = vi.fn().mockResolvedValue(game(2) + '\n\n' + game(1));
    const calls: string[] = [];
    const persist = vi.fn(() => {
      calls.push('persist');
    });
    const importPgn = vi
      .fn()
      .mockImplementationOnce(async () => {
        calls.push('import');
        throw new Error('lost reply');
      })
      .mockResolvedValueOnce({ status: 'already_imported' });
    const dependencies = { fetchPgn, persist, importPgn, requestId: () => 'stable-id' };
    await syncPairings(item, dependencies);
    const pending = { ...item.pending };
    expect(calls).toEqual(['persist', 'import']);
    expect(item.completed).toBe(false);
    await syncPairings(item, dependencies);
    expect(fetchPgn).toHaveBeenCalledTimes(1);
    expect(importPgn.mock.calls[1].slice(1)).toEqual([pending.pgn, pending.requestId]);
    expect(item.completed).toBe(true);
    expect(item.enabled).toBe(false);
    await syncPairings(item, dependencies);
    expect(importPgn).toHaveBeenCalledTimes(2);
  });
  it('never invokes the importer for partial PGN or failed local persistence', async () => {
    const item = mapping();
    const dependencies = {
      fetchPgn: vi.fn().mockResolvedValue(game(1)),
      persist: vi.fn(),
      importPgn: vi.fn(),
      requestId: () => 'id',
    };
    await syncPairings(item, dependencies);
    expect(dependencies.importPgn).not.toHaveBeenCalled();
    dependencies.fetchPgn.mockResolvedValue(game(1) + '\n\n' + game(2));
    dependencies.persist.mockImplementation(() => {
      throw new Error('disk full');
    });
    await syncPairings(item, dependencies);
    await syncPairings(item, dependencies);
    expect(dependencies.importPgn).not.toHaveBeenCalled();
  });
  it('does not import after pausing during a Lichess download', async () => {
    const item = mapping();
    const dependencies = {
      fetchPgn: async () => {
        item.enabled = false;
        return game(1) + '\n\n' + game(2);
      },
      persist: vi.fn(),
      importPgn: vi.fn(),
      requestId: () => 'id',
    };
    await syncPairings(item, dependencies);
    expect(dependencies.importPgn).not.toHaveBeenCalled();
  });
});
