# Authoritative LiveChess legal-game recording

This fork supports an optional **WebSocket-primary recording mode** on each Lichess
broadcast round. It is layered on the existing native Tauri LiveChess transport,
not on new electronic-board drivers. Enabling it stops that round's old PGN-folder
watcher so the two publishers cannot race.

## Operator workflow

1. Connect to LiveChess in the DGT monitoring section in **Settings** or in the
   selected Lichess round. Local and private-LAN WebSocket hosts are supported.
2. Map each physical board serial number to the correct Lichess broadcast
   board number.
3. In **WebSocket legal-game recorder**, enable this publishing mode for the
   selected round and choose **Load / verify pairings from Lichess**.
   This fetches the existing round PGN for player names, initial positions and
   identity headers. It does **not** trust moves found in the downloaded PGN as
   new locally accepted game history.
4. Keep LiveChess and Broadcaster running. LiveChess provides hardware sensor
   observations; Broadcaster validates legal moves and submits its own in-memory
   PGNs with the existing Broadcast push API.
5. When a position cannot be reconciled, the round page identifies the affected
   board. Other boards keep broadcasting. The game remains on the last accepted
   legal move in Lichess until a verified continuation is available.

Source mode and game state survive normal restarts in the application's
persisted Pinia storage. Clearing app data clears this local history. On
restart the recorder starts offline until a fresh physical observation arrives.
A previously interrupted or manually blocked game stays blocked.

## Three independent representations

