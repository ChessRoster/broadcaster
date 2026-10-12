import { Chess } from 'chess.js';
import type { DgtClock } from './dgt-monitor-core';

export type ReconciliationState =
  | 'LIVE'
  | 'PENDING_VERIFICATION'
  | 'RECONCILIATION_REQUIRED'
  | 'RECOVERED'
  | 'MANUAL_INTERVENTION';

export type RecordedEventType =
  | 'pending'
  | 'accepted'
  | 'suspected'
  | 'interrupted'
  | 'ambiguous'
  | 'recovered'
  | 'manual'
  | 'offline'
  | 'online'
  | 'paused';

export interface AcceptedEvent {
  at: number;
  type: RecordedEventType;
  text: string;
  sourcePosition?: string;
}

export interface BoardSample {
  at: number;
  physical?: string;
  match?: boolean;
  reconstructedCount?: number;
  clockRun?: boolean | null;
}

export interface PairingMetadata {
  roundId: string;
  boardNumber: number;
  white: string;
  black: string;
  headers: Record<string, string>;
  initialFen: string;
}

export interface LegalGame extends PairingMetadata {
  serialnr: string;
  moves: string[];
  acceptedFen: string;
  state: ReconciliationState;
  physicalBoard?: string;
  reconstructionStart?: string;
  reconstructedSan?: string[];
  match?: boolean;
  clock?: DgtClock;
  lastEventAt?: number;
  lastSourceTime?: number;
  discrepancySince?: number;
  stableSince?: number;
  reason?: string;
  offline: boolean;
  manualPause: boolean;
  // Records uploaded to Lichess are not inferred from board or timer state.
  lastPublishedPgn?: string;
  lastPublishedAt?: number;
  spectatorNotice: 'not-required' | 'unsupported';
  events: AcceptedEvent[];
  samples: BoardSample[];
}

export interface LiveChessObservation {
  board?: string;
  san?: string[];
  start?: string;
  match?: boolean;
  clock?: DgtClock | null;
  sourceTime?: number;
}

export interface ReconciliationConfig {
  stabilizeMs: number;
  alertMs: number;
  manualMs: number;
}

export const DEFAULT_RECONCILIATION: ReconciliationConfig = {
  stabilizeMs: 1000,
  alertMs: 8000,
  manualMs: 30000,
};

export const STARTING_FEN = new Chess().fen();
const MAX_LOG = 120;
const MAX_FALLBACK_DEPTH = 2;

function log(game: LegalGame, type: RecordedEventType, text: string, at: number): void {
  game.events = [{ at, type, text, sourcePosition: game.physicalBoard }, ...game.events].slice(0, MAX_LOG);
}

export function replay(initialFen: string, moves: readonly string[]): Chess {
  const board = new Chess(initialFen);
  for (const san of moves) {
    const result = board.move(san);
    if (!result) throw new Error('Illegal move in accepted game history: ' + san);
  }
  return board;
}

export function placement(fen: string): string {
  return fen.split(' ')[0];
}

export function validateCompleteFen(fen: string): string {
  const fields = fen.trim().split(/\s+/);
  if (fields.length !== 6) throw new Error('A full FEN with all six fields is required.');
  const board = new Chess(fen);
  return board.fen();
}

export function createLegalGame(metadata: PairingMetadata, serialnr: string, now: number): LegalGame {
  if (!/^[A-Za-z0-9]{8}$/.test(metadata.roundId)) throw new Error('Invalid Lichess round identifier.');
  if (!Number.isInteger(metadata.boardNumber) || metadata.boardNumber < 1) throw new Error('Invalid board number.');
  if (!metadata.white.trim() || !metadata.black.trim() || !serialnr.trim()) throw new Error('Missing game identity.');
  const initialFen = validateCompleteFen(metadata.initialFen);
  return {
    ...metadata,
    initialFen,
    serialnr,
    moves: [],
    acceptedFen: initialFen,
    state: 'PENDING_VERIFICATION',
    offline: true,
    manualPause: false,
    spectatorNotice: 'not-required',
    events: [{ at: now, type: 'pending', text: 'Waiting to verify the actual DGT position.' }],
    samples: [],
  };
}

