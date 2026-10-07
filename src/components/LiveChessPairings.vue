<script setup lang="ts">
import { computed, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import { liveChessInstallation } from '../livechess-platform';
import { usePairingsStore } from '../stores/pairings';
import { useSettingsStore } from '../stores/settings';
import { useUserStore } from '../stores/user';
import { lichessApiClient } from '../client';
import { PairingMapping, PairingTour } from '../pairings';

const props = defineProps<{ roundId?: string; tourId?: string }>();
const store = usePairingsStore();
const settings = useSettingsStore();
const user = useUserStore();
const installation = liveChessInstallation(platform());
if (!store.installDirectory) store.installDirectory = installation.defaultPath;
const automatic = ref(true);
const tourMapping = computed(() =>
  store.tours.find(t => t.tourId === props.tourId && t.lichessUrl === settings.lichessUrl),
);
const tournaments = ref<{ id: string; name: string; rounds: number }[]>([]);
const message = ref('');
const busy = ref(false);
const tournamentId = ref('');
const roundNumber = ref(1);
const expectedBoards = ref(1);
const mapping = computed(() =>
  store.mappings.find(m => m.roundId === props.roundId && m.lichessUrl === settings.lichessUrl),
);

async function connect(start = false) {
  busy.value = true;
  try {
    if (start) {
      if (!store.installDirectory.trim()) throw new Error('Enter the LiveChess installation path first.');
      await invoke('livechess_start', { installDirectory: store.installDirectory.trim() });
    }
    const status = await invoke<{ connected: boolean; message?: string }>('livechess_status');
    if (!status.connected)
      throw new Error(
        status.message ||
          'LiveChess is not connected. Close a normally started LiveChess instance, then use Start LiveChess.',
      );
    tournaments.value = await invoke('livechess_tournaments');
    message.value = 'LiveChess connected. Select an existing tournament.';
  } catch (error) {
    message.value = String(error);
  } finally {
    busy.value = false;
  }
}

async function enable() {
  if (
    !props.roundId ||
    !/^[A-Za-z0-9]{8}$/.test(props.roundId) ||
    !tournaments.value.some(t => t.id === tournamentId.value)
  ) {
    message.value = 'Connect LiveChess and choose a tournament first.';
    return;
  }
  if (!user.username || !user.accessToken) {
    message.value = 'Sign in to Lichess before enabling imports.';
    return;
  }
  if (
    !Number.isInteger(roundNumber.value) ||
    roundNumber.value < 1 ||
    roundNumber.value > 100 ||
    !Number.isInteger(expectedBoards.value) ||
    expectedBoards.value < 1 ||
    expectedBoards.value > 500
  ) {
    message.value = 'Enter a round from 1–100 and board count from 1–500.';
    return;
  }
  const collision = store.mappings.some(
    m => m.tournamentId === tournamentId.value && m.roundNumber === roundNumber.value,
  );
  if (collision) {
    message.value = 'That LiveChess round already has a saved mapping. Pause or reconcile it in Settings.';
    return;
  }
  if (automatic.value && props.tourId) {
    if (store.tours.some(t => t.tournamentId === tournamentId.value)) {
      message.value = 'This LiveChess tournament already has automatic sync configured.';
      return;
    }
    busy.value = true;
    const origin = settings.lichessUrl;
    const username = user.username;
    try {
      const result = await lichessApiClient().GET('/api/broadcast/{broadcastTournamentId}', {
        params: { path: { broadcastTournamentId: props.tourId } },
      });
      if (origin !== settings.lichessUrl || username !== user.username)
        throw new Error('Session changed during setup.');
      const ids = result.data?.rounds.map(r => r.id);
      if (!ids || !ids.includes(props.roundId)) throw new Error('Could not discover this tournament’s round order.');
      store.tours.push({
        tourId: props.tourId,
        lichessUrl: origin,
        username,
        tournamentId: tournamentId.value,
        startRoundId: props.roundId,
        localStartingRound: roundNumber.value,
        expectedBoards: expectedBoards.value,
        knownRoundIds: ids.slice(ids.indexOf(props.roundId)),
        enabled: true,
        message: 'Automatic sync enabled from this Lichess round onward.',
      });
      store.$persist();
    } catch (error) {
      message.value = String(error);
    } finally {
      busy.value = false;
    }
    return;
  }
  store.mappings.push({
    roundId: props.roundId,
    lichessUrl: settings.lichessUrl,
    username: user.username,
    tournamentId: tournamentId.value,
    roundNumber: roundNumber.value,
    expectedBoards: expectedBoards.value,
    enabled: true,
    completed: false,
    message: 'Waiting for complete pairings from Lichess.',
  });
  store.$persist();
}

function toggle(item: PairingMapping | PairingTour) {
  if (item.enabled) item.enabled = false;
  else {
    if (item.lichessUrl !== settings.lichessUrl || !user.username || !user.accessToken) {
      message.value = 'Sign in on the configured Lichess server before resuming.';
      return;
    }
    item.username = user.username;
    item.enabled = true;
  }
  store.$persist();
}

function removeMapping(roundId: string, lichessUrl: string) {
  const item = store.mappings.find(m => m.roundId === roundId && m.lichessUrl === lichessUrl);
  if (!item || item.enabled || item.completed || item.pending) return;
  store.mappings = store.mappings.filter(m => m !== item);
  store.$persist();
}
</script>

<template>
  <section class="my-6 rounded-lg border border-white/10 p-5 text-gray-300">
    <h3 class="text-lg font-semibold text-white">LiveChess pairing import</h3>
    <p class="mt-2 text-sm">
      Import pairings from Lichess automatically while Broadcaster stays open. Each game must have a Board header or
      Round round.board suffix numbered 1 through the expected board count. Games with moves, byes or custom positions
      are rejected. Recording still starts in LiveChess.
    </p>
    <label class="mt-4 block text-sm" for="livechess-path">LiveChess installation path</label>
    <input
      id="livechess-path"
      v-model="store.installDirectory"
      :placeholder="installation.placeholder"
      aria-describedby="livechess-path-help"
      class="mt-1 w-full rounded bg-white/5 p-2 text-white ring-1 ring-white/10"
    />
    <p id="livechess-path-help" class="mt-2 text-sm">{{ installation.help }}</p>
    <div class="mt-3 flex gap-3">
      <button
        type="button"
        :disabled="busy"
        class="rounded bg-indigo-500 px-3 py-2 text-sm text-white disabled:opacity-50"
        @click="connect(true)"
      >
        Start LiveChess
      </button>
      <button
        type="button"
        :disabled="busy"
        class="rounded bg-white/10 px-3 py-2 text-sm disabled:opacity-50"
        @click="connect()"
      >
        Check connection
      </button>
    </div>
    <p v-if="message" role="status" class="mt-3 text-sm">{{ message }}</p>
    <div v-if="roundId && !mapping && !tourMapping" class="mt-4 grid gap-3">
      <label v-if="tourId" class="text-sm"
        ><input v-model="automatic" type="checkbox" /> Automatically discover and import this tournament’s future
        rounds</label
      >
      <label class="text-sm"
        >LiveChess tournament
        <select v-model="tournamentId" class="mt-1 block w-full rounded bg-gray-800 p-2 text-white">
          <option value="">Select existing tournament</option>
          <option v-for="t in tournaments" :key="t.id" :value="t.id">{{ t.name }} ({{ t.rounds }} rounds)</option>
        </select>
      </label>
      <label class="text-sm"
        >Destination LiveChess round for this starting Lichess round
        <input
          v-model.number="roundNumber"
          type="number"
          min="1"
          max="100"
          class="ml-2 w-24 rounded bg-white/5 p-2 text-white"
        />
      </label>
      <label class="text-sm"
        >Expected physical boards
        <input
          v-model.number="expectedBoards"
          type="number"
          min="1"
          max="500"
          class="ml-2 w-24 rounded bg-white/5 p-2 text-white"
        />
      </label>
      <button
        type="button"
        :disabled="busy"
        class="justify-self-start rounded bg-indigo-500 px-3 py-2 text-sm text-white"
        @click="enable"
      >
        {{ automatic && tourId ? 'Enable automatic tournament pairing sync' : 'Enable pairing import for this round' }}
      </button>
    </div>
    <div
      v-for="tour in tourId ? (tourMapping ? [tourMapping] : []) : store.tours"
      :key="tour.tourId"
      class="mt-4 border-t border-white/10 pt-3 text-sm"
    >
      <p>
        Tournament {{ tour.tourId }} → LiveChess {{ tour.tournamentId }} · {{ tour.expectedBoards }} boards per round
      </p>
      <p class="mt-1">
        Starting at Lichess {{ tour.startRoundId }} / LiveChess round {{ tour.localStartingRound }}. Later rounds follow
        the tournament’s round order automatically.
      </p>
      <p role="status" class="mt-1">{{ tour.message }}</p>
      <button type="button" class="mt-2 rounded bg-white/10 px-3 py-2" @click="toggle(tour)">
        {{ tour.enabled ? 'Pause tournament sync' : 'Resume tournament sync' }}
      </button>
    </div>
    <div
      v-for="item in roundId ? (mapping ? [mapping] : []) : store.mappings"
      :key="item.lichessUrl + item.roundId"
      class="mt-4 border-t border-white/10 pt-3 text-sm"
    >
      <p>{{ item.roundId }} → LiveChess round {{ item.roundNumber }} · {{ item.expectedBoards }} boards</p>
      <p role="status" class="mt-1">{{ item.message }}</p>
      <p v-if="item.pending && !item.completed" class="mt-1 text-amber-300">
        Import pending confirmation. Resuming retries the same request safely.
      </p>
      <button v-if="!item.completed" type="button" class="mt-2 rounded bg-white/10 px-3 py-2" @click="toggle(item)">
        {{ item.enabled ? 'Pause import' : 'Resume import' }}
      </button>
      <button
        v-if="!item.enabled && !item.completed && !item.pending"
        type="button"
        class="ml-2 mt-2 rounded bg-white/10 px-3 py-2"
        @click="removeMapping(item.roundId, item.lichessUrl)"
      >
        Remove mapping
      </button>
    </div>
  </section>
</template>
