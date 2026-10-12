import { describe, expect, it } from 'vitest';
import { normalizeDgtClockPgn, normalizeDgtClockValue } from '../src/dgt-clocks';

const dgtGame = `[Event "Example Open"]
[Site "Example City"]
[Input "DGT12345"]
[WhiteClock "0:15"]
[BlackClock "0:11.29"]
[Clock "W/0:00.38"]
[Result "*"]

1. e4 {[%clk 0:14.59]} e5 {[%clk 0:00.38]} *`;

describe('DGT clock notation', () => {
  it('treats H:MM as hours/minutes, not minutes/seconds', () => {
    expect(normalizeDgtClockValue('1:30')).toBe('1:30:00');
    expect(normalizeDgtClockValue('0:15')).toBe('0:15:00');
    expect(normalizeDgtClockValue('0:59')).toBe('0:59:00');
  });

  it('treats DGT dots as minute/second separators, not decimal fractions', () => {
    expect(normalizeDgtClockValue('0:12.23')).toBe('0:12:23');
    expect(normalizeDgtClockValue('0:00.38')).toBe('0:00:38');
    expect(normalizeDgtClockValue('0:00.04')).toBe('0:00:04');
  });

  it('does not invent values for unknown formats', () => {
    expect(normalizeDgtClockValue('0:15.7')).toBeUndefined();
    expect(normalizeDgtClockValue('0:60')).toBeUndefined();
    expect(normalizeDgtClockValue('n/a')).toBeUndefined();
  });
});

describe('LiveChess PGN clock normalization', () => {
  it('rewrites DGT header and move clocks but leaves everything else unchanged', () => {
    const result = normalizeDgtClockPgn(dgtGame);

    expect(result.pgn).toContain('[WhiteClock "0:15:00"]');
    expect(result.pgn).toContain('[BlackClock "0:11:29"]');
    expect(result.pgn).toContain('{[%clk 0:14:59]}');
    expect(result.pgn).toContain('{[%clk 0:00:38]}');
    expect(result.pgn).toContain('[Clock "W/0:00.38"]');
    expect(result.pgn).toContain('1. e4');
    expect(result.changedAnnotations).toBe(4);
    expect(result.changedGames).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it('leaves non-DGT PGNs and their clock formats untouched', () => {
    const other = `[Event "Other"]
[WhiteClock "0:15"]
[BlackClock "0:11.29"]

1. e4 {[%clk 0:00.38]} *`;

    expect(normalizeDgtClockPgn(other)).toEqual({
      pgn: other,
      changedAnnotations: 0,
      changedGames: 0,
      warnings: [],
    });
  });

  it('keeps games independent in multi-game uploads', () => {
    const other = `[Event "Other"]
[WhiteClock "0:15"]

1. d4 {[%clk 0:11.29]} *`;
    const combined = dgtGame + '\n\n' + other;
    const result = normalizeDgtClockPgn(combined);

    expect(result.pgn.endsWith(other)).toBe(true);
    expect(result.changedGames).toBe(1);
    expect(result.changedAnnotations).toBe(4);
  });

  it('accepts DGT current-clock headers as a source marker', () => {
    const pgn = `[Event "Live"]
[WhiteClock "1:30"]
[BlackClock "0:59"]
[Clock "W/0:59"]

1. d4 {[%clk 0:59]} *`;
    const result = normalizeDgtClockPgn(pgn);

    expect(result.pgn).toContain('[WhiteClock "1:30:00"]');
    expect(result.pgn).toContain('[BlackClock "0:59:00"]');
    expect(result.pgn).toContain('{[%clk 0:59:00]}');
  });

  it('preserves CRLF line endings and can be run repeatedly', () => {
    const input = dgtGame.replace(/\n/g, '\r\n');
    const first = normalizeDgtClockPgn(input);
    const second = normalizeDgtClockPgn(first.pgn);

    expect(first.pgn).toContain('\r\n');
    expect(second.pgn).toBe(first.pgn);
    expect(second.changedAnnotations).toBe(0);
  });

  it('reports unsupported DGT clock values without silently altering them', () => {
    const input = dgtGame.replace('[BlackClock "0:11.29"]', '[BlackClock "unknown"]');
    const result = normalizeDgtClockPgn(input);

    expect(result.pgn).toContain('[BlackClock "unknown"]');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('unsupported DGT header clock');
  });
});
