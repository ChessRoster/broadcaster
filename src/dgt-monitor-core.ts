/**
 * Pure LiveChess monitoring helpers. No physical-clock state is inferred
 * from chess legality or from a PGN clock reaching zero.
 */
export type DgtEndpointMode = 'local' | 'lan';
export type DgtBoardHealth = 'ok' | 'pending' | 'attention' | 'unknown';
export type DgtRecovery = 'manual' | 'unverified';
export type DgtEventKind = 'mismatch' | 'recovered' | 'board-offline' | 'board-restored';

export interface DgtClock {
  white: number;
  black: number;
  run: boolean | null;
  time: number;
}

export interface DgtBoardState {
  serialnr: string;
  source?: string;
  state?: string;
  board?: string;
  san?: string[];
  start?: string;
  match?: boolean;
  flipped?: boolean;
  clock?: DgtClock;
  clockReceivedAt?: number;
  lastReceivedAt: number;
  mismatchSince?: number;
  alerted: boolean;
  manualCorrectionPending: boolean;
}

export interface DgtBoardUpdate {
  serialnr: string;
  source?: string;
  state?: string;
  board?: string;
  san?: string[];
  start?: string;
  match?: boolean;
  flipped?: boolean;
  clock?: DgtClock | null;
}

export interface DgtMonitorEvent {
  kind: DgtEventKind;
  serialnr: string;
  at: number;
  message: string;
  recovery?: DgtRecovery;
}

export interface DgtBoardAssignment {
  roundId: string;
  serialnr: string;
  boardNumber: number;
}

export interface DgtUploadGuard {
  pgn: string;
  held: { serialnr: string; boardNumber: number; reason: string }[];
  verifiedBoards: number;
}

export const MISMATCH_WARNING_MS = 8000;
export const CLOCK_FRESH_MS = 5000;

export function dgtWebSocketUrl(mode: DgtEndpointMode, address: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a valid TCP port.');
  if (mode === 'local') return 'ws://127.0.0.1:' + port + '/api/v1.0';

  const host = address.trim().toLowerCase();
  if (!host || /[/@?#\s]/.test(host)) throw new Error('Enter a LAN host or private IP address.');
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = ipv4.slice(1).map(Number);
    if (a.some(v => v > 255)) throw new Error('Invalid IPv4 address.');
    const privateIp =
      a[0] === 10 ||
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && a[1] === 168) ||
      (a[0] === 169 && a[1] === 254) ||
      (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
      a[0] === 127;
    if (!privateIp) throw new Error('Only local/private network hosts are supported.');
  } else if (
    host !== 'localhost' &&
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.local)?$/.test(host) &&
    !/^\[(?:::1|f[cd][0-9a-f:]+|fe80:[0-9a-f:]+)\]$/.test(host)
  ) {
    throw new Error('Use a local hostname, .local address, or private IP.');
  }
  return 'ws://' + host + ':' + port + '/api/v1.0';
}

export function newDgtBoard(serialnr: string, now: number): DgtBoardState {
  return {
    serialnr,
    lastReceivedAt: now,
    alerted: false,
    manualCorrectionPending: false,
  };
}

/** A missing match field is not a success or a failure (e.g. clock-only message). */
export function applyDgtBoardUpdate(
  current: DgtBoardState,
  update: DgtBoardUpdate,
  now: number,
): { board: DgtBoardState; events: DgtMonitorEvent[] } {
  const next: DgtBoardState = { ...current, lastReceivedAt: now };
  const events: DgtMonitorEvent[] = [];
  if (update.state !== undefined) {
    next.state = update.state;
    if (update.state === 'NOTRESPONDING' && current.state !== 'NOTRESPONDING') {
      events.push({
        kind: 'board-offline',
        serialnr: current.serialnr,
        at: now,
        message: 'DGT board ' + current.serialnr + ' is not responding.',
      });
    } else if (current.state === 'NOTRESPONDING' && update.state === 'ACTIVE') {
      events.push({
        kind: 'board-restored',
        serialnr: current.serialnr,
        at: now,
        message: 'DGT board ' + current.serialnr + ' is responding again.',
      });
    }
  }
  if (update.source !== undefined) next.source = update.source;
  if (update.board !== undefined) next.board = update.board;
  if (update.start !== undefined) next.start = update.start;
  if (update.flipped !== undefined) next.flipped = update.flipped;
  if (Array.isArray(update.san)) next.san = [...update.san];
  if (update.clock !== undefined) {
    if (update.clock === null) {
      next.clock = undefined;
      next.clockReceivedAt = undefined;
    } else if (validDgtClock(update.clock)) {
      next.clock = { ...update.clock };
      next.clockReceivedAt = now;
    }
  }

  if (update.match === false) {
    next.match = false;
    if (current.match !== false) {
      next.mismatchSince = now;
      next.manualCorrectionPending = false;
    }
  } else if (update.match === true) {
    next.match = true;
    next.mismatchSince = undefined;
    next.alerted = false;
    next.manualCorrectionPending = false;
    if (current.alerted) {
      const manual = current.manualCorrectionPending;
      events.push({
        kind: 'recovered',
        serialnr: current.serialnr,
        at: now,
        recovery: manual ? 'manual' : 'unverified',
        message: manual
          ? 'DGT board ' + current.serialnr + ' is synchronized after the reported manual correction.'
          : 'DGT board ' + current.serialnr +
            ' is synchronized again. LiveChess recovered the position; whether someone intervened is unknown.',
      });
    }
  }
  return { board: next, events };
}

