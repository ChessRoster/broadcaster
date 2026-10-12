import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

interface DgtSocketEvent {
  connectionId: string;
  kind: 'message' | 'closed';
  data?: string;
}

/**
 * Tauri-native WebSocket wrapper. The Windows production WebView uses an HTTPS
 * origin and cannot reliably connect to a ws:// LAN endpoint itself.
 */
let nextConnectionId = 0;

export class DgtSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: Error) => void) | null = null;
  onclose: (() => void) | null = null;

  private readonly connectionId = String(Date.now()) + '-' + String(++nextConnectionId);
  private unlisten?: UnlistenFn;
  private closed = false;

  constructor(readonly endpoint: string) {
    void this.start();
  }

  private async start() {
    try {
      this.unlisten = await listen<DgtSocketEvent>('dgt-ws-event', event => {
        const data = event.payload;
        if (this.closed || data.connectionId !== this.connectionId) return;
        if (data.kind === 'message' && typeof data.data === 'string') this.onmessage?.({ data: data.data });
        else if (data.kind === 'closed') this.close();
      });
      if (this.closed) {
        this.unlisten();
        return;
      }
      await invoke('dgt_ws_connect', {
        endpoint: this.endpoint,
        connectionId: this.connectionId,
      });
      if (this.closed) {
        // A cancelled connection may finish its native handshake later.
        // Explicitly close it rather than leaving an orphaned Rust socket.
        await invoke('dgt_ws_disconnect', { connectionId: this.connectionId }).catch(() => undefined);
        return;
      }
      this.readyState = DgtSocket.OPEN;
      this.onopen?.();
    } catch (error) {
      if (this.closed) return;
      this.onerror?.(new Error(String(error)));
      this.close();
    }
  }

  send(data: string) {
    if (this.closed || this.readyState !== DgtSocket.OPEN)
      throw new Error('The DGT WebSocket is not connected.');
    void invoke('dgt_ws_send', { connectionId: this.connectionId, data }).catch(error => {
      if (!this.closed) this.onerror?.(new Error(String(error)));
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.unlisten?.();
    void invoke('dgt_ws_disconnect', { connectionId: this.connectionId }).catch(() => undefined);
    this.onclose?.();
  }
}
