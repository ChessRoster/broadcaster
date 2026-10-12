import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import {
  DEFAULT_RECONCILIATION,
  SPECTATOR_INTERRUPTION,
  SPECTATOR_UNSUPPORTED,
  STARTING_FEN,
  approveManualSequence,
  canPublish,
  changeConnectivity,
  createLegalGame,
  observeLiveChess,
  placement,
  replay,
  restoreKnownLegalPosition,
  resumeAutomatic,
  setManualPause,
  tickReconciliation,
  validateStoredGame,
  type LegalGame,
} from '../src/dgt-authoritative';
import { legalBroadcastPgn, parseBroadcastPairings } from '../src/dgt-legal-pgn';

const cfg = { ...DEFAULT_RECONCILIATION, stabilizeMs: 600, alertMs: 2500, manualMs: 10000 };
const meta = {
  roundId: 'abcd1234',
  boardNumber: 2,
  white: 'Alice',
  black: 'Bob',
  headers: { Event: 'Test', Round: '1.2', Board: '2', White: 'Alice', Black: 'Bob', Result: '*' },
  initialFen: STARTING_FEN,
};
const physical = (moves: string[], initial = STARTING_FEN) => placement(replay(initial, moves).fen());

function boot(): LegalGame {
  let game = createLegalGame(meta, '123', 0);
  game = changeConnectivity(game, true, 0);
  game = observeLiveChess(game, { board: physical([]), match: true, sourceTime: 1 }, 0, cfg);
  expect(game.state).toBe('LIVE');
  return game;
}

function moved(game: LegalGame, moves: string[], at: number, sourceTime = at): LegalGame {
  return observeLiveChess(game, {
    board: physical(moves, game.initialFen),
    sourceTime,
  }, at, cfg);
}