/** Verify persisted history rather than trusting a serialized fen supplied by storage. */
export function validateStoredGame(game: LegalGame): LegalGame {
  const acceptedFen = replay(validateCompleteFen(game.initialFen), game.moves).fen();
  if (acceptedFen !== game.acceptedFen) throw new Error('Stored move history and recorded FEN disagree.');
  return {
    ...game,
    events: Array.isArray(game.events) ? game.events.slice(0, MAX_LOG) : [],
    samples: Array.isArray(game.samples) ? game.samples.slice(0, 80) : [],
    spectatorNotice: game.spectatorNotice === 'unsupported' ? 'unsupported' : 'not-required',
    // Preserve an interrupted/manual state over restart. No new move can
    // publish until a fresh physical observation has been verified.
    offline: true,
    state: game.state === 'MANUAL_INTERVENTION' || game.state === 'RECONCILIATION_REQUIRED'
      ? game.state : 'PENDING_VERIFICATION',
    reason: 'Restarted; waiting to reverify the physical board before publishing.',
    discrepancySince: undefined,
    stableSince: undefined,
  };
}

export function validateConfig(config: ReconciliationConfig): ReconciliationConfig {
  if (!Number.isInteger(config.stabilizeMs) || config.stabilizeMs < 200 || config.stabilizeMs > 20000)
    throw new Error('Stabilization must be between 200 ms and 20 seconds.');
  if (!Number.isInteger(config.alertMs) || config.alertMs < config.stabilizeMs || config.alertMs > 120000)
    throw new Error('Alert delay must be longer than stabilization and at most two minutes.');
  if (!Number.isInteger(config.manualMs) || config.manualMs < config.alertMs || config.manualMs > 600000)
    throw new Error('Manual intervention delay must be at least the alert delay and at most 10 minutes.');
  return config;
}

export function changeConnectivity(source: LegalGame, connected: boolean, now: number): LegalGame {
  const game = { ...source, events: [...source.events], offline: !connected };
  if (source.offline === !connected) return game;
  if (connected) {
    if (source.state !== 'MANUAL_INTERVENTION' && source.state !== 'RECONCILIATION_REQUIRED')
      game.state = 'PENDING_VERIFICATION';
    game.reason = source.state === 'MANUAL_INTERVENTION'
      ? 'Reconnected; manual reconciliation remains required.'
      : 'Reconnected. Waiting for a fresh physical board position.';
    game.physicalBoard = undefined;
    game.discrepancySince = undefined;
    game.stableSince = undefined;
    log(game, 'online', 'LiveChess reconnected; publication remains paused until the board is verified.', now);
  } else {
    // A stale physical position observed before a disconnect is never enough
    // to authorize publication after the connection is restored.
    game.physicalBoard = undefined;
    game.stableSince = undefined;
    game.reason = 'LiveChess or the DGT board disconnected. No move will be published until reverified.';
    log(game, 'offline', game.reason, now);
  }
  return game;
}

export function resumeAutomatic(source: LegalGame, now: number): LegalGame {
  const game = { ...source, events: [...source.events], manualPause: false };
  game.state = 'PENDING_VERIFICATION';
  game.discrepancySince = now;
  game.stableSince = now;
  game.reason = 'Operator requested automatic reconciliation. Waiting for a verified position.';
  log(game, 'pending', game.reason, now);
  return game;
}

export function setManualPause(source: LegalGame, paused: boolean, now: number): LegalGame {
  const game = { ...source, events: [...source.events], manualPause: paused };
  if (paused) {
    game.reason = 'Publication paused by the operator. Physical monitoring continues.';
  } else {
    game.state = 'PENDING_VERIFICATION';
    game.stableSince = now;
    game.reason = 'Manual pause released; awaiting fresh position verification.';
  }
  log(game, 'paused', game.reason || 'Publication pause changed.', now);
  return game;
}

