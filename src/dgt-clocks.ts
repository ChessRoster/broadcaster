/**
 * DGT LiveChess abbreviates clock values as H:MM or H:MM.SS, where the dot
 * separates minutes from seconds. Lichess interprets two-component
 * WhiteClock/BlackClock header values as M:SS, so use unambiguous H:MM:SS.
 *
 * Run only for identified DGT PGNs and keep the source files unchanged.
 */
export interface DgtClockNormalization {
  pgn: string;
  changedAnnotations: number;
  changedGames: number;
  warnings: string[];
}

const dgtInput = /^\[Input[ \t]+"DGT[^"\r\n]*"\]$/im;
const dgtCurrentClock = /^\[Clock[ \t]+"[WB]\/\d+:\d{2}(?:\.\d{2})?"\]$/im;
const playerClockHeader = /^\[(?:WhiteClock|BlackClock)[ \t]+"[^"\r\n]*"\]$/im;
const headerClock = /^(\[(?:WhiteClock|BlackClock)[ \t]+")([^"\r\n]*)("\])$/gim;
const moveClock = /(\[%clk[ \t]+)([^\]\r\n]+)(\])/gi;

function standardClock(hours: string, minutes: string, seconds = '00'): string | undefined {
  const h = Number(hours);
  const m = Number(minutes);
  const s = Number(seconds);
  if (!Number.isSafeInteger(h) || h < 0 || m > 59 || s > 59) return undefined;
  return `${h}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}`;
}

/** Convert DGT's H:MM or H:MM.SS clock notation to unambiguous H:MM:SS. */
export function normalizeDgtClockValue(value: string): string | undefined {
  const wholeMinutes = /^(\d{1,3}):([0-5]\d)$/.exec(value);
  if (wholeMinutes) return standardClock(wholeMinutes[1], wholeMinutes[2]);

  const minuteAndSecond = /^(\d{1,3}):([0-5]\d)\.([0-5]\d)$/.exec(value);
  if (minuteAndSecond) return standardClock(minuteAndSecond[1], minuteAndSecond[2], minuteAndSecond[3]);

  const canonical = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(value);
  if (canonical) return standardClock(canonical[1], canonical[2], canonical[3]);

  return undefined;
}

export function normalizeDgtClockPgn(pgn: string): DgtClockNormalization {
  let changedAnnotations = 0;
  let changedGames = 0;
  const warnings: string[] = [];

  // Standard LiveChess multi-game PGNs start each game with an Event tag.
  // Preserve unrelated headers, moves, results and line endings exactly.
  const chunks = pgn.split(/(?=^\[Event[ \t]+")/gm);
  const output = chunks.map((chunk, index) => {
    const gap = /\r?\n\r?\n/.exec(chunk);
    if (!gap) return chunk;

    const head = chunk.slice(0, gap.index);
    const isDgt = dgtInput.test(head) || (dgtCurrentClock.test(head) && playerClockHeader.test(head));
    if (!isDgt) return chunk;

    let gameChanges = 0;
    const convert = (value: string, label: string): string => {
      const normalized = normalizeDgtClockValue(value.trim());
      if (!normalized) {
        // Do not invent a clock value when the source format is unknown.
        warnings.push(`Game ${index + 1}: unsupported DGT ${label} value '${value}'`);
        return value;
      }
      if (normalized !== value) {
        changedAnnotations++;
        gameChanges++;
      }
      return normalized;
    };

    const convertedHead = head.replace(headerClock, (_entire, left: string, value: string, right: string) => {
      return `${left}${convert(value, 'header clock')}${right}`;
    });

    const contentStart = gap.index + gap[0].length;
    const convertedMoves = chunk
      .slice(contentStart)
      .replace(moveClock, (_entire, left: string, value: string, right: string) => {
        return `${left}${convert(value, 'move clock')}${right}`;
      });

    if (gameChanges) changedGames++;
    return convertedHead + gap[0] + convertedMoves;
  });

  return { pgn: output.join(''), changedAnnotations, changedGames, warnings };
}