describe('authoritative DGT game', () => {
  it('accepts a normal legal move only after physical stabilization', () => {
    let game = boot();
    game = moved(game, ['e4'], 100);
    expect(game.state).toBe('PENDING_VERIFICATION');
    expect(game.moves).toEqual([]);
    expect(canPublish(game)).toBe(false);
    game = tickReconciliation(game, 2700, cfg);
    expect(game.moves).toEqual(['e4']);
    expect(game.state).toBe('LIVE');
    expect(canPublish(game)).toBe(true);
    expect(game.acceptedFen).toBe(replay(STARTING_FEN, ['e4']).fen());
  });

  it('ignores an ordinary lifted pawn that is put back', () => {
    let game = boot();
    // White's pawn is temporarily removed from e2.
    const lifted = 'rnbqkbnr/pppppppp/8/8/8/8/PPPP1PPP/RNBQKBNR';
    game = observeLiveChess(game, { board: lifted, match: false }, 100, cfg);
    expect(game.state).toBe('PENDING_VERIFICATION');
    game = observeLiveChess(game, { board: physical([]), match: true }, 200, cfg);
    game = tickReconciliation(game, 900, cfg);
    expect(game.state).toBe('LIVE');
    expect(game.moves).toEqual([]);
    expect(game.events.some(event => event.type === 'interrupted')).toBe(false);
  });

  it('handles an ordinary capture with intermediate board states', () => {
    let game = boot();
    game = observeLiveChess(game, {
      board: physical(['e4', 'd5']), san: ['e4', 'd5'], start: STARTING_FEN,
    }, 100, cfg);
    game = tickReconciliation(game, 800, cfg);
    expect(game.moves).toEqual(['e4', 'd5']);
    // Black pawn is lifted from d5 as White starts capturing it.
    const lifted = 'rnbqkbnr/ppp1pppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR';
    game = observeLiveChess(game, { board: lifted, match: false }, 1000, cfg);
    game = observeLiveChess(game, { board: physical(['e4', 'd5', 'exd5']) }, 1100, cfg);
    game = tickReconciliation(game, 5800, cfg);
    expect(game.moves).toEqual(['e4', 'd5', 'exd5']);
    expect(canPublish(game)).toBe(true);
  });

  it('supports castling by validating the final rook/king arrangement', () => {
    const base = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'];
    let game = boot();
    game = observeLiveChess(game, {
      board: physical(base), san: base, start: STARTING_FEN,
    }, 100, cfg);
    game = tickReconciliation(game, 800, cfg);
    expect(game.moves).toEqual(base);
    game = observeLiveChess(game, { board: physical([...base, 'O-O']) }, 1000, cfg);
    game = tickReconciliation(game, 5800, cfg);
    expect(game.moves[game.moves.length - 1]).toBe('O-O');
  });

  it('accepts en passant with the appropriate full game history', () => {
    const before = ['e4', 'a6', 'e5', 'd5'];
    let game = boot();
    game = observeLiveChess(game, {
      board: physical(before), start: STARTING_FEN, san: before,
    }, 100, cfg);
    game = tickReconciliation(game, 800, cfg);
    game = observeLiveChess(game, { board: physical([...before, 'exd6']) }, 1000, cfg);
    game = tickReconciliation(game, 5800, cfg);
    expect(game.moves[game.moves.length - 1]).toBe('exd6');
  });

  it('requires the correct promotion choice', () => {
    const fen = '7k/P7/8/8/8/8/8/6K1 w - - 0 1';
    let game = createLegalGame({ ...meta, initialFen: fen }, '123', 0);
    game = changeConnectivity(game, true, 0);
    game = observeLiveChess(game, { board: placement(fen) }, 0, cfg);
    const legal = new Chess(fen).moves().find(move => move.startsWith('a8=Q'))!;
    expect(legal).toBeDefined();
    game = observeLiveChess(game, { board: physical([legal], fen), start: fen, san: [legal] }, 100, cfg);
    game = tickReconciliation(game, 800, cfg);
    expect(game.moves).toEqual([legal]);
  });

  it('recovers when an illegal physical movement is immediately reversed', () => {
    let game = boot();
    game = observeLiveChess(game, {
      board: 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPP1PPP/RNBQKBNR', match: false,
    }, 100, cfg);
    game = observeLiveChess(game, { board: physical([]), match: true }, 700, cfg);
    expect(game.moves).toEqual([]);
    expect(game.state).toBe('LIVE');
    expect(game.spectatorNotice).toBe('not-required');
  });

  it('raises an immediate operator interruption if clock side changes during a mismatch', () => {
    let game = boot();
    game = observeLiveChess(game, {
      board: physical([]), clock: { white: 10, black: 30, run: true, time: 1000 },
    }, 1000, cfg);
    game = observeLiveChess(game, {
      board: 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPP1PPP/RNBQKBNR',
      clock: { white: 10, black: 30, run: false, time: 1200 },
    }, 1200, cfg);
    expect(game.state).toBe('RECONCILIATION_REQUIRED');
    expect(game.spectatorNotice).toBe('unsupported');
    expect(canPublish(game)).toBe(false);
    expect(game.moves).toEqual([]);
  });

  it('does not declare a game result for an illegal move', () => {
    let game = boot();
    game = moved(game, ['e4'], 100);
    game = tickReconciliation(game, 2700, cfg);
    game = observeLiveChess(game, {
      board: '8/8/8/8/8/8/8/8',
    }, 1500, cfg);
    game = tickReconciliation(game, 4100, cfg);
    expect(game.state).toBe('RECONCILIATION_REQUIRED');
    expect(game.moves).toEqual(['e4']);
    expect(legalBroadcastPgn(game)).toMatch(/\*/);
    expect(legalBroadcastPgn(game)).not.toMatch(/\[Result "[01]-[01]"\]/);
  });

  it('automatically resumes legal play after an interruption', () => {
    let game = boot();
    game = observeLiveChess(game, { board: '8/8/8/8/8/8/8/8' }, 100, cfg);
    game = tickReconciliation(game, 2800, cfg);
    expect(game.state).toBe('RECONCILIATION_REQUIRED');
    game = moved(game, ['e4'], 3000);
    game = tickReconciliation(game, 5800, cfg);
    expect(game.moves).toEqual(['e4']);
    expect(game.state).toBe('RECOVERED');
    game = tickReconciliation(game, 7300, cfg);
    expect(canPublish(game)).toBe(true);
  });

  it('handles multiple reconstructed moves in one WebSocket event', () => {
    let game = boot();
    const moves = ['e4', 'e5', 'Nf3'];
    game = observeLiveChess(game, {
      board: physical(moves),
      san: moves,
      start: STARTING_FEN,
      match: true,
    }, 100, cfg);
    game = tickReconciliation(game, 800, cfg);
    expect(game.moves).toEqual(moves);
    expect(game.acceptedFen).toBe(replay(STARTING_FEN, moves).fen());
  });

  it('never trusts SAN that conflicts with physical pieces', () => {
    let game = boot();
    game = observeLiveChess(game, {
      board: physical(['d4']), san: ['e4'], start: STARTING_FEN, match: true,
    }, 100, cfg);
    game = tickReconciliation(game, 2700, cfg);
    expect(game.moves).toEqual(['d4']);
    expect(game.acceptedFen).toBe(replay(STARTING_FEN, ['d4']).fen());
  });

  it('ignores duplicate or out-of-order physical messages', () => {
    let game = boot();
    game = moved(game, ['e4'], 100, 200);
    game = observeLiveChess(game, { board: physical(['d4']), sourceTime: 199 }, 150, cfg);
    game = tickReconciliation(game, 2700, cfg);
    expect(game.moves).toEqual(['e4']);
    game = observeLiveChess(game, { board: physical(['e4']), sourceTime: 200 }, 1000, cfg);
    expect(game.moves).toEqual(['e4']);
  });

  it('tracks connection loss separately from illegal moves', () => {
    let game = boot();
    game = changeConnectivity(game, false, 500);
    expect(game.offline).toBe(true);
    expect(canPublish(game)).toBe(false);
    expect(game.events[0].type).toBe('offline');
    game = changeConnectivity(game, true, 1000);
    expect(game.state).toBe('PENDING_VERIFICATION');
    game = observeLiveChess(game, { board: physical([]) }, 1200, cfg);
    expect(canPublish(game)).toBe(true);
  });

  it('isolates problems on board two from another game', () => {
    let a = boot();
    let b = boot();
    b = observeLiveChess(b, { board: '8/8/8/8/8/8/8/8' }, 100, cfg);
    b = tickReconciliation(b, 2800, cfg);
    expect(canPublish(a)).toBe(true);
    expect(canPublish(b)).toBe(false);
    a = moved(a, ['e4'], 500);
    a = tickReconciliation(a, 3100, cfg);
    expect(a.moves).toEqual(['e4']);
  });

  it('retains reconciliation status and validated legal history after restart', () => {
    let game = boot();
    game = observeLiveChess(game, { board: '8/8/8/8/8/8/8/8' }, 100, cfg);
    game = tickReconciliation(game, 2800, cfg);
    const loaded = validateStoredGame(JSON.parse(JSON.stringify(game)) as LegalGame);
    expect(loaded.state).toBe('RECONCILIATION_REQUIRED');
    expect(loaded.offline).toBe(true);
    expect(loaded.events.length).toBeGreaterThan(0);
    expect(canPublish(loaded)).toBe(false);
    expect(loaded.acceptedFen).toBe(game.acceptedFen);
  });

  it('requires physical and full-FEN confirmation for arbiter correction', () => {
    let game = boot();
    game = observeLiveChess(game, { board: '8/8/8/8/8/8/8/8' }, 100, cfg);
    game = tickReconciliation(game, 2800, cfg);
    const e4 = replay(STARTING_FEN, ['e4']).fen();
    expect(() => approveManualSequence(game, ['e4'], e4, 3000)).toThrow('physical DGT pieces');
    game = moved(game, ['e4'], 3100);
    const manual = approveManualSequence(game, ['e4'], e4, 3400);
    expect(manual.moves).toEqual(['e4']);
    expect(manual.state).toBe('RECOVERED');
    expect(restoreKnownLegalPosition(manual, e4, 3500).acceptedFen).toBe(e4);
    expect(() => restoreKnownLegalPosition(manual, STARTING_FEN, 3500)).toThrow();
  });

  it('keeps ambiguous/missing positions in manual intervention until approved', () => {
    let game = boot();
    game = observeLiveChess(game, { board: '8/8/8/8/8/8/8/8' }, 100, cfg);
    game = tickReconciliation(game, 11000, cfg);
    expect(game.state).toBe('MANUAL_INTERVENTION');
    game = moved(game, ['e4'], 12000);
    game = tickReconciliation(game, 13000, cfg);
    expect(game.moves).toEqual([]);
    game = resumeAutomatic(game, 14000);
    game = tickReconciliation(game, 16700, cfg);
    expect(game.moves).toEqual(['e4']);
  });

  it('supports manual pause without ceasing physical monitoring', () => {
    let game = boot();
    game = setManualPause(game, true, 100);
    game = moved(game, ['e4'], 200);
    game = tickReconciliation(game, 1500, cfg);
    expect(game.moves).toEqual([]);
    game = setManualPause(game, false, 1600);
    game = tickReconciliation(game, 4200, cfg);
    expect(game.moves).toEqual(['e4']);
  });

  it('records physical observations but not a fabricated flag or result', () => {
    let game = boot();
    game = observeLiveChess(game, {
      clock: { white: 0, black: 10, run: null, time: 500 },
    }, 500, cfg);
    expect(game.clock?.white).toBe(0);
    expect(game.samples).toHaveLength(2);
    expect(game.moves).toEqual([]);
    expect(game.state).toBe('LIVE');
  });
});

