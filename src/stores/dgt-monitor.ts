import { defineStore } from 'pinia';
import { notify } from '../notify';
import { useLogStore } from './logs';
import {
  applyDgtBoardUpdate,
  checkDgtMismatch,
  dgtWebSocketUrl,
  guardDgtPgnUpload,
  newDgtBoard,
  type DgtBoardAssignment,
  type DgtBoardState,
  type DgtBoardUpdate,
  type DgtEndpointMode,
  type DgtMonitorEvent,
  type DgtUploadGuard,
} from '../dgt-monitor-core';

type DgtConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

interface DgtEnvelope {
  response?: string;
  id?: number;
  param?: unknown;
}

let connection: WebSocket | undefined;
let pulse: ReturnType<typeof setInterval> | undefined;
let enumeration: ReturnType<typeof setInterval> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let connectionGeneration = 0;
let subscriptionId = 100;
let subscribed = new Set<string>();
let desired = false;
const heldWarnings = new Map<string, string>();
const EVENT_LIMIT = 100;

function stopTimers() {
  if (pulse) clearInterval(pulse);
  if (enumeration) clearInterval(enumeration);
  if (retry) clearTimeout(retry);
  pulse = undefined;
  enumeration = undefined;
  retry = undefined;
}

export const useDgtMonitorStore = defineStore('dgt-monitor', {
  state: () => ({
    mode: 'local' as DgtEndpointMode,
    host: '',
    port: 1982,
    assignments: [] as DgtBoardAssignment[],
    status: 'disconnected' as DgtConnectionStatus,
    endpoint: '',
    error: '',
    boards: {} as Record<string, DgtBoardState>,
    events: [] as DgtMonitorEvent[],
    connectedAt: undefined as number | undefined,
  }),
  persist: {
    pick: ['mode', 'host', 'port', 'assignments'],
  },
  actions: {
    addEvent(event: DgtMonitorEvent) {
      this.events.unshift(event);
      if (this.events.length > EVENT_LIMIT) this.events.length = EVENT_LIMIT;
      const logs = useLogStore();
      if (event.kind === 'mismatch' || event.kind === 'board-offline') logs.error(event.message);
      else {
        logs.info(event.message);
        void notify('DGT LiveChess', event.message);
      }
    },
    onBoard(data: DgtBoardUpdate, now = Date.now()) {
      if (!data.serialnr || data.serialnr.length > 80) return;
      const current = this.boards[data.serialnr] ?? newDgtBoard(data.serialnr, now);
      const { board, events } = applyDgtBoardUpdate(current, data, now);
      this.boards[data.serialnr] = board;
      for (const event of events) this.addEvent(event);
      this.checkBoards(now);
    },
    checkBoards(now = Date.now()) {
      for (const board of Object.values(this.boards)) {
        const result = checkDgtMismatch(board, now);
        if (result.board !== board) this.boards[board.serialnr] = result.board;
        if (result.event) this.addEvent(result.event);
      }
    },
    markManualCorrection(serialnr: string) {
      const board = this.boards[serialnr];
      if (!board?.alerted) return;
      board.manualCorrectionPending = true;
      useLogStore().info('Operator reported correcting board ' + serialnr + '; waiting for LiveChess match confirmation.');
    },
    setAssignment(roundId: string, serialnr: string, boardNumber: number) {
      if (!/^[A-Za-z0-9]{8}$/.test(roundId)) throw new Error('Select a valid Lichess round.');
      if (!this.boards[serialnr]) throw new Error('Select a connected DGT board.');
      if (!Number.isInteger(boardNumber) || boardNumber < 1 || boardNumber > 500)
        throw new Error('Board number must be between 1 and 500.');
      const collision = this.assignments.find(
        item => item.roundId === roundId && item.boardNumber === boardNumber && item.serialnr !== serialnr,
      );
      if (collision) throw new Error('Another DGT board is already assigned to this broadcast board number.');
      this.assignments = this.assignments.filter(item => !(item.roundId === roundId && item.serialnr === serialnr));
      this.assignments.push({ roundId, serialnr, boardNumber });
    },
    removeAssignment(roundId: string, serialnr: string) {
      this.assignments = this.assignments.filter(item => item.roundId !== roundId || item.serialnr !== serialnr);
    },
    prepareUpload(roundId: string, pgn: string): DgtUploadGuard {
      if (this.status !== 'connected') return { pgn, held: [], verifiedBoards: 0 };
      return guardDgtPgnUpload(roundId, pgn, this.assignments, this.boards, Date.now());
    },
    recordUploadGuard(roundId: string, guard: DgtUploadGuard) {
      const held = new Map(guard.held.map(item => [roundId + ':' + item.boardNumber, item]));
      for (const item of guard.held) {
        const key = roundId + ':' + item.boardNumber;
        if (heldWarnings.get(key) !== item.reason) {
          const text =
            'DGT board ' + item.serialnr + ' (broadcast board ' + item.boardNumber +
            '): held PGN update because ' + item.reason + '. Other games continue uploading.';
          useLogStore().error(text);
          heldWarnings.set(key, item.reason);
        }
      }
      for (const [key] of heldWarnings) {
        if (!key.startsWith(roundId + ':') || held.has(key)) continue;
        heldWarnings.delete(key);
        const message = 'DGT PGN validation restored for broadcast board ' + key.split(':')[1] + '. Uploads resumed.';
        useLogStore().info(message);
        void notify('DGT LiveChess', message);
      }
    },
    disconnect() {
      desired = false;
      connectionGeneration++;
      stopTimers();
      const previous = connection;
      connection = undefined;
      if (previous) previous.close();
      subscribed.clear();
      this.status = 'disconnected';
      this.error = '';
      this.connectedAt = undefined;
      this.boards = {};
    },
    async connect() {
      this.disconnect();
      let endpoint: string;
      try {
        endpoint = dgtWebSocketUrl(this.mode, this.host, this.port);
      } catch (error) {
        this.status = 'error';
        this.error = String(error);
        throw error;
      }
      desired = true;
      this.endpoint = endpoint;
      this.status = 'connecting';
      this.error = '';
      await this.openConnection(endpoint, connectionGeneration);
    },
    openConnection(endpoint: string, generation: number): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        let ws: WebSocket;
        try {
          ws = new WebSocket(endpoint);
        } catch (error) {
          this.status = 'error';
          this.error = String(error);
          reject(error);
          return;
        }
        connection = ws;
        subscribed = new Set();
        let handshakeFinished = false;
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        };
        const timeout = setTimeout(() => {
          if (generation !== connectionGeneration || handshakeFinished) return;
          this.error = 'LiveChess did not respond to the board inventory request.';
          ws.close();
          finish(new Error(this.error));
        }, 8000);

        ws.onopen = () => {
          if (generation !== connectionGeneration) return;
          ws.send(JSON.stringify({ id: 1, call: 'eboards' }));
        };
        ws.onmessage = message => {
          if (generation !== connectionGeneration || typeof message.data !== 'string' || message.data.length > 250000)
            return;
          let envelope: DgtEnvelope;
          try {
            envelope = JSON.parse(message.data) as DgtEnvelope;
          } catch {
            return;
          }
          if (envelope.response === 'call' && envelope.id === 1 && Array.isArray(envelope.param)) {
            for (const entry of envelope.param) {
              if (!entry || typeof entry !== 'object') continue;
              const board = entry as Partial<DgtBoardUpdate>;
              if (typeof board.serialnr !== 'string') continue;
              this.onBoard(board as DgtBoardUpdate);
              if (!subscribed.has(board.serialnr)) {
                subscribed.add(board.serialnr);
                ws.send(
                  JSON.stringify({
                    id: ++subscriptionId,
                    call: 'subscribe',
                    param: { feed: 'eboardevent', id: subscriptionId, param: { serialnr: board.serialnr } },
                  }),
                );
              }
            }
            if (!handshakeFinished) {
              handshakeFinished = true;
              this.status = 'connected';
              this.connectedAt = Date.now();
              this.error = '';
              useLogStore().info(
                'Connected to LiveChess at ' + endpoint + ' (' + Object.keys(this.boards).length + ' boards).',
              );
              pulse = setInterval(() => this.checkBoards(), 1000);
              enumeration = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 1, call: 'eboards' }));
              }, 20000);
              finish();
            }
          } else if (envelope.response === 'feed' && envelope.param && typeof envelope.param === 'object') {
            const payload = envelope.param as Partial<DgtBoardUpdate>;
            if (typeof payload.serialnr === 'string') this.onBoard(payload as DgtBoardUpdate);
          } else if (envelope.response === 'error' && !handshakeFinished) {
            this.error = 'LiveChess refused the board discovery request.';
            ws.close();
            finish(new Error(this.error));
          }
        };
        ws.onerror = () => {
          if (generation !== connectionGeneration) return;
          this.error = 'WebSocket failed. Check the LiveChess host, firewall, and local/LAN permissions.';
          if (!handshakeFinished) finish(new Error(this.error));
        };
        ws.onclose = () => {
          if (generation !== connectionGeneration) return;
          stopTimers();
          if (connection === ws) connection = undefined;
          if (handshakeFinished) {
            const message = 'DGT LiveChess monitoring connection lost. Broadcast PGNs are no longer hardware-verified.';
            useLogStore().error(message);
          } else finish(new Error(this.error || 'LiveChess WebSocket connection closed before discovery.'));
          if (desired) {
            this.status = 'reconnecting';
            retry = setTimeout(() => {
              if (desired && generation === connectionGeneration) {
                void this.openConnection(endpoint, generation).catch(error => {
                  this.error = String(error);
                });
              }
            }, 5000);
          } else this.status = 'disconnected';
        };
      });
    },
  },
});
