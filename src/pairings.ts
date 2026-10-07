// Accept only complete, unplayed pairing PGN with explicit physical board numbers.
// Chapter order is never evidence of physical board order. Round n.board is explicit.
export function pairingPgn(source: string, expectedBoards: number, roundNumber: number): string {
  if (!Number.isInteger(expectedBoards) || expectedBoards < 1 || expectedBoards > 500)
    throw new Error('Expected board count must be between 1 and 500.');
  if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > 100)
    throw new Error('LiveChess round must be between 1 and 100.');
  if (new TextEncoder().encode(source).length > 1048576) throw new Error('PGN exceeds 1 MiB.');
  const games: Map<string, string>[] = [];
  let tags = new Map<string, string>();
  let ended = false;
  for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const match = /^\[([A-Za-z][A-Za-z0-9_]*) "((?:[^"\\]|\\["\\])*)"\]$/.exec(text);
    if (match) {
      if (ended) {
        games.push(tags);
        tags = new Map();
        ended = false;
      }
      if (tags.has(match[1])) throw new Error(`Duplicate ${match[1]} PGN header.`);
      tags.set(match[1], match[2].replace(/\\(["\\])/g, '$1'));
    } else if (text === '*' && tags.size && !ended) {
      ended = true;
    } else {
      throw new Error('Waiting for complete pairing PGN: moves, comments or malformed tags are not accepted.');
    }
  }
  if (!ended) throw new Error('Waiting for complete pairing PGN ending in *.');
  games.push(tags);
  if (games.length !== expectedBoards)
    throw new Error(`Waiting for ${expectedBoards} boards; Lichess currently has ${games.length}.`);
  const boards = new Map<number, Map<string, string>>();
  const sourceRounds = new Set<string>();
  for (const game of games) {
    const suffix = /^([1-9]\d*)\.([1-9]\d*)$/.exec(game.get('Round') || '');
    const board = game.get('Board') || suffix?.[2] || '';
    if (!/^[1-9]\d*$/.test(board))
      throw new Error('Every game needs an explicit numeric Board header or Round round.board header.');
    if (suffix) {
      sourceRounds.add(suffix[1]);
      if (game.has('Board') && game.get('Board') !== suffix[2])
        throw new Error('Board and Round board suffix disagree.');
    } else if (!game.has('Board')) throw new Error('Missing board number.');
    const n = Number(board);
    if (n > expectedBoards || boards.has(n))
      throw new Error('Board numbers must be unique and cover 1 through the expected board count.');
    for (const side of ['White', 'Black']) {
      const name = game.get(side)?.trim();
      if (!name || ['?', 'bye'].includes(name.toLowerCase()))
        throw new Error(`Board ${n} needs both player names; byes are not supported.`);
    }
    if (game.get('Result') !== '*') throw new Error('Only unplayed games with Result "*" can be imported.');
    if (game.has('FEN') || game.has('SetUp')) throw new Error('Custom starting positions are not supported.');
    game.set('Round', String(roundNumber));
    game.set('Board', board);
    boards.set(n, game);
  }
  if (sourceRounds.size > 1) throw new Error('Round board suffixes must use the same source round.');
  return (
    [...boards.entries()]
      .sort(([a], [b]) => a - b)
      .map(
        ([, game]) =>
          [...game.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `[${key} "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`)
            .join('\n') + '\n\n*',
      )
      .join('\n\n') + '\n'
  );
}

export interface PairingMapping {
  roundId: string;
  lichessUrl: string;
  username?: string;
  tournamentId: string;
  roundNumber: number;
  expectedBoards: number;
  enabled: boolean;
  completed: boolean;
  message: string;
  pending?: { requestId: string; pgn: string };
}

export interface PairingTour {
  tourId: string;
  lichessUrl: string;
  username: string;
  tournamentId: string;
  startRoundId: string;
  localStartingRound: number;
  expectedBoards: number;
  knownRoundIds: string[];
  enabled: boolean;
  message: string;
}

export function matchingIdentity(
  item: { lichessUrl: string; username?: string },
  url: string,
  username?: string | null,
) {
  return !!username && item.lichessUrl === url && item.username === username;
}

// Freeze observed round order. Reordering/deleting rounds cannot shift destination numbers.
// Discover only the oldest unfinished round; later rounds cannot bypass a failed import.
export function nextTourMapping(
  tour: PairingTour,
  roundIds: string[],
  mappings: PairingMapping[],
): PairingMapping | undefined {
  const start = roundIds.indexOf(tour.startRoundId);
  if (start < 0) throw new Error('Configured starting Lichess round no longer exists.');
  const ids = roundIds.slice(start);
  if (new Set(ids).size !== ids.length || ids.some(id => !/^[A-Za-z0-9]{8}$/.test(id)))
    throw new Error('Invalid or duplicate Lichess round IDs.');
  if (tour.knownRoundIds.some((id, index) => ids[index] !== id))
    throw new Error('Lichess round order changed. Pause and review the tournament mapping.');
  tour.knownRoundIds = ids;
  for (let index = 0; index < ids.length; index++) {
    const localRound = tour.localStartingRound + index;
    if (localRound > 100) throw new Error('Destination round exceeds LiveChess limit of 100.');
    const existing = mappings.find(m => m.lichessUrl === tour.lichessUrl && m.roundId === ids[index]);
    if (existing) {
      if (existing.tournamentId !== tour.tournamentId || existing.roundNumber !== localRound)
        throw new Error('Existing round mapping conflicts with automatic tournament mapping.');
      if (!existing.completed) return existing;
    } else {
      if (mappings.some(m => m.tournamentId === tour.tournamentId && m.roundNumber === localRound))
        throw new Error('Destination round already has another mapping.');
      return {
        roundId: ids[index],
        lichessUrl: tour.lichessUrl,
        username: tour.username,
        tournamentId: tour.tournamentId,
        roundNumber: localRound,
        expectedBoards: tour.expectedBoards,
        enabled: true,
        completed: false,
        message: 'Waiting for complete pairings from Lichess.',
      };
    }
  }
  return undefined;
}

export interface PairingSyncDependencies {
  fetchPgn: (mapping: PairingMapping) => Promise<string>;
  importPgn: (mapping: PairingMapping, pgn: string, requestId: string) => Promise<{ status: string }>;
  persist: () => void;
  requestId: () => string;
}

// Pending content is committed before invocation and never replaced on retry.
// A lost HTTP response must reconcile the original request, not import a new one.
export async function syncPairings(mapping: PairingMapping, dependencies: PairingSyncDependencies) {
  if (!mapping.enabled || mapping.completed) return;
  try {
    if (!mapping.pending) {
      const pgn = pairingPgn(await dependencies.fetchPgn(mapping), mapping.expectedBoards, mapping.roundNumber);
      if (!mapping.enabled) return;
      mapping.pending = { requestId: dependencies.requestId(), pgn };
    }
    dependencies.persist();
    const result = await dependencies.importPgn(mapping, mapping.pending.pgn, mapping.pending.requestId);
    if (!['imported', 'already_imported'].includes(result.status))
      throw new Error('LiveChess did not confirm the import.');
    mapping.completed = true;
    mapping.enabled = false;
    mapping.message = 'Pairings imported. Start recording in LiveChess when ready.';
    delete mapping.pending;
    dependencies.persist();
  } catch (error) {
    mapping.message = String(error instanceof Error ? error.message : error);
  }
}