function recover(game: LegalGame, now: number, manual: boolean): void {
  const wasInterrupted =
    game.state === 'RECONCILIATION_REQUIRED' || game.state === 'MANUAL_INTERVENTION';
  game.state = wasInterrupted ? 'RECOVERED' : 'LIVE';
  game.reason = undefined;
  game.discrepancySince = undefined;
  game.stableSince = undefined;
  game.spectatorNotice = 'not-required';
  if (wasInterrupted) log(game, manual ? 'manual' : 'recovered', manual ?
    'Operator-approved legal history matches the physical board. Publication restored.' :
    'Physical board reconciled with the accepted legal history. Publication restored.', now);
}

type Candidate = { moves: string[]; source: 'livechess' | 'physical' };
interface CandidateCheck { candidate?: Candidate; ambiguous: boolean; problem?: string }

function sameMoves(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((san, i) => san === b[i]);
}

/**
 * LiveChess reconstruction is used only when its full starting FEN and all
 * previously accepted moves agree. Even then the resulting physical
 * placement must match the sensor report.
 */
function fromReconstruction(game: LegalGame, physical: string): CandidateCheck {
  if (!game.reconstructedSan?.length || !game.reconstructionStart) return { ambiguous: false };
  let start: string;
  try {
    start = validateCompleteFen(game.reconstructionStart);
  } catch {
    return { ambiguous: false, problem: 'LiveChess supplied an incomplete reconstruction starting FEN.' };
  }
  if (start !== game.initialFen) return { ambiguous: false };
  let board: Chess;
  try {
    board = replay(start, game.reconstructedSan);
  } catch {
    return { ambiguous: false, problem: 'LiveChess reconstructed an illegal SAN move.' };
  }
  if (!sameMoves(game.moves, game.reconstructedSan.slice(0, game.moves.length)))
    return { ambiguous: false, problem: 'LiveChess reconstruction conflicts with previously accepted game history.' };
  if (placement(board.fen()) !== physical) return { ambiguous: false };
  const additional = game.reconstructedSan.slice(game.moves.length);
  return additional.length
    ? { candidate: { moves: additional, source: 'livechess' }, ambiguous: false }
    : { ambiguous: false };
}

/** A physical FEN contains no castling/en-passant history, so we enumerate
 * full legal continuations from our confirmed chess.js position. Never
 * infer a move if multiple valid histories explain the same piece placement.
 */
function fromPhysical(game: LegalGame, physical: string): CandidateCheck {
  const accepted = replay(game.initialFen, game.moves);
  const candidates: string[][] = [];
  const visit = (position: Chess, moves: string[], depth: number): void => {
    if (candidates.length > 1) return;
    if (depth > 0 && placement(position.fen()) === physical) {
      candidates.push(moves);
      return;
    }
    if (depth >= MAX_FALLBACK_DEPTH) return;
    for (const move of position.moves({ verbose: true })) {
      if (candidates.length > 1) break;
      const next = new Chess(position.fen());
      next.move(move.san);
      visit(next, [...moves, move.san], depth + 1);
    }
  };
  visit(accepted, [], 0);
  if (candidates.length === 1) return { candidate: { moves: candidates[0], source: 'physical' }, ambiguous: false };
  return {
    ambiguous: candidates.length > 1,
    problem: candidates.length > 1
      ? 'More than one legal move sequence explains the observed physical position.'
      : 'No unambiguous short legal continuation explains the physical board.',
  };
}

function candidateFor(game: LegalGame): CandidateCheck {
  if (!game.physicalBoard) return { ambiguous: false };
  const fromSan = fromReconstruction(game, game.physicalBoard);
  if (fromSan.candidate) return fromSan;
  const physical = fromPhysical(game, game.physicalBoard);
  // A contradictory LiveChess reconstruction is diagnostic, not grounds to
  // invent a move or reject an otherwise unambiguous physical reconstruction.
  return physical.candidate ? physical : {
    ...physical,
    problem: fromSan.problem || physical.problem,
  };
}

