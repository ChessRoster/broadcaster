import { describe, expect, it } from 'vitest';
import {
  applyDgtBoardUpdate,
  checkDgtMismatch,
  dgtWebSocketUrl,
  guardDgtPgnUpload,
  newDgtBoard,
  validDgtClock,
  type DgtBoardState,
} from '../src/dgt-monitor-core';

const NOW = 1800000000000;
const PHYSICAL_CLOCK = { white: 32, black: 46, run: true, time: NOW };

const game = (board: number, moves: string, whiteClock = '0:00:32') =>
  '[Event "Example"]\n[Round "1.' +
  board +
  '"]\n[Board "' +
  board +
  '"]\n[WhiteClock "' +
  whiteClock +
  '"]\n[BlackClock "0:00:46"]\n\n' +
  moves +
  ' *';

describe('DGT endpoint selection', () => {
  it('connects locally without needing a host', () => {
    expect(dgtWebSocketUrl('local', '', 1982)).toBe('ws://127.0.0.1:1982/api/v1.0');
  });
  it('accepts private LAN, Tailscale, and .local hosts', () => {
    expect(dgtWebSocketUrl('lan', '192.168.2.5', 1982)).toBe('ws://192.168.2.5:1982/api/v1.0');
    expect(dgtWebSocketUrl('lan', '100.93.2.4', 1982)).toBe('ws://100.93.2.4:1982/api/v1.0');
    expect(dgtWebSocketUrl('lan', 'DGT-PC.local', 1982)).toBe('ws://dgt-pc.local:1982/api/v1.0');
  });
  it('rejects public destinations and injected paths', () => {
    expect(() => dgtWebSocketUrl('lan', '8.8.8.8', 1982)).toThrow();
    expect(() => dgtWebSocketUrl('lan', 'evil.com', 1982)).toThrow();
    expect(() => dgtWebSocketUrl('lan', '192.168.1.1/private', 1982)).toThrow();
    expect(() => dgtWebSocketUrl('lan', '192.168.1.10', 65536)).toThrow();
  });
});

describe('LiveChess reconstruction alerts', () => {
  it('ignores a normal lift-and-place transient', () => {
    const first = applyDgtBoardUpdate(newDgtBoard('123', NOW), { serialnr: '123', match: false }, NOW).board;
    const during = checkDgtMismatch(first, NOW + 1000);
    expect(during.event).toBeUndefined();
    const restored = applyDgtBoardUpdate(during.board, { serialnr: '123', match: true, san: ['e4'] }, NOW + 1200);
    expect(restored.events).toEqual([]);
    expect(restored.board.match).toBe(true);
  });

  it('notifies after a persistent mismatch then reports recovery', () => {
    const first = applyDgtBoardUpdate(newDgtBoard('123', NOW), { serialnr: '123', match: false }, NOW);
    const unresolved = checkDgtMismatch(first.board, NOW + 8000);
    expect(unresolved.event?.kind).toBe('mismatch');
    expect(checkDgtMismatch(unresolved.board, NOW + 9000).event).toBeUndefined();
    const recovered = applyDgtBoardUpdate(unresolved.board, { serialnr: '123', match: true, san: ['e4'] }, NOW + 10000);
    expect(recovered.events[0].kind).toBe('recovered');
    expect(recovered.events[0].recovery).toBe('unverified');
    expect(recovered.board.alerted).toBe(false);
  });

  it('confirms an operator-reported manual correction only after match returns', () => {
    const first = applyDgtBoardUpdate(newDgtBoard('123', NOW), { serialnr: '123', match: false }, NOW);
    const warned = checkDgtMismatch(first.board, NOW + 8000).board;
    const waiting = { ...warned, manualCorrectionPending: true };
    const stillWrong = applyDgtBoardUpdate(waiting, { serialnr: '123', match: false }, NOW + 9000);
    expect(stillWrong.events).toEqual([]);
    const fixed = applyDgtBoardUpdate(stillWrong.board, { serialnr: '123', match: true }, NOW + 10000);
    expect(fixed.events[0].recovery).toBe('manual');
  });

  it('does not treat clock-only messages as a recovery', () => {
    const first = applyDgtBoardUpdate(newDgtBoard('123', NOW), { serialnr: '123', match: false }, NOW);
    const warned = checkDgtMismatch(first.board, NOW + 8000).board;
    const next = applyDgtBoardUpdate(warned, { serialnr: '123', clock: PHYSICAL_CLOCK }, NOW + 9000);
    expect(next.board.alerted).toBe(true);
    expect(next.events).toEqual([]);
  });

  it('reports DGT board disconnect and subsequent reconnect', () => {
    const active = applyDgtBoardUpdate(newDgtBoard('123', NOW), { serialnr: '123', state: 'ACTIVE' }, NOW);
    const offline = applyDgtBoardUpdate(active.board, { serialnr: '123', state: 'NOTRESPONDING' }, NOW + 100);
    expect(offline.events[0].kind).toBe('board-offline');
    const online = applyDgtBoardUpdate(offline.board, { serialnr: '123', state: 'ACTIVE' }, NOW + 200);
    expect(online.events[0].kind).toBe('board-restored');
  });

  it('separates clock running/stopped state from hardware flag confirmation', () => {
    expect(validDgtClock({ white: 0, black: 9, run: null, time: NOW })).toBe(true);
    expect(validDgtClock({ white: -1, black: 9, run: true, time: NOW })).toBe(false);
  });
});

