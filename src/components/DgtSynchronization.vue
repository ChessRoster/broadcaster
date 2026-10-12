<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { toast } from 'vue3-toastify';
import { useDgtAuthorityStore, gameKey } from '../stores/dgt-authority';
import { useDgtMonitorStore } from '../stores/dgt-monitor';
import {
  SPECTATOR_INTERRUPTION,
  SPECTATOR_UNSUPPORTED,
  canPublish,
  replay,
  type LegalGame,
} from '../dgt-authoritative';

const props = defineProps<{ roundId: string; writable: boolean }>();
const authority = useDgtAuthorityStore();
const monitor = useDgtMonitorStore();
const busy = ref(false);
const form = reactive<Record<string, {
  moves: string;
  proposedFen: string;
  restoreFen: string;
  verified: boolean;
  reinitConfirmed: boolean;
}>>({});

const enabled = computed(() => authority.enabled(props.roundId));
const games = computed(() => Object.entries(authority.games)
  .filter(([, game]) => game.roundId === props.roundId)
  .sort((a, b) => a[1].boardNumber - b[1].boardNumber));
const mapped = computed(() => monitor.assignments.filter(item => item.roundId === props.roundId));

watch(games, list => {
  for (const [key, game] of list) {
    if (!form[key]) form[key] = {
      moves: '',
      proposedFen: '',
      restoreFen: game.acceptedFen,
      verified: false,
      reinitConfirmed: false,
    };
  }
}, { immediate: true });

function lastMove(game: LegalGame) {
  return game.moves.length ? game.moves[game.moves.length - 1] : '(start position)';
}

function recent(at?: number) {
  return at ? new Date(at).toLocaleTimeString() : 'Not received';
}

function displayState(game: LegalGame) {
  if (game.offline) return 'OFFLINE (' + game.state + ')';
  return game.state;
}

function showError(error: unknown) {
  toast.error(String(error));
}

function enable() {
  try {
    authority.enable(props.roundId);
    toast.info('WebSocket is now the only PGN source for this round. Load Lichess pairings next.');
  } catch (error) { showError(error); }
}

async function load() {
  busy.value = true;
  try {
    const count = await authority.loadPairings(props.roundId, monitor.assignments);
    for (const [, game] of Object.entries(authority.games).filter(([, g]) => g.roundId === props.roundId)) {
      const live = monitor.boards[game.serialnr];
      if (monitor.status === 'connected' && live) {
        authority.onBoard(game.serialnr, {
          board: live.board,
          san: live.san,
          start: live.start,
          match: live.match,
          clock: live.clock,
        });
      }
    }
    toast.success('Loaded ' + count + ' Lichess pairings. No unverified move history imported.');
  } catch (error) { showError(error); }
  finally { busy.value = false; }
}