function applyCandidate(game: LegalGame, candidate: Candidate, now: number): void {
  const position = replay(game.initialFen, [...game.moves, ...candidate.moves]);
  if (placement(position.fen()) !== game.physicalBoard) throw new Error('Candidate no longer matches DGT sensors.');
  game.moves = [...game.moves, ...candidate.moves];
  game.acceptedFen = position.fen();
  log(game, 'accepted', 'Accepted ' + candidate.moves.join(' ') + ' from verified ' + candidate.source + ' history.', now);
  recover(game, now, false);
}

function reevaluate(game: LegalGame, now: number, config: ReconciliationConfig, clockPressed: boolean): void {
  if (game.offline || game.manualPause || !game.physicalBoard) return;
  // Once the system has declared reconstruction ambiguous, an explicit
  // operator decision is required, even if later sensor readings look legal.
  if (game.state === 'MANUAL_INTERVENTION') return;
  const stableFor = now - (game.stableSince ?? now);
  const confirmed = placement(game.acceptedFen);
  if (confirmed === game.physicalBoard) {
    recover(game, now, false);
    return;
  }

  const candidate = candidateFor(game);
  // A bare physical arrangement can temporarily resemble a legal rook move
  // during castling or an intermediate capture. Without a trusted complete
  // SAN reconstruction, use a longer quiet period before accepting it.
  const rookCouldBeCastling =
    candidate.candidate?.moves.length === 1 &&
    /^R/.test(candidate.candidate.moves[0]) &&
    /[KQkq]/.test(game.acceptedFen.split(' ')[2]);
  const requiredStable = candidate.candidate?.source === 'physical' || rookCouldBeCastling
    ? Math.max(config.stabilizeMs * 3, 2500)
    : config.stabilizeMs;
  if (candidate.candidate && stableFor >= requiredStable) {
    applyCandidate(game, candidate.candidate, now);
    return;
  }
  // A clock press made after a legal-looking piece placement is not an illegal
  // move notification. Wait for stabilization instead of alarming spectators.
  const inconsistentClockPress = clockPressed && !candidate.candidate;

  const since = game.discrepancySince ?? now;
  if (game.discrepancySince === undefined) game.discrepancySince = now;
  const elapsed = now - since;
  if (candidate.ambiguous && stableFor >= config.alertMs) {
    game.state = 'MANUAL_INTERVENTION';
    game.reason = candidate.problem;
    game.spectatorNotice = 'unsupported';
    log(game, 'ambiguous', game.reason || 'Unverifiable board state requires operator correction.', now);
  } else if (elapsed >= config.manualMs && stableFor >= config.alertMs) {
    game.state = 'MANUAL_INTERVENTION';
    game.reason = candidate.problem || 'Reconstruction timed out; operator verification required.';
    game.spectatorNotice = 'unsupported';
    log(game, 'ambiguous', game.reason, now);
  } else if (inconsistentClockPress || elapsed >= config.alertMs) {
    if (game.state !== 'RECONCILIATION_REQUIRED') {
      game.state = 'RECONCILIATION_REQUIRED';
      game.reason = inconsistentClockPress
        ? 'Clock state changed while the physical position was not reconciled.'
        : candidate.problem || 'Physical position remained unrecognized after stabilization.';
      game.spectatorNotice = 'unsupported';
      log(game, 'interrupted', game.reason, now);
    }
  } else {
    if (game.state !== 'PENDING_VERIFICATION') {
      log(game, 'pending', 'Observed a physical position that is not yet verified.', now);
    }
    game.state = 'PENDING_VERIFICATION';
    game.reason = 'Waiting for the physical move to finish and match a legal game position.';
  }
}

