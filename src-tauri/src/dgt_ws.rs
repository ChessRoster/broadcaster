//! Native WebSocket transport for DGT LiveChess.
//!
//! Windows WebView2 uses an HTTPS app origin, which blocks ws:// LAN endpoints.
//! Keep the connection in Rust instead of disabling HTTPS or changing app storage.
use futures_util::{SinkExt, StreamExt};
use std::{
    net::IpAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, State};
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Default)]
pub struct DgtWsState {
    active: Arc<Mutex<Option<ActiveSocket>>>,
    generation: Arc<AtomicU64>,
}

struct ActiveSocket {
    id: String,
    sender: mpsc::UnboundedSender<String>,
    task: JoinHandle<()>,
}

fn check_endpoint(endpoint: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(endpoint).map_err(|_| "Invalid LiveChess WebSocket URL.")?;
    if parsed.scheme() != "ws"
        || parsed.path() != "/api/v1.0"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Only a direct local LiveChess ws://.../api/v1.0 endpoint is allowed.".into());
    }
    let host = parsed.host_str().ok_or("Missing LiveChess host.")?;
    if host.parse::<IpAddr>().is_ok_and(|ip| match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
        }
        IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local(),
    }) {
        return Ok(());
    }
    if host == "localhost"
        || ((host.ends_with(".local") || !host.contains('.'))
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
            && host.len() <= 253)
    {
        return Ok(());
    }
    Err("Only local network and private DGT hosts are allowed.".into())
}

#[tauri::command]
pub async fn dgt_ws_connect(
    app: AppHandle,
    state: State<'_, DgtWsState>,
    endpoint: String,
    connection_id: String,
) -> Result<(), String> {
    check_endpoint(&endpoint)?;
    if connection_id.len() > 80 || connection_id.is_empty() {
        return Err("Invalid connection identifier.".into());
    }
    let generation = state.generation.clone();
    let active = state.active.clone();
    let id = generation.fetch_add(1, Ordering::SeqCst) + 1;

    {
        let mut current = active.lock().map_err(|_| "DGT socket state unavailable.")?;
        if let Some(old) = current.take() {
            old.task.abort();
        }
    }

    let (socket, _) = connect_async(endpoint.as_str())
        .await
        .map_err(|e| format!("Could not connect to LiveChess: {e}"))?;
    if generation.load(Ordering::SeqCst) != id {
        return Err("Connection superseded by a newer request.".into());
    }

    let (mut writer, mut reader) = socket.split();
    let (sender, mut outbound) = mpsc::unbounded_channel::<String>();
    let stream_id = connection_id.clone();
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                outgoing = outbound.recv() => match outgoing {
                    Some(message) => {
                        if writer.send(Message::Text(message.into())).await.is_err() { break; }
                    }
                    None => break,
                },
                incoming = reader.next() => match incoming {
                    Some(Ok(Message::Text(message))) => {
                        let _ = app.emit("dgt-ws-event", serde_json::json!({
                            "connectionId": stream_id,
                            "kind": "message",
                            "data": message.to_string()
                        }));
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
        let _ = app.emit(
            "dgt-ws-event",
            serde_json::json!({
                "connectionId": stream_id,
                "kind": "closed"
            }),
        );
    });
    let mut current = active.lock().map_err(|_| "DGT socket state unavailable.")?;
    if generation.load(Ordering::SeqCst) != id {
        task.abort();
        return Err("Connection superseded by a newer request.".into());
    }
    *current = Some(ActiveSocket {
        id: connection_id,
        sender,
        task,
    });
    Ok(())
}

#[tauri::command]
pub fn dgt_ws_send(
    state: State<'_, DgtWsState>,
    connection_id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > 65536 {
        return Err("DGT WebSocket message too large.".into());
    }
    let current = state
        .active
        .lock()
        .map_err(|_| "DGT socket state unavailable.")?;
    let active = current.as_ref().ok_or("DGT WebSocket is not connected.")?;
    if active.id != connection_id || active.task.is_finished() {
        return Err("DGT WebSocket connection is no longer active.".into());
    }
    active
        .sender
        .send(data)
        .map_err(|_| "DGT WebSocket sender closed.".into())
}

#[tauri::command]
pub fn dgt_ws_disconnect(
    state: State<'_, DgtWsState>,
    connection_id: String,
) -> Result<(), String> {
    let mut current = state
        .active
        .lock()
        .map_err(|_| "DGT socket state unavailable.")?;
    if current
        .as_ref()
        .is_some_and(|socket| socket.id == connection_id)
    {
        state.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(old) = current.take() {
            old.task.abort();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_local_livechess_websockets_are_allowed() {
        for valid in [
            "ws://127.0.0.1:1982/api/v1.0",
            "ws://192.168.1.4:1982/api/v1.0",
            "ws://100.80.5.2:1982/api/v1.0",
            "ws://dgt-pc.local:1982/api/v1.0",
        ] {
            assert!(check_endpoint(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "ws://8.8.8.8:1982/api/v1.0",
            "wss://public.example.com/api/v1.0",
            "ws://192.168.1.4:1982/not-livechess",
            "ws://user:pass@localhost:1982/api/v1.0",
            "ws://localhost:1982/api/v1.0?token=abc",
        ] {
            assert!(check_endpoint(invalid).is_err(), "{invalid}");
        }
    }
}
