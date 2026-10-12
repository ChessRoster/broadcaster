import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDgtMonitorStore } from '../src/stores/dgt-monitor';

vi.mock('../src/notify', () => ({
  notify: vi.fn(async () => undefined),
}));

const socketState = vi.hoisted(() => ({ sockets: [] as any[] }));

vi.mock('../src/dgt-websocket', () => {
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    sent: string[] = [];
    url: string;
    constructor(url: string) {
      this.url = url;
      socketState.sockets.push(this);
    }
    send(value: string) {
      this.sent.push(value);
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    receive(value: object) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  return { DgtSocket: FakeWebSocket };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
  socketState.sockets = [];
  setActivePinia(createPinia());
});

afterEach(() => {
  useDgtMonitorStore().disconnect();
  vi.useRealTimers();
});

describe('LiveChess WebSocket connection', () => {
  it('confirms a connection only after the eboards inventory response', async () => {
    const store = useDgtMonitorStore();
    const pending = store.connect();
    const socket = socketState.sockets[0];
    expect(store.status).toBe('connecting');
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0])).toEqual({ id: 1, call: 'eboards' });
    expect(store.status).toBe('connecting');

    socket.receive({
      response: 'call',
      id: 1,
      param: [{ serialnr: '123', source: 'COM3', state: 'ACTIVE' }],
    });
    await pending;
    expect(store.status).toBe('connected');
    expect(store.boards['123'].state).toBe('ACTIVE');
    const subscribe = JSON.parse(socket.sent[1]);
    expect(subscribe.call).toBe('subscribe');
    expect(subscribe.param.feed).toBe('eboardevent');
    expect(subscribe.param.param.serialnr).toBe('123');
  });

  it('alerts after mismatch and sends recovery after manual confirmation', async () => {
    const store = useDgtMonitorStore();
    const pending = store.connect();
    const socket = socketState.sockets[0];
    socket.onopen?.();
    socket.receive({
      response: 'call',
      id: 1,
      param: [{ serialnr: '123', state: 'ACTIVE' }],
    });
    await pending;
    const feedId = JSON.parse(socket.sent[1]).param.id;
    socket.receive({
      response: 'feed',
      id: feedId,
      param: { serialnr: '123', match: false, board: '8/8/8/8/8/8/8/8' },
    });
    await vi.advanceTimersByTimeAsync(8000);
    expect(store.boards['123'].alerted).toBe(true);
    expect(store.events[0].kind).toBe('mismatch');

    store.markManualCorrection('123');
    socket.receive({
      response: 'feed',
      id: feedId,
      param: { serialnr: '123', match: true, san: ['e4'] },
    });
    expect(store.boards['123'].alerted).toBe(false);
    expect(store.events[0].kind).toBe('recovered');
    expect(store.events[0].recovery).toBe('manual');
  });

  it('can request feed-only move reconstruction without changing tournament pairings', async () => {
    const store = useDgtMonitorStore();
    const pending = store.connect();
    const socket = socketState.sockets[0];
    socket.onopen?.();
    socket.receive({
      response: 'call',
      id: 1,
      param: [{ serialnr: '123', state: 'ACTIVE' }],
    });
    await pending;
    store.setupStandardReconstruction('123');
    const call = JSON.parse(socket.sent[socket.sent.length - 1]);
    expect(call.call).toBe('call');
    expect(call.param.method).toBe('setup');
    expect(call.param.param.fen).toContain(' w KQkq - 0 1');
  });

  it('does not treat a WebSocket open as a successful inventory response', async () => {
    const store = useDgtMonitorStore();
    const pending = store.connect();
    const socket = socketState.sockets[0];
    socket.onopen?.();
    const rejected = expect(pending).rejects.toThrow('did not respond');
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
    expect(store.status).toBe('reconnecting');
  });

  it('does not invent a hardware flag confirmation from a zero clock reading', async () => {
    const store = useDgtMonitorStore();
    const pending = store.connect();
    const socket = socketState.sockets[0];
    socket.onopen?.();
    socket.receive({ response: 'call', id: 1, param: [{ serialnr: '123' }] });
    await pending;
    socket.receive({
      response: 'feed',
      id: 2,
      param: {
        serialnr: '123',
        clock: { white: 0, black: 23, run: null, time: Date.now() },
      },
    });
    expect(store.boards['123'].clock?.white).toBe(0);
    expect(store.events.some(event => event.kind === 'mismatch')).toBe(false);
  });
});
