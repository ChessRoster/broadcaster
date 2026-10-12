<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { toast } from 'vue3-toastify';
import { dgtBoardHealth, type DgtBoardState } from '../dgt-monitor-core';
import { useDgtMonitorStore } from '../stores/dgt-monitor';

const props = defineProps<{ roundId?: string }>();
const monitor = useDgtMonitorStore();
const slots = reactive<Record<string, number>>({});
const boards = computed(() => Object.values(monitor.boards).sort((a, b) => a.serialnr.localeCompare(b.serialnr)));
const assignments = computed(() => monitor.assignments.filter(item => item.roundId === props.roundId));

watch(
  [boards, assignments],
  () => {
    for (const board of boards.value) {
      const number = assignments.value.find(item => item.serialnr === board.serialnr)?.boardNumber;
      if (number !== undefined && slots[board.serialnr] === undefined) slots[board.serialnr] = number;
    }
  },
  { immediate: true },
);

function formatClock(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.floor(value);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') :
    String(m) + ':' + String(s).padStart(2, '0');
}

function statusLabel(board: DgtBoardState): string {
  if (board.state === 'NOTRESPONDING') return 'Not responding';
  if (board.alerted) return 'Position needs attention';
  if (board.match === false) return 'Reconciling board activity';
  if (board.match === true) return 'Position synchronized';
  return board.state || 'Waiting for position';
}

async function connect() {
  try {
    await monitor.connect();
    toast.success('Connected to LiveChess and received board inventory.');
  } catch (error) {
    toast.error(String(error));
  }
}

function setupStandard(serialnr: string) {
  try {
    monitor.setupStandardReconstruction(serialnr);
    toast.info('Requested a fresh standard-chess reconstruction from LiveChess.');
  } catch (error) {
    toast.error(String(error));
  }
}

function assign(serialnr: string) {
  if (!props.roundId) return;
  try {
    monitor.setAssignment(props.roundId, serialnr, Number(slots[serialnr]));
    toast.success('Board mapping saved for this round.');
  } catch (error) {
    toast.error(String(error));
  }
}

function currentBoard(serialnr: string): number | undefined {
  return assignments.value.find(item => item.serialnr === serialnr)?.boardNumber;
}
</script>