describe('Lichess identity and legal PGN', () => {
  const input =
    '[Event "Test"]\n[White "Alice"]\n[Black "Bob"]\n[Board "2"]\n[Round "1.2"]\n[WhiteClock "0:00"]\n\n*';

  it('loads player names and pairing metadata rather than LiveChess player guesses', () => {
    const parsed = parseBroadcastPairings('abcd1234', input);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].white).toBe('Alice');
    expect(parsed[0].boardNumber).toBe(2);
    const game = createLegalGame(parsed[0], '123', 0);
    game.moves = ['e4'];
    game.acceptedFen = replay(game.initialFen, game.moves).fen();
    const result = legalBroadcastPgn(game);
    expect(result).toContain('[White "Alice"]');
    expect(result).not.toContain('WhiteClock');
    expect(result).toContain('e4');
    expect(result).toContain('[Result "*"]');
  });

  it('rejects duplicated board identities and corrupted accepted FEN', () => {
    expect(() => parseBroadcastPairings('abcd1234', input + '\n\n' + input)).toThrow();
    const game = createLegalGame(meta, '123', 0);
    game.acceptedFen = '8/8/8/8/8/8/8/8 w - - 0 1';
    expect(() => legalBroadcastPgn(game)).toThrow('corrupted legal-game state');
  });

  it('reports spectator status as unsupported, never as a successful pinned comment', () => {
    let game = boot();
    game = observeLiveChess(game, { board: '8/8/8/8/8/8/8/8' }, 100, cfg);
    game = tickReconciliation(game, 2800, cfg);
    expect(game.spectatorNotice).toBe('unsupported');
    expect(SPECTATOR_UNSUPPORTED).toContain('no supported Lichess OAuth');
    expect(SPECTATOR_INTERRUPTION).toContain('Broadcast temporarily interrupted');
  });
});