/** Process partial event messages without resetting fields that were omitted. */
export function observeLiveChess(
  source: LegalGame,
  event: LiveChessObservation,
  now: number,
  config: ReconciliationConfig = DEFAULT_RECONCILIATION,
): LegalGame {
  validateConfig(config);
  const game: LegalGame = { ...source, moves: [...source.moves], events: [...source.events] };
  if (event.sourceTime !== undefined) {
    if (!Number.isFinite(event.sourceTime)) return game;
    if (game.lastSourceTime !== undefined && event.sourceTime < game.lastSourceTime) return game;
    game.lastSourceTime = event.sourceTime;
  }
  const prevClock = game.clock;
  if (event.clock !== undefined) {
    if (event.clock === null) game.clock = undefined;
    else if (
      Number.isFinite(event.clock.white) && Number.isFinite(event.clock.black) &&
      Number.isFinite(event.clock.time)
    ) game.clock = { ...event.clock };
  }
  const clockPressed = !!prevClock && !!game.clock && prevClock.run !== game.clock.run &&
    prevClock.run !== null && game.clock.run !== null;
  if (event.board !== undefined && event.board !== game.physicalBoard) {
    game.physicalBoard = event.board;
    game.stableSince = now;
    if (game.discrepancySince === undefined) game.discrepancySince = now;
  }
  if (Array.isArray(event.san)) game.reconstructedSan = [...event.san];
  if (event.start !== undefined) game.reconstructionStart = event.start;
  if (event.match !== undefined) game.match = event.match;
  game.lastEventAt = now;
  game.samples = [{ at: now, physical: game.physicalBoard, match: game.match,
    reconstructedCount: game.reconstructedSan?.length, clockRun: game.clock?.run }, ...source.samples].slice(0, 80);
  game.offline = false;
  reevaluate(game, now, config, clockPressed);
  return game;
}

export function tickReconciliation(
  source: LegalGame,
  now: number,
  config: ReconciliationConfig = DEFAULT_RECONCILIATION,
): LegalGame {
  const game = { ...source, moves: [...source.moves], events: [...source.events] };
  if (game.state === 'RECOVERED') game.state = 'LIVE';
  reevaluate(game, now, validateConfig(config), false);
  return game;
}

function approve(game: LegalGame, moves: readonly string[], fullFen: string, now: number): LegalGame {
  const position = replay(game.initialFen, moves);
  const target = validateCompleteFen(fullFen);
  if (position.fen() !== target)
    throw new Error('Full FEN (including side, castling and en passant) does not match the validated legal history.');
  if (!game.physicalBoard || placement(target) !== game.physicalBoard)
    throw new Error('The confirmed legal position does not match the current physical DGT pieces.');
  const next = { ...game, moves: [...moves], events: [...game.events], acceptedFen: target, manualPause: false };
  recover(next, now, true);
  return next;
}

/** Operators may append missing legal moves, but not silently rewrite moves already published. */
export function approveManualSequence(
  game: LegalGame,
  additionalMoves: string[],
  fullFen: string,
  now: number,
): LegalGame {
  if (!additionalMoves.length) throw new Error('Enter the corrected missing move sequence.');
  return approve(game, [...game.moves, ...additionalMoves], fullFen, now);
}

/** Restoring a fully specified, *already accepted* legal position is non-destructive.
 * A different history requires an explicit corrected sequence; pushing an
 * arbitrary replacement PGN does not reliably delete existing Lichess moves.
 */
export function restoreKnownLegalPosition(game: LegalGame, fullFen: string, now: number): LegalGame {
  return approve(game, game.moves, fullFen, now);
}

export function canPublish(game: LegalGame): boolean {
  return !game.offline && !game.manualPause && game.state === 'LIVE' &&
    placement(game.acceptedFen) === game.physicalBoard;
}

/** Lichess's public OAuth API does not currently provide descChapter writes. */
export const SPECTATOR_INTERRUPTION =
  'Broadcast temporarily interrupted while the physical board position is verified. ' +
  'The last confirmed legal position remains displayed. The game result is not yet determined.';
export const SPECTATOR_UNSUPPORTED =
  'Blocked: no supported Lichess OAuth API for a broadcast chapter pinned description. ' +
  'Internal descChapter WebSocket messages require a browser-session authorization path. ' +
  'No browser cookies or UI automation are used.';