- **Physical board:** piece-placement portion of FEN reported by LiveChess
  \`eboardevent.board\`. This alone lacks the side to move, castling rights,
  en-passant, move counters and game history.
- **LiveChess reconstruction:** \`start\` and \`san\`, which may disagree with
  the actual board or may be absent. The feed also provides optional
  \`match\` and clock information. Omitted fields preserve their cached values.
- **Accepted legal game:** a durable sequence of SAN moves replayed from
  the stored complete initial FEN using \`chess.js\`. Only this history is
  eligible for PGN publication, and only while the physical pieces match.

LiveChess SAN is eligible as a candidate only if its **complete starting FEN**
matches the game baseline, the prior accepted moves are an exact prefix,
every new SAN is legal and the resulting physical piece placement matches
the sensor report. Without trustworthy SAN, the recorder enumerates at
most two subsequent legal plies from the accepted position and commits only
if exactly one sequence produces the observed physical arrangement. Longer,
missing or ambiguous sequences need operator verification.

Reconstructed moves are debounced for the configured stabilization interval.
Physical-only legal inference waits the greater of three stabilization periods
or 2.5 seconds because ordinary captures and castling can create intermediate
legal-looking positions. Unrecognized positions stay **PENDING_VERIFICATION**,
then become **RECONCILIATION_REQUIRED** after the configured alert delay. If
they remain unresolved they become **MANUAL_INTERVENTION**. A clock-side
change while there is no legal candidate escalates immediately. This is an
operator diagnostic, not an arbiter's illegal-move ruling.

States:

| State | Publication | Recovery |
| --- | --- | --- |
| LIVE | Accepted PGNs may be uploaded | Validate each new observation |
| PENDING_VERIFICATION | Held | Wait for stabilization, don't alarm for normal lifts |
| RECONCILIATION_REQUIRED | Held | Recover if the physical position returns or a unique legal continuation appears |
| RECOVERED | Held until next validation tick | Retains accepted PGN, then returns to LIVE |
| MANUAL_INTERVENTION | Held | Explicit operator action required |

Connection loss is separately represented as **offline** and blocks uploads.
It is never labeled an illegal move. Physical observations and event timestamps
are retained in bounded persisted histories. Late source-time events cannot
overwrite newer sensor observations.

## Manual correction

**Resume automatic reconciliation** retries from the accepted history.
**Accept corrected legal sequence** appends operator-entered SAN, validates
each move with chess.js, validates a complete six-field FEN and requires the
result's physical placement to match the DGT board.

**Restore last known legal state** can approve the already-accepted history
and its exact complete FEN after the arbiter restores the physical pieces.
It cannot arbitrarily invent new castling or en-passant rights.

**Reinitialize LiveChess move recognition** sends a *confirmed operator-requested*
\`setup\` with the accepted legal FEN on that board's current subscription.
It is not sent automatically, and publication remains gated by subsequent
physical verification.

The Broadcast PGN push API does not safely replace an arbitrary conflicting
historical move sequence or full legal game state without affecting an existing
chapter (and round resets can affect other games). Arbitrary midgame
replacements or rewriting earlier published moves are therefore deliberately
blocked. An operator must supply an accurate legal continuation from the
existing history, or reconcile the chapter separately through supported
Lichess controls. This limitation is not silently papered over.

## Upload consistency and idempotency

The recorder regenerates PGN in memory with \`chess.js\`, including Lichess
pairing headers and \`Result "*"\`. It validates the generated PGN by parsing
it back before upload. It never publishes an illegal/unverified move, infers
a game result, or substitutes a clock-expiration result for an interruption.

Each board publishes independently. A successful response stores the exact
acknowledged PGN; unchanged PGNs are not resent, failed attempts can be
retried. The source round/account are bound to the saved game and uploads
fail closed if the account or server changes. The old PGN folder mode remains
available when authoritative mode is disabled.

Physical clock observations are recorded in the local event stream. This
feature does not redesign clock synchronization. In particular Lichess may
continue counting down an earlier \`%clk\` observation on its own web view
during an interruption; that does not prove physical flag-fall.

## Spectator interruption notices: BLOCKED

Desired text:

> Broadcast temporarily interrupted while the physical board position is verified. The last confirmed legal position remains displayed. The game result is not yet determined.

The normal Lichess OAuth Broadcast API provides
\`POST /api/broadcast/round/{broadcastRoundId}/push\` for PGN, but no native
per-game pause or chapter pinned-description update. In the Lichess source,
\`modules/study/src/main/StudySocket.scala\` handles \`descChapter\` within
an **internal study WebSocket/session protocol**, not a documented OAuth REST
mutation. The public API specification does not offer that method.

Therefore the implementation records an explicit **unsupported** spectator
notice status, shows operator notifications locally and keeps the last legal
PGN displayed. It does **not** pretend a warning reached spectators, inject
move comments (Lichess strips them), overwrite existing pinned comments,
use browser cookies, or automate a website login. Even an OAuth token with
\`study:write\` does not by itself authorize \`descChapter\`.

The notice adapter and tests intentionally return \`attempted:false\` and
\`visibleToSpectators:false\`. A real success/failure integration test for a
supported chapter-description write requires Lichess to expose such an
authenticated interface; no fabricated happy-path test is claimed.

## Testing and acceptance limits

- Unit tests exercise legal SAN reconstruction, SAN/physical disagreement,
  lift-and-return, normal captures, castling, en passant, promotion, missing
  or multiple SAN moves, duplicate/out-of-order events, timeout escalation,
  clock-side changes, automatic/manual recovery, disconnection and restart.
- PGN tests check pairing identity, source-state integrity, no inferred
  results and rejected invalid histories.
- Store tests mock the Lichess API and verify that offline/pending/paused games
  are never pushed, board isolation, and failed API acknowledgements.
- Existing native WebSocket tests cover initial discovery and reconnect
  behavior. Cross-platform builds are run by the repository workflows.

**Unverified in this PR:** physical hardware acceptance, actual live
WebSocket/clock timing, Lichess spectator-warning publishing, and arbitrary
historical PGN replacement. Do not describe any of those as complete.

References:
- https://github.com/herohde/livechess-go
- https://github.com/lichess-org/lila/blob/master/modules/study/src/main/StudySocket.scala
- https://github.com/lichess-org/lila/blob/master/ui/analyse/src/study/description.ts
- https://lichess-org.github.io/api/
