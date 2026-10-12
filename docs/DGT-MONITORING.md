# DGT LiveChess board monitoring

Lichess Broadcaster can monitor an existing LiveChess installation without replacing its board drivers. It uses LiveChess's local WebSocket API on port 1982 and a native Tauri connection on Windows, macOS and Linux.

## Operator setup

1. Start **DGT LiveChess** and confirm that it recognizes the electronic boards.
2. Open **Settings > DGT LiveChess board monitoring**, or the monitoring section of a Lichess broadcast round.
3. Select **Local** if LiveChess runs on this computer. Otherwise select **LAN** and enter the LiveChess computer's private IP, Tailscale IP or local hostname and its port (normally **1982**).
4. Select **Connect and test**. A successful connection means the app received LiveChess's `eboards` inventory, not merely that a TCP socket opened. The interface shows discovered board serial numbers, connection states and physical positions.
5. On the Lichess **round page**, assign each physical DGT serial number to the corresponding **broadcast board number**. Save every assignment separately. This is necessary before an upload can be checked against a particular physical board.
6. If a board reports no `match` indicator, select **Start standard-game move matching**. This sends a reconstruction-setup request to that board's subscription using the normal initial FEN. It is not appropriate for Chess960 or custom positions, and may not reconstruct earlier moves when started midgame.
7. Start normal PGN-folder upload. Keep LiveChess and Broadcaster open during the event. The monitor runs across Broadcaster page navigation and reconnects automatically if the socket drops.

## Recording problems

The `eboardevent` feed sends actual piece placement, the reconstructed SAN move list, clock state and sometimes a `match` flag. A brief `match: false` can simply mean a lifted piece has not yet been set down. Broadcaster waits **8 seconds** before creating a position-mismatch warning.

Warnings include the DGT serial number and appear in the monitoring section and desktop notification history, with an operating-system notification where enabled. Physical board `NOTRESPONDING` transitions are also reported.

When LiveChess later reports `match: true`, Broadcaster marks the issue recovered and notifies the operator. To document a manual fix, select **I corrected this in LiveChess** while the alert is active. The alert clears **only after** LiveChess confirms the match. Without that acknowledgement, Broadcaster reports the recovery without claiming to know whether the fix was automatic or manually performed outside the app.

Fixing the game itself is still done using LiveChess's reconstruction/correction controls. This feature does not alter the game's pairing, recording, or DGT driver.

## Protecting Lichess uploads

For rounds with an explicit DGT-serial-to-broadcast-board mapping, the upload path checks the corresponding PGN against monitored LiveChess data. An individual game's update is **held** if:

- LiveChess reports a persistent unreconciled position;
- the PGN mainline conflicts with the reconstructed move list;
- a fresh clock snapshot reports positive time while the corresponding source PGN clock header or latest completed move annotation says zero (where the move list matches LiveChess).

Only the affected game's PGN is held. The other games still upload. The old chapter already on Lichess remains published. Upon recovery, the folder watcher re-uploads the latest PGN without waiting for another manual file change.

This is a conservative consistency check, **not a guarantee that PGN data is perfect**. Mapping or feed data may be missing; in that case Broadcaster uses normal unverified uploads. A disconnected monitor never claims data was hardware-verified. The source PGN on disk remains unchanged.

## Clock limitations

LiveChess's `eboardevent.clock` object includes the white and black remaining seconds, the running side (`true` white, `false` black, `null` stopped), and a timestamp. This feed has **no documented explicit physical flag-fall confirmation**; a zero reading is not, by itself, proof that a flag fell.

Lichess independently counts down its web clock from the last recorded move. Its current PGN broadcast interface does not represent the physical clock's run/pause state as a live authority. **Broadcaster alone cannot guarantee that the Lichess website will never display 0:00 while a physical clock retains time.** Fixing that requires an upstream Lichess change, or a supported clock-state/flag protocol. Broadcaster deliberately does not fabricate clock values to conceal the difference.

For identified DGT PGN sources, the existing clock normalization also converts ambiguous DGT notation such as `0:00.38` (38 seconds) to the explicit `0:00:38` form.

## Networking and testing

The native Tauri WebSocket bridge avoids Windows WebView2 mixed-content blocking when connecting from an HTTPS application origin to `ws://` LiveChess. Only local/private endpoints and the `/api/v1.0` path are permitted. The connection is not encrypted. Use a trusted LAN or private tunnel; LiveChess must be reachable from this computer, and some installations listen only on loopback until configured or proxied.

Automated tests cover event parsing, transient and persistent mismatches, manual confirmation, recovery, clock consistency, per-board PGN guarding, socket handshake and local-network URL validation. Physical DGT hardware, particular LAN firewalls and LiveChess's behavior with custom positions still require acceptance tests.
