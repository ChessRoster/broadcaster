# LiveChess pairing adapter

For tournament operators, start with the [step-by-step pairing import guide](USER-GUIDE.md). The details below describe the adapter's build and protocol.

This startup agent supplies the pairing-write API missing from LiveChess. It loads into the application classloader and executes model operations on the JavaFX application thread. Only **LiveChess 2.2 build 18071800** and **2.2.11 build 26052800** are accepted; the relevant importer, parser, model and persistence code was audited for both builds. It does not start recording, create tournaments, or replace populated rounds.

The JAR contains only these adapter classes. LiveChess and its extracted application JAR must not be redistributed with the broadcaster.

## Build

Use a locally installed, licensed LiveChess distribution and an Eclipse ECJ compiler compatible with Java 8. Obtain the application JAR from the installed package loader's local extraction; it is a compile-time dependency only.

```powershell
./livechess-agent/build.ps1 -ApplicationJar C:\local\application.jar -EcjJar C:\local\ecj.jar
```

This compiles with the LiveChess bundled Java runtime and JavaFX library and writes `src-tauri/resources/livechess-agent.jar`. A Java 8 JDK can also compile the two source files and package them with `Premain-Class: BridgeAgent`.

Launch LiveChess's bundled runtime with `-Dfile.encoding=UTF-8` and `-javaagent:<absolute-jar-path>=1983,@<absolute-token-file>` before its normal classpath/main arguments. The UTF-8 file must contain a token of 32–256 URL-safe alphanumeric, underscore or hyphen characters; surrounding whitespace is trimmed. Protect the token file with private permissions (0600 on Unix). Legacy inline tokens are accepted for compatibility but expose the credential in process command lines. Only one LiveChess process may own a data directory. The broadcaster must check for an existing process before launching; attaching to an already-running uninstrumented instance is unsupported.

The official macOS and Linux packages contain trimmed Java runtimes without a `bin/java` executable. Spawn their native launcher with a process-scoped `JAVA_TOOL_OPTIONS` carrying the agent option and UTF-8 setting. Keep the normal launcher configuration, including user-directory mode. See [PLATFORMS.md](PLATFORMS.md) for inspected package layouts.

## Authenticated loopback protocol

The HTTP listener binds only `127.0.0.1`. Requests require `Authorization: Bearer <token>`, except `GET /health?nonce=<64 lowercase hex characters>`, which returns health plus `serverProof` (hex HMAC-SHA256 of the UTF-8 nonce, keyed by the UTF-8 token). The broadcaster verifies this proof before transmitting its bearer token to a local listener. Browser Origin requests are rejected. No CORS headers are provided. Bodies are limited to 1 MiB.

- `GET /health`: `{ready:true,supported:true,version:"2.2",build:18071800,protocolVersion:1}`.
- `GET /tournaments`: array of `{id,name,rounds}`. `rounds` is the existing round count.
- `POST /pairings`: `{tournamentId,roundNumber,pgn,requestId}`. Round numbers are one based. The request ID must be 1–128 URL-safe characters. PGN must contain complete unfinished games, no moves, White and Black tags, and no duplicate players. Pairings are assigned physical boards in PGN game order; source board tags are not used by LiveChess's importer.
- Success: `{status:"imported"|"already_imported",requestId,tournamentId,roundNumber,count,fingerprint,backup,pairings:[{board,white,black}]}`. The SHA-256 fingerprint covers ordered physical board numbers and the resolved LiveChess player names, serialized as JSON tuples.
- Errors: `{error:"..."}`; HTTP 400 invalid input, 401 auth, 403 browser request, 404 unknown endpoint, 409 round/request conflict, 413 oversized body, 503 busy/timeout.

The adapter parses the entire PGN using LiveChess's actual parser and pairing builder before mutation, rejects incomplete trailing games, then calls the existing ImportPairings operation. An authoritative in-memory tournament backup is written before any mutation. Receipts live in `broadcaster-pairing-receipts` inside the current LiveChess data directory, and backups in `broadcaster-pairing-backups`.

A flushed intent receipt is written before importing. The tournament store's own transactional persistence routine is then flushed and the round identities read back before returning success. If a process or network failure occurs, retry with the **same request ID and pairings**. A populated round is acknowledged only when a matching durable receipt and actual ordered pairing identity both exist. A mismatched populated round is never changed. A pending receipt with an empty round may resume; a committed receipt with an empty round fails closed. Other errors require inspection of the backup and actual round before operator action. Changes to player metadata are not synchronized after import.

This is a version-specific use of private application internals. Validate against an isolated data directory before any real event; physical-board recording is a separate operator action.
