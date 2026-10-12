import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  calls: [] as { command: string; args?: Record<string, unknown> }[],
  callback: undefined as undefined | ((event: { payload: unknown }) => void),
  unlisten: vi.fn(),
  connectFailure: false,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    native.calls.push({ command, args });
    if (command === 'dgt_ws_connect' && native.connectFailure) throw new Error('connection refused');
    return undefined;
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, callback: (event: { payload: unknown }) => void) => {
    native.callback = callback;
    return native.unlisten;
  }),
}));

import { DgtSocket } from '../src/dgt-websocket';

async function flushed(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  native.calls = [];
  native.callback = undefined;
  native.connectFailure = false;
  native.unlisten.mockClear();
});

describe('native DGT socket bridge', () => {
  it('opens after the native connection and forwards only its messages', async () => {
    const ws = new DgtSocket('ws://127.0.0.1:1982/api/v1.0');
    const messages: string[] = [];
    ws.onmessage = event => messages.push(event.data);
    await flushed();
    expect(ws.readyState).toBe(DgtSocket.OPEN);
    expect(native.calls[0].command).toBe('dgt_ws_connect');
    const id = native.calls[0].args!.connectionId;

    native.callback?.({ payload: { connectionId: 'other', kind: 'message', data: 'wrong' } });
    native.callback?.({ payload: { connectionId: id, kind: 'message', data: 'correct' } });
    expect(messages).toEqual(['correct']);
    ws.send('{"call":"eboards"}');
    await flushed();
    expect(native.calls.some(call => call.command === 'dgt_ws_send' && call.args?.data === '{"call":"eboards"}'))
      .toBe(true);
    ws.close();
    expect(native.unlisten).toHaveBeenCalled();
    expect(native.calls.some(call => call.command === 'dgt_ws_disconnect')).toBe(true);
  });

  it('reports native connection failures without claiming success', async () => {
    native.connectFailure = true;
    const ws = new DgtSocket('ws://127.0.0.1:1982/api/v1.0');
    const errors: string[] = [];
    ws.onerror = error => errors.push(error.message);
    await flushed();
    expect(errors[0]).toContain('connection refused');
    expect(ws.readyState).not.toBe(DgtSocket.OPEN);
  });
});
