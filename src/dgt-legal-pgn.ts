import { Chess } from 'chess.js';
import { STARTING_FEN, replay, validateCompleteFen, type LegalGame, type PairingMetadata } from './dgt-authoritative';

const HEADER_RE = /^\[([A-Za-z][A-Za-z0-9_]*) "((?:[^"\\]|\\["\\])*)"\]$/;

function decodeHeader(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

/** Only pairing metadata is read from Lichess. Its move list is not trusted
 * as the local recorder's accepted legal history after a game is initialized.
 */
export function parseBroadcastPairings(roundId: string, pgn: string): PairingMetadata[] {
  if (!/^[A-Za-z0-9]{8}$/.test(roundId)) throw new Error('Invalid broadcast round ID.');
  if (pgn.length > 2 * 1024 * 1024) throw new Error('Pairings PGN is too large.');
  const chunks = pgn.replace(/^\uFEFF/, '').split(/(?=^\[Event\s+")/gm).filter(s => s.trim());
  if (!chunks.length) throw new Error('No games in the Lichess broadcast PGN.');

  const used = new Set<number>();
  return chunks.map(game => {
    const headers: Record<string, string> = {};
    const separator = /\r?\n\r?\n/.exec(game);
    if (!separator) throw new Error('Malformed PGN, missing blank line before moves.');
    for (const line of game.slice(0, separator.index).trim().split(/\r?\n/)) {
      const m = HEADER_RE.exec(line.trim());
      if (!m) throw new Error('Malformed PGN header: ' + line);
      if (Object.prototype.hasOwnProperty.call(headers, m[1])) throw new Error('Duplicate ' + m[1] + ' header.');
      headers[m[1]] = decodeHeader(m[2]);
    }
    const number = headers.Board || /^\d+\.(\d+)$/.exec(headers.Round || '')?.[1];
    if (!number || !/^[1-9]\d*$/.test(number)) throw new Error('PGN needs a numeric Board or Round n.board tag.');
    const boardNumber = Number(number);
    if (!Number.isSafeInteger(boardNumber) || used.has(boardNumber)) throw new Error('Duplicate or invalid board number.');
    used.add(boardNumber);
    const white = headers.White?.trim();
    const black = headers.Black?.trim();
    if (!white || !black || /^(?:\?|bye|unknown)$/i.test(white) || /^(?:\?|bye|unknown)$/i.test(black))
      throw new Error('Broadcast board ' + boardNumber + ' has missing player names.');
    if (headers.FEN && headers.SetUp !== '1') throw new Error('Custom starting positions require SetUp "1".');
    const initialFen = validateCompleteFen(headers.FEN || STARTING_FEN);
    return { roundId, boardNumber, white, black, initialFen, headers };
  });
}

/** The actual submitted PGN is generated from chess.js, never from physical
 * piece placement, unsanitized SAN strings or LiveChess's on-disk PGN.
 */
export function legalBroadcastPgn(game: LegalGame): string {
  const board = replay(game.initialFen, game.moves);
  if (board.fen() !== game.acceptedFen) throw new Error('Refusing to publish corrupted legal-game state.');
  const headers: Record<string, string> = {
    ...game.headers,
    White: game.white,
    Black: game.black,
    Board: String(game.boardNumber),
    Result: '*',
  };
  // PGN clock headers may be historical and may be mistakenly interpreted as
  // live values by Lichess. Use the raw physical observations for diagnostics;
  // separate clock sync is deliberately out of scope.
  delete headers.WhiteClock;
  delete headers.BlackClock;
  delete headers.Clock;
  delete headers.ReferenceTime;
  delete headers.Termination;
  if (game.initialFen !== STARTING_FEN) {
    headers.SetUp = '1';
    headers.FEN = game.initialFen;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) continue;
    board.header(name, value);
  }
  let pgn = board.pgn({ maxWidth: 0 });
  // An unfinished broadcast must never be adjudicated from a board mismatch.
  if (!/(?:^|\s)\*\s*$/.test(pgn)) pgn += ' *';
  const verification = new Chess();
  verification.loadPgn(pgn);
  if (verification.fen() !== board.fen())
    throw new Error('Generated PGN failed legal round-trip validation.');
  return pgn;
}
