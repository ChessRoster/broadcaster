# Adapter verification

Actual isolated LiveChess JVM tests were run on 2026-10-06. Test data was a copy of a prior demonstration tournament, never the operator's production tournament directory. All test JVMs were stopped afterward. Generated data, logs, proprietary dependencies and decompiled comparison files are ignored under `build/`.

| Check                                                                  | Result                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------ |
| Java 8 target compile with bundled runtime and ECJ                     | Passed                                                 |
| Actual release guard against newer loader application                  | Rejected until audited build explicitly added          |
| LiveChess 2.2 build 18071800: import two games with player rating      | Passed, count 2, physical boards 1–2                   |
| Immediate same request replay                                          | `already_imported`, unchanged fingerprint/count        |
| Restart into 2.2.11 build 26052800 and replay old request              | `already_imported`, unchanged fingerprint/count        |
| Latest build: import two games, then terminate/restart and replay      | Passed, durable receipt and actual disk pairings agree |
| Same request ID with different names                                   | HTTP 409                                               |
| Populated round with new request ID                                    | HTTP 409                                               |
| Missing final result or incomplete PGN                                 | HTTP 400                                               |
| Custom FEN                                                             | HTTP 400                                               |
| PGN containing moves                                                   | HTTP 400                                               |
| Clear committed imported round in isolated disk state, restart, replay | HTTP 409, manual reconciliation required               |
| Final JAR: fresh next-round import and immediate replay                | Passed                                                 |
| Unauthenticated nonce health proof                                     | Matched independently computed HMAC-SHA256             |

On 2026-10-07, an isolated LiveChess 2.2.11 JVM was launched using `1984,@<absolute UTF-8 token-file>` agent options. Authenticated health succeeded with the file's token. The process was stopped afterward. The token itself was absent from the JVM command line.

The 2.2.11 audit compared ImportPairings, PGNPairingBuilder, DefaultTournamentService, EntityFile, Tournament, Round, Pairing, Player, DefaultRelease, ModuleRelease and PGNParser against the 2.2 sources. Models and tournament service were unchanged. The builder recognizes `-` as missing metadata; importer improves parse error details; PGNParser wraps tag-processing exceptions; EntityFile tracks scheduling separately but retains its transactional persistence method. Actual persistence/readback tests confirmed the adapter's use of that method on both builds.

Physical DGT board recording, full native desktop installation, and live Lichess server publication are outside these adapter tests. The agent never starts recording.

## Native Unix integration

On 2026-10-07, integration workflow run 37643982870 passed actual native LiveChess integration checks on Intel macOS 15 and Ubuntu 24.04. The official installer was downloaded with a pinned SHA-256 and run with an isolated Java home containing only `tests/fixtures/livechess-tournament.json`.

The checks import two games containing accented and Chinese names, retry the same request, reject a new request against the populated round, reject PGN containing moves without creating a round, terminate/restart LiveChess and reconcile the original request, then import a second round. Health authentication, ordered pairing fingerprint and game counts are checked. Downloaded proprietary packages are temporary test dependencies and are not included in artifacts. Physical DGT recording is not exercised.

## Native Windows desktop integration

On 2026-10-07, the compiled Windows desktop artifact was exercised through its actual WebView2 renderer and Tauri commands against an isolated APPDATA directory containing only synthetic tournament data. Managed startup connected to LiveChess 2.2.11/26052800. Tournament listing returned the fixture, importing two pairings succeeded, and retrying the same request returned `already_imported` with identical count and fingerprint. Independent disk inspection after shutdown confirmed both pairings persisted. Connection controls reported success and no renderer errors occurred. Only the test's own application and JVM processes were stopped; no live Lichess publication or physical-board recording was performed.