describe('monitored PGN upload guarding', () => {
  function monitored(match = true, clock = PHYSICAL_CLOCK): DgtBoardState {
    return {
      ...newDgtBoard('123', NOW),
      match,
      san: ['e4', 'e5'],
      clock,
      clockReceivedAt: NOW,
    };
  }
  const assignments = [{ roundId: 'abcd1234', boardNumber: 1, serialnr: '123' }];

  it('passes verified games and leaves other games untouched', () => {
    const pgn = game(1, '1. e4 e5') + '\n\n' + game(2, '1. d4 d5');
    const checked = guardDgtPgnUpload('abcd1234', pgn, assignments, { '123': monitored() }, NOW);
    expect(checked.pgn).toBe(pgn);
    expect(checked.held).toEqual([]);
    expect(checked.verifiedBoards).toBe(1);
  });

  it('holds only an unreconciled board after the alert threshold', () => {
    const bad = { ...monitored(false), alerted: true };
    const pgn = game(1, '1. e4 e5') + '\n\n' + game(2, '1. d4 d5');
    const checked = guardDgtPgnUpload('abcd1234', pgn, assignments, { '123': bad }, NOW);
    expect(checked.held).toHaveLength(1);
    expect(checked.pgn).not.toContain('[Board "1"]');
    expect(checked.pgn).toContain('[Board "2"]');
  });

  it('holds an incorrect zero-clock header when DGT still has positive time', () => {
    const checked = guardDgtPgnUpload(
      'abcd1234',
      game(1, '1. e4 e5', '0:00:00'),
      assignments,
      { '123': monitored() },
      NOW,
    );
    expect(checked.held[0].reason).toContain('zero clock');
  });

  it('holds an implausible last-move zero clock when hardware still has time', () => {
    const pgn = game(1, '1. e4 {[%clk 0:00:32]} e5 {[%clk 0:00:00]}');
    const checked = guardDgtPgnUpload('abcd1234', pgn, assignments, { '123': monitored() }, NOW);
    expect(checked.held[0].reason).toContain('latest PGN move clock');
  });

  it('does not guess whether a DGT zero reading means an actual flag', () => {
    const checked = guardDgtPgnUpload(
      'abcd1234',
      game(1, '1. e4 e5', '0:00:00'),
      assignments,
      { '123': monitored(true, { ...PHYSICAL_CLOCK, white: 0 }) },
      NOW,
    );
    expect(checked.held).toEqual([]);
  });

  it('never trusts stale clock readings to suppress an upload', () => {
    const stale = { ...monitored(), clockReceivedAt: NOW - 30000 };
    const checked = guardDgtPgnUpload(
      'abcd1234',
      game(1, '1. e4 e5', '0:00:00'),
      assignments,
      { '123': stale },
      NOW,
    );
    expect(checked.held).toEqual([]);
  });

  it('blocks a divergent move list but allows legitimate PGN lag', () => {
    const diverged = guardDgtPgnUpload('abcd1234', game(1, '1. e4 d5'), assignments, { '123': monitored() }, NOW);
    expect(diverged.held[0].reason).toContain('move history differs');
    const slow = guardDgtPgnUpload('abcd1234', game(1, '1. e4'), assignments, { '123': monitored() }, NOW);
    expect(slow.held).toEqual([]);
  });

  it('never blocks uploads for unassigned rounds or when only a board inventory is available', () => {
    const input = game(1, '1. e4 e5', '0:00:00');
    expect(guardDgtPgnUpload('other123', input, assignments, { '123': monitored() }, NOW).pgn).toBe(input);
    expect(guardDgtPgnUpload('abcd1234', input, assignments, { '123': newDgtBoard('123', NOW) }, NOW).pgn).toBe(input);
  });
});