export function checkDgtMismatch(
  current: DgtBoardState,
  now: number,
  threshold = MISMATCH_WARNING_MS,
): { board: DgtBoardState; event?: DgtMonitorEvent } {
  if (
    current.match !== false ||
    current.mismatchSince === undefined ||
    current.alerted ||
    now - current.mismatchSince < threshold
  ) {
    return { board: current };
  }
  return {
    board: { ...current, alerted: true },
    event: {
      kind: 'mismatch',
      serialnr: current.serialnr,
      at: now,
      message:
        'DGT board ' + current.serialnr +
        ' has not matched the reconstructed position for ' +
        Math.floor((now - current.mismatchSince) / 1000) +
        ' seconds. Inspect LiveChess.',
    },
  };
}

export function validDgtClock(value: unknown): value is DgtClock {
  if (!value || typeof value !== 'object') return false;
  const clock = value as Partial<DgtClock>;
  return (
    Number.isFinite(clock.white) &&
    Number.isFinite(clock.black) &&
    (clock.white as number) >= 0 &&
    (clock.black as number) >= 0 &&
    (clock.run === null || typeof clock.run === 'boolean') &&
    Number.isFinite(clock.time)
  );
}

export function dgtBoardHealth(board: DgtBoardState, now: number): DgtBoardHealth {
  if (board.state === 'NOTRESPONDING' || board.alerted) return 'attention';
  if (board.match === false) return 'pending';
  if (board.match === true) return 'ok';
  return 'unknown';
}

function headerValue(headers: string, tag: string): string | undefined {
  const match = new RegExp('^\\[' + tag + '\\s+"([^"\\r\\n]*)"\\]', 'im').exec(headers);
  return match?.[1];
}

function boardNumberFromPgn(game: string): number | undefined {
  const headers = game.split(/\r?\n\r?\n/, 1)[0];
  const board = headerValue(headers, 'Board');
  const round = headerValue(headers, 'Round');
  const number = board && /^\d+$/.test(board) ? Number(board) : undefined;
  if (number && Number.isSafeInteger(number) && number > 0) return number;
  const roundSuffix = round && /^\d+\.(\d+)$/.exec(round);
  return roundSuffix ? Number(roundSuffix[1]) : undefined;
}

function sourceMoves(game: string): string[] | undefined {
  const sep = /\r?\n\r?\n/.exec(game);
  if (!sep) return undefined;
  let moves = game.slice(sep.index + sep[0].length);
  moves = moves.replace(/\{[^}]*\}/g, ' ').replace(/;[^\r\n]*/g, ' ');
  // PGN variations aren't part of the recorded main line.
  for (let i = 0; i < 12 && /\([^()]*\)/.test(moves); i++) moves = moves.replace(/\([^()]*\)/g, ' ');
  if (/[(){}]/.test(moves)) return undefined;
  const tokens = moves
    .replace(/\d+\.(?:\.\.)?/g, ' ')
    .split(/\s+/)
    .map(s => s.trim())
    .filter(s => s && !/^\$\d+$/.test(s) && !/^(?:1-0|0-1|1\/2-1\/2|\*)$/.test(s));
  return tokens.every(s => /^(?:O-O(?:-O)?|0-0(?:-0)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?[!?]*$/.test(s))
    ? tokens.map(s => s.replace(/[!?]+$/, '').replace(/^0-0(-0)?/, (_, long: string) => 'O-O' + (long || '')))
    : undefined;
}

function clockSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}

/**
 * Hold only affected games, not the entire tournament. An omitted game is not
 * a Lichess delete/reset request; the previously uploaded chapter stays put.
 * When monitoring is unavailable, preserve normal Broadcaster behavior.
 */
export function guardDgtPgnUpload(
  roundId: string,
  pgn: string,
  assignments: DgtBoardAssignment[],
  boards: Record<string, DgtBoardState>,
  now: number,
): DgtUploadGuard {
  const mapping = new Map<number, string>();
  for (const item of assignments) {
    if (item.roundId === roundId && item.boardNumber > 0) mapping.set(item.boardNumber, item.serialnr);
  }
  if (!mapping.size) return { pgn, held: [], verifiedBoards: 0 };

  const chunks = pgn.split(/(?=^\[Event\s+")/gm);
  const held: DgtUploadGuard['held'] = [];
  let verifiedBoards = 0;
  const accepted = chunks.filter(game => {
    const number = boardNumberFromPgn(game);
    if (!number || !mapping.has(number)) return true;
    const serialnr = mapping.get(number)!;
    const board = boards[serialnr];
    if (!board || board.match === undefined || board.state === 'NOTRESPONDING') return true;

    let reason: string | undefined;
    if (board.match === false && board.alerted) {
      reason = 'physical position has not been reconciled by LiveChess';
    } else if (board.match === true && board.san?.length) {
      const moves = sourceMoves(game);
      if (moves && moves.some((move, i) => i < board.san!.length && move !== board.san![i])) {
        reason = 'PGN move history differs from the LiveChess reconstructed move list';
      }
    }
    const clock = board.clock;
    if (
      !reason &&
      board.match === true &&
      clock &&
      board.clockReceivedAt !== undefined &&
      now - board.clockReceivedAt <= CLOCK_FRESH_MS &&
      Math.abs(now - clock.time) <= CLOCK_FRESH_MS
    ) {
      const head = game.split(/\r?\n\r?\n/, 1)[0];
      const white = clockSeconds(headerValue(head, 'WhiteClock'));
      const black = clockSeconds(headerValue(head, 'BlackClock'));
      if ((white === 0 && clock.white > 0) || (black === 0 && clock.black > 0)) {
        reason = 'PGN reports a zero clock while the current DGT reading remains positive';
      }
    }
    if (reason) {
      held.push({ serialnr, boardNumber: number, reason });
      return false;
    }
    verifiedBoards++;
    return true;
  });
  return { pgn: accepted.join(''), held, verifiedBoards };
}
