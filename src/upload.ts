import { readDir, readTextFile } from '@tauri-apps/plugin-fs';
import { lichessApiClient } from './client';
import { join, sep } from '@tauri-apps/api/path';
import { BroadcastPgnPushTags } from './types';
import { useLogStore } from './stores/logs';
import { normalizeDgtClockPgn } from './dgt-clocks';
import { useDgtMonitorStore } from './stores/dgt-monitor';

const clockNoticeRounds = new Set<string>();
const clockWarningsShown = new Set<string>();

export const isPgnFile = (path: string): boolean => path.endsWith('.pgn');
export const isMultiGamePgn = (path: string): boolean => path === 'games.pgn' || path.endsWith(`${sep()}games.pgn`);

export async function fileList(folder: string, recursive: boolean = false): Promise<string[]> {
  const files: string[] = [];
  const entries = await readDir(folder);

  for (const entry of entries) {
    if (entry.isDirectory && recursive) {
      const subfolder = await join(folder, entry.name);
      files.push(...(await fileList(subfolder, recursive)));
    } else {
      files.push(await join(folder, entry.name));
    }
  }

  return files;
}

export function sortFiles(files: string[]): string[] {
  const gameId = (file: string) => Number.parseInt(/(\d+)\D*$/.exec(file)?.[1] ?? '0', 10);
  return files.sort((a, b) => gameId(a) - gameId(b));
}

export function filesToUpload(files: string[]): string[] {
  const pgnFiles = files.filter(isPgnFile);
  const otherPgnFiles = pgnFiles.filter(f => !isMultiGamePgn(f));

  if (otherPgnFiles.length > 0) {
    return sortFiles(otherPgnFiles);
  } else {
    return pgnFiles; // only games.pgn, or nothing
  }
}

export async function uploadFolderToRound(roundId: string, folder: string): Promise<void> {
  const files = await fileList(folder, true);

  const toUpload = filesToUpload(files);

  const contents = await Promise.all(toUpload.map(file => readTextFile(file)));
  await pushPgnToRound(roundId, contents.join('\n\n'));
}

async function pushPgnToRound(roundId: string, pgn: string): Promise<void> {
  const logs = useLogStore();

  // Rewrite only recognized DGT clock notation. Never modify the PGNs on disk.
  const normalized = normalizeDgtClockPgn(pgn);
  if (normalized.changedAnnotations && !clockNoticeRounds.has(roundId)) {
    clockNoticeRounds.add(roundId);
    logs.info(
      `Normalized DGT clock annotations for Lichess (${normalized.changedAnnotations} updates across ${normalized.changedGames} games).`,
    );
  }
  for (const warning of normalized.warnings) {
    const key = `${roundId}:${warning}`;
    if (!clockWarningsShown.has(key)) {
      clockWarningsShown.add(key);
      logs.error(`DGT clock: ${warning}`);
    }
  }


  // A mapped, actively monitored board can block only its own suspect game.
  // Never manufacture a clock value or overwrite the operator's local PGN.
  const monitor = useDgtMonitorStore();
  const guard = monitor.prepareUpload(roundId, normalized.pgn);
  monitor.recordUploadGuard(roundId, guard);
  if (!guard.pgn.trim()) return;

  const pushResponse = await lichessApiClient({
    'Content-Type': 'text/plain',
  }).POST('/api/broadcast/round/{broadcastRoundId}/push', {
    params: { path: { broadcastRoundId: roundId } },
    body: guard.pgn,
    bodySerializer: body => body,
  });

  const successes: {
    games: number;
    moves: number;
  } = { games: 0, moves: 0 };
  const errors: string[] = [];

  for (const game of pushResponse.data?.games || []) {
    const gameName = `[Round ${pgnTag('Round', game.tags)}] ${pgnTag('White', game.tags)} vs ${pgnTag('Black', game.tags)}`;
    if (game.error) {
      errors.push(`${gameName}: ${game.error}`);
    } else if (game.moves && game.moves > 0) {
      successes.games += 1;
      successes.moves += game.moves;
    }
  }

  if (errors.length) {
    logs.error(errors.join(', '));
  }
  if (successes.games > 0) {
    logs.info(`Uploaded ${successes.games} games, ${successes.moves} moves`);
  }
}

export function pgnTag(tag: string, tags: BroadcastPgnPushTags): string {
  return tags[tag] ?? `<${tag}>`;
}