<template>
  <section class="my-6 rounded-lg border border-white/10 p-5 text-gray-300" aria-label="DGT LiveChess monitoring">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 class="text-lg font-semibold text-white">DGT LiveChess board monitoring</h3>
        <p class="mt-1 text-sm text-gray-400">
          Watch physical boards and reconstruction status through the existing LiveChess WebSocket API.
        </p>
      </div>
      <span
        role="status"
        class="rounded px-3 py-1 text-sm font-semibold"
        :class="
          monitor.status === 'connected'
            ? 'bg-green-900 text-green-200'
            : monitor.status === 'connecting' || monitor.status === 'reconnecting'
              ? 'bg-amber-900 text-amber-200'
              : 'bg-gray-800 text-gray-300'
        "
      >
        {{ monitor.status === 'connected' ? 'Connected to LiveChess' : monitor.status }}
      </span>
    </div>

    <div class="mt-4 flex flex-wrap gap-5 text-sm">
      <label class="inline-flex items-center gap-2">
        <input v-model="monitor.mode" type="radio" value="local" :disabled="monitor.status === 'connecting'" />
        Local LiveChess (this computer)
      </label>
      <label class="inline-flex items-center gap-2">
        <input v-model="monitor.mode" type="radio" value="lan" :disabled="monitor.status === 'connecting'" />
        LiveChess on another LAN computer
      </label>
    </div>
    <div class="mt-3 grid gap-3 md:grid-cols-3">
      <label v-if="monitor.mode === 'lan'" class="text-sm md:col-span-2">
        Hostname or private IP address
        <input
          v-model.trim="monitor.host"
          autocomplete="off"
          placeholder="192.168.1.20 or dgt-pc.local"
          class="mt-1 block w-full rounded bg-white/5 p-2 text-white ring-1 ring-white/10"
        />
      </label>
      <label class="text-sm">
        Port
        <input
          v-model.number="monitor.port"
          type="number"
          min="1"
          max="65535"
          class="mt-1 block w-28 rounded bg-white/5 p-2 text-white ring-1 ring-white/10"
        />
      </label>
    </div>
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        @click="connect"
        class="rounded bg-indigo-500 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-400"
      >
        {{ monitor.status === 'connected' ? 'Reconnect / apply settings' : 'Connect and test' }}
      </button>
      <button
        v-if="monitor.status !== 'disconnected'"
        type="button"
        class="rounded bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
        @click="monitor.disconnect()"
      >
        Disconnect
      </button>
      <span v-if="monitor.status === 'connected'" class="text-sm text-green-300">
        {{ boards.length }} board{{ boards.length === 1 ? '' : 's' }} discovered
      </span>
    </div>
    <p v-if="monitor.endpoint" class="mt-2 break-all text-xs text-gray-400">{{ monitor.endpoint }}</p>
    <p v-if="monitor.error" role="alert" class="mt-2 text-sm text-amber-300">{{ monitor.error }}</p>
    <p class="mt-3 text-xs text-gray-400">
      Works only with a reachable LiveChess installation listening on port 1982. LAN access depends on LiveChess
      binding, firewalls, and the desktop WebView's WebSocket policy. Monitoring stays connected while you navigate
      within Broadcaster. Connections are unencrypted: use a trusted local network.
    </p>

    <div v-if="boards.length" class="mt-5 space-y-3">
      <h4 class="font-semibold text-white">Physical boards</h4>
      <article
        v-for="board in boards"
        :key="board.serialnr"
        class="rounded-md border p-3"
        :class="dgtBoardHealth(board, Date.now()) === 'attention' ? 'border-amber-600 bg-amber-950/30' : 'border-white/10'"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span class="font-semibold text-white">DGT {{ board.serialnr }}</span>
            <span v-if="board.source" class="ml-2 text-xs text-gray-400">{{ board.source }}</span>
          </div>
          <span
            class="text-sm"
            :class="board.alerted || board.state === 'NOTRESPONDING' ? 'text-amber-300' : 'text-green-300'"
          >
            {{ statusLabel(board) }}
          </span>
        </div>
        <div class="mt-2 grid gap-2 text-sm md:grid-cols-2">
          <p>Reconstructed moves: <strong>{{ board.san?.length ?? 'Not available' }}</strong></p>
          <p v-if="board.clock">
            White {{ formatClock(board.clock.white) }} · Black {{ formatClock(board.clock.black) }}
            <span class="text-gray-400">
              ({{ board.clock.run === null ? 'stopped' : board.clock.run ? 'White running' : 'Black running' }})
            </span>
          </p>
          <p v-else class="text-gray-400">No clock data reported</p>
        </div>
        <p v-if="board.board" class="mt-1 break-all font-mono text-xs text-gray-400">
          Physical position: {{ board.board }}
        </p>
        <button
          v-if="monitor.status === 'connected' && board.match === undefined"
          type="button"
          class="mt-2 rounded bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/20"
          @click="setupStandard(board.serialnr)"
        >
          Start standard-game move matching
        </button>
        <p v-if="board.clock && (board.clock.white === 0 || board.clock.black === 0)" class="mt-2 text-xs text-amber-300">
          DGT reports a zero reading. This feed does not confirm a hardware flag-fall event.
        </p>
        <div v-if="roundId" class="mt-3 flex flex-wrap items-end gap-2 border-t border-white/10 pt-3">
          <label class="text-sm">
            Lichess broadcast board number
            <input
              v-model.number="slots[board.serialnr]"
              type="number"
              min="1"
              max="500"
              placeholder="1"
              class="mt-1 block w-24 rounded bg-white/5 p-2 text-white"
            />
          </label>
          <button type="button" class="rounded bg-indigo-500 px-3 py-2 text-sm text-white" @click="assign(board.serialnr)">
            Save mapping
          </button>
          <button
            v-if="currentBoard(board.serialnr) !== undefined"
            type="button"
            class="rounded bg-white/10 px-3 py-2 text-sm"
            @click="monitor.removeAssignment(roundId, board.serialnr)"
          >
            Remove mapping
          </button>
        </div>
        <div v-if="board.alerted" class="mt-3 border-t border-amber-700 pt-3">
          <p class="text-sm text-amber-200">
            Physical position has not matched LiveChess reconstruction for more than eight seconds.
            Check the board and correct the game in LiveChess.
          </p>
          <button
            v-if="!board.manualCorrectionPending"
            type="button"
            class="mt-2 rounded bg-amber-600 px-3 py-2 text-sm text-white hover:bg-amber-500"
            @click="monitor.markManualCorrection(board.serialnr)"
          >
            I corrected this in LiveChess
          </button>
          <p v-else class="mt-2 text-sm text-amber-200">
            Correction noted. Waiting for a synchronized position before clearing the alert.
          </p>
        </div>
      </article>
    </div>
    <p v-else-if="monitor.status === 'connected'" class="mt-4 text-sm text-amber-300">
      LiveChess answered, but no physical boards were reported.
    </p>

    <p class="mt-3 text-xs text-gray-400">
      If LiveChess has not provided a match indicator, select “Start standard-game move matching” for the
      relevant board. This requests feed-specific reconstruction from the normal chess starting position;
      it is not suitable for Chess960 or custom-FEN games. A midgame start may not reconstruct all prior moves.
    </p>

    <p v-if="roundId" class="mt-4 text-xs text-gray-400">
      Assign physical boards to this Lichess round's PGN board numbers to enable upload verification. Only a
      prolonged reconstruction mismatch, divergent move history, or a clearly contradictory zero-clock header
      holds an affected game's upload. Other games continue normally. If monitoring disconnects, uploads revert
      to their normal unverified behavior.
    </p>
    <p class="mt-3 text-xs text-gray-400">
      Broadcaster cannot verify flag falls from this API or force Lichess's web countdown to pause. A positive
      DGT reading can help reject contradictory source data, but the Lichess display may still estimate zero
      between moves. The physical clock remains authoritative.
    </p>

    <div v-if="monitor.events.length" class="mt-5 border-t border-white/10 pt-4">
      <h4 class="font-semibold text-white">Operator notifications</h4>
      <ul class="mt-2 max-h-64 space-y-2 overflow-y-auto text-sm" aria-live="polite">
        <li v-for="(event, index) in monitor.events" :key="event.at + '-' + event.serialnr + '-' + index">
          <span class="mr-2 text-xs text-gray-400">{{ new Date(event.at).toLocaleTimeString() }}</span>
          <span :class="event.kind === 'mismatch' || event.kind === 'board-offline' ? 'text-amber-300' : 'text-green-300'">
            {{ event.message }}
          </span>
        </li>
      </ul>
      <p class="mt-2 text-xs text-gray-400">
        A verified manual correction is reported as such only when an operator marks it here and LiveChess
        subsequently reports a match. Other recoveries are described without guessing who fixed them.
      </p>
    </div>
  </section>
</template>