function splitSan(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function preview(key: string) {
  try {
    const game = authority.requireGame(key);
    const fullFen = replay(game.initialFen, [...game.moves, ...splitSan(form[key].moves)]).fen();
    form[key].proposedFen = fullFen;
    form[key].restoreFen = fullFen;
    toast.info('Validated SAN continuation. Verify the complete FEN and the actual physical pieces.');
  } catch (error) { showError(error); }
}

function approve(key: string) {
  try {
    if (!form[key].verified) throw new Error('Confirm the physical position and complete FEN before approving.');
    authority.approveMoves(key, splitSan(form[key].moves).join(' '), form[key].restoreFen);
    form[key].moves = '';
    form[key].verified = false;
    toast.success('Legal sequence accepted; publication resumes after verification.');
  } catch (error) { showError(error); }
}

function restore(key: string) {
  try {
    if (!form[key].verified) throw new Error('Explicit verification of the full legal FEN is required.');
    authority.restoreKnown(key, form[key].restoreFen);
    form[key].verified = false;
    toast.success('The verified accepted legal position was restored.');
  } catch (error) { showError(error); }
}

function reinitialize(game: LegalGame, key: string) {
  try {
    if (!form[key].reinitConfirmed)
      throw new Error('Confirm the effect of the LiveChess setup command before sending.');
    monitor.reinitializeVerifiedGame(game.serialnr, game.acceptedFen);
    form[key].reinitConfirmed = false;
    toast.info('LiveChess setup requested. Publication remains suspended until validation.');
  } catch (error) { showError(error); }
}
</script>

<template>
  <section class="my-6 rounded-lg border border-indigo-500/40 p-5 text-gray-200" aria-label="Authoritative game synchronization">
    <h3 class="text-xl font-bold text-white">WebSocket legal-game recorder</h3>
    <p class="mt-2 text-sm">
      Lichess provides the pairing identity. DGT provides the physical board. Broadcaster maintains and publishes
      only its separately validated legal move history. LiveChess reconstructed SAN is checked, not trusted blindly.
    </p>
    <div v-if="!enabled" class="mt-3">
      <p class="text-sm text-amber-200">
        The original folder-based PGN uploader remains active until you explicitly enable this recording mode.
      </p>
      <button
        type="button"
        :disabled="!writable"
        class="mt-2 rounded bg-indigo-500 px-3 py-2 font-semibold text-white disabled:opacity-50"
        @click="enable"
      >
        Use DGT WebSocket as primary source for this round
      </button>
    </div>
    <template v-else>
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <span class="rounded bg-green-900 px-3 py-1 text-sm text-green-100">WebSocket primary; PGN folder disabled</span>
        <button
          type="button"
          :disabled="busy || !writable"
          class="rounded bg-indigo-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          @click="load"
        >
          Load / verify pairings from Lichess
        </button>
        <button
          type="button"
          class="rounded bg-white/10 px-3 py-2 text-sm"
          @click="authority.disable(roundId)"
        >
          Return to file-based PGN upload
        </button>
      </div>
      <p class="mt-2 text-xs text-gray-400">
        A saved legal history is never erased when recording mode is disabled, and importing pairings cannot
        overwrite it. Re-enable only after checking that no other publisher is still sending this round.
      </p>

      <p v-if="!mapped.length" role="alert" class="mt-3 text-amber-300">
        Assign DGT serial numbers to the Lichess board numbers in the monitoring panel before loading pairings.
      </p>
      <p v-if="authority.errors[roundId]" role="alert" class="mt-2 text-red-300">
        {{ authority.errors[roundId] }}
      </p>

      <div v-if="games.length" class="mt-5 space-y-4">
        <article v-for="[key, game] in games" :key="key" class="rounded-lg border border-white/10 bg-gray-900/50 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 class="font-semibold text-white">
                Board {{ game.boardNumber }} · {{ game.white }} vs {{ game.black }}
              </h4>
              <p class="text-xs text-gray-400">DGT serial {{ game.serialnr }}</p>
            </div>
            <span
              class="rounded px-2 py-1 text-sm font-semibold"
              :class="canPublish(game) ? 'bg-green-900 text-green-200' : 'bg-amber-900 text-amber-200'"
            >
              {{ displayState(game) }}
            </span>
          </div>

          <dl class="mt-3 grid gap-x-4 gap-y-2 text-sm md:grid-cols-2">
            <div><dt class="text-gray-400">Last accepted move</dt><dd>{{ lastMove(game) }} · {{ game.moves.length }} plies</dd></div>
            <div><dt class="text-gray-400">Last LiveChess event</dt><dd>{{ recent(game.lastEventAt) }}</dd></div>
            <div class="md:col-span-2">
              <dt class="text-gray-400">Accepted complete FEN</dt>
              <dd class="break-all font-mono text-xs">{{ game.acceptedFen }}</dd>
            </div>
            <div class="md:col-span-2">
              <dt class="text-gray-400">Latest physical DGT piece placement</dt>
              <dd class="break-all font-mono text-xs">{{ game.physicalBoard || 'Not yet observed' }}</dd>
            </div>
            <div>
              <dt class="text-gray-400">LiveChess reconstruction</dt>
              <dd>{{ game.reconstructedSan?.length ?? 'Unknown' }} plies · match {{ game.match === undefined ? 'unknown' : game.match }}</dd>
            </div>
            <div>
              <dt class="text-gray-400">Last accepted upload</dt>
              <dd>{{ recent(game.lastPublishedAt) }}</dd>
            </div>
            <div v-if="game.reason" class="md:col-span-2">
              <dt class="text-amber-300">Why publication is suspended</dt>
              <dd role="alert" class="text-amber-200">{{ game.reason }}</dd>
            </div>
            <div class="md:col-span-2">
              <dt class="text-gray-400">Spectator-facing interruption notice</dt>
              <dd v-if="game.spectatorNotice === 'unsupported'" class="text-amber-300">
                BLOCKED. No supported Lichess OAuth chapter-description update API; the warning is visible
                to operators here, not to spectators.
              </dd>
              <dd v-else class="text-gray-400">No notice currently required</dd>
            </div>
          </dl>

          <div class="mt-4 flex flex-wrap gap-2">
            <button type="button" class="rounded bg-white/10 px-3 py-2 text-sm"
              @click="authority.resumeAuto(key)">Resume automatic reconciliation</button>
            <button type="button" class="rounded bg-white/10 px-3 py-2 text-sm"
              @click="authority.manualPause(key, !game.manualPause)">
              {{ game.manualPause ? 'Resume publication checks' : 'Pause publication manually' }}
            </button>
          </div>

          <div v-if="game.state !== 'LIVE' || game.manualPause" class="mt-4 space-y-3 rounded border border-amber-900 p-3">
            <h5 class="font-semibold text-amber-200">Operator reconciliation</h5>
            <label class="block text-sm">
              Missing corrected legal SAN sequence (append only)
              <input v-model="form[key].moves" placeholder="e4 e5 Nf3" autocomplete="off"
                class="mt-1 w-full rounded bg-white/5 p-2 text-white" />
            </label>
            <button type="button" class="rounded bg-white/10 px-3 py-2 text-sm" @click="preview(key)">
              Validate moves and preview full FEN
            </button>
            <p v-if="form[key].proposedFen" class="break-all font-mono text-xs text-gray-300">
              Proposed: {{ form[key].proposedFen }}
            </p>
            <label class="block text-sm">
              Known correct complete six-field FEN (side to move, castling, en passant, halfmove, fullmove)
              <input v-model="form[key].restoreFen" autocomplete="off"
                class="mt-1 w-full rounded bg-white/5 p-2 font-mono text-xs text-white" />
            </label>
            <label class="flex items-start gap-2 text-sm">
              <input v-model="form[key].verified" type="checkbox" class="mt-1" />
              I verified the actual physical pieces and every field of the legal position.
            </label>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="rounded bg-indigo-600 px-3 py-2 text-sm"
                @click="approve(key)">Accept corrected legal sequence</button>
              <button type="button" class="rounded bg-amber-700 px-3 py-2 text-sm"
                @click="restore(key)">Restore last known legal state</button>
            </div>
            <p class="text-xs text-gray-400">
              Restoring a position with different castling/en-passant rights requires a validated move
              history establishing those rights. Arbitrary midgame FEN substitution is not published:
              Lichess push cannot safely replace a conflicting earlier chapter history without a reset.
            </p>
            <label class="flex items-start gap-2 text-sm">
              <input v-model="form[key].reinitConfirmed" type="checkbox" class="mt-1" />
              I confirm reinitializing this LiveChess feed using the accepted legal FEN, and understand
              it can change LiveChess's own reconstruction state.
            </label>
            <button type="button" class="rounded bg-white/10 px-3 py-2 text-sm"
              @click="reinitialize(game, key)">Reinitialize LiveChess move recognition</button>
          </div>
          <details class="mt-3 text-xs text-gray-400">
            <summary class="cursor-pointer">Recent board observations and reconstruction events</summary>
            <ul class="mt-2 max-h-44 space-y-1 overflow-y-auto">
              <li v-for="(event, i) in game.events.slice(0, 25)" :key="i">
                {{ recent(event.at) }} [{{ event.type }}] {{ event.text }}
              </li>
            </ul>
            <p class="mt-2">Recent physical events retained: {{ game.samples.length }} (up to 80 across app restarts).</p>
          </details>
        </article>
      </div>

      <div class="mt-4 rounded border border-amber-800 bg-amber-950/20 p-3 text-sm text-amber-200">
        <p class="font-semibold">Spectator status API limitation</p>
        <p class="mt-1">{{ SPECTATOR_INTERRUPTION }}</p>
        <p class="mt-2 text-xs">{{ SPECTATOR_UNSUPPORTED }}</p>
      </div>
    </template>
  </section>
</template>
