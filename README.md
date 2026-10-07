# Lichess Broadcaster

[![Build](https://github.com/lichess-org/broadcaster/actions/workflows/tauri-publish.yml/badge.svg)](https://github.com/lichess-org/broadcaster/actions/workflows/tauri-publish.yml)
[![CI](https://github.com/lichess-org/broadcaster/actions/workflows/ci.yml/badge.svg)](https://github.com/lichess-org/broadcaster/actions/workflows/ci.yml)

This is a cross-platform desktop application for automatically uploading PGN files (chess game notation) from your local computer to a live [Lichess Broadcast](https://lichess.org/broadcast).

Some smart chess boards used in OTB (over the board) events can write PGN files to a folder on your computer. This application monitors that folder and uploads the PGN file in real-time using the [Lichess API](https://lichess.org/api). In practice, this means anyone with internet access can follow the ongoing OTB games live and with minimal additional effort from tournament organisers. Lichess freely provides the infrastructure to show the tournament games to thousands of spectators, which would otherwise be a costly or technically challenging task for organizers.

![image](https://github.com/lichess-org/broadcaster/assets/271432/2ec27912-0ef2-4ac6-9870-130e01f444aa)

## About

### LiveChess pairing sync

This fork adds an optional reverse path: publish pairing PGN to a Lichess broadcast, and Broadcaster imports it into DGT LiveChess automatically. Existing PGN-folder uploads continue to send the recorded moves back to Lichess.

Close an ordinarily launched LiveChess instance, enter its installation path, and use **Start LiveChess** in Broadcaster's Settings or round page. The app launches LiveChess with its bundled pairing add-on; it never terminates an existing instance. Managed startup supports Windows, macOS and Linux installation layouts and requires LiveChess's bundled Java runtime. Select the installation as follows:

| Platform | Installation path                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | The LiveChess installation folder, usually `C:\Program Files\Digital Game Technology\DGT LiveChess`.                                                       |
| macOS    | The installed `.app` bundle, usually `/Applications/DGT LiveChess.app`; enter the bundle itself rather than `Contents/Java`, which contains `package.jar`. |
| Linux    | The installed LiveChess root folder, usually `/opt/DGTLiveChess`, containing `app/package.jar`, the native launcher and bundled Java runtime.              |

The installation field defaults to the usual Windows folder only on Windows. On macOS and Linux, enter the location of your actual installation. Saved paths are preserved. Unix startup uses LiveChess's native launcher and bundled runtime, with the pairing add-on supplied through `JAVA_TOOL_OPTIONS`; a standalone `runtime/bin/java` executable is not required. On Apple Silicon, the older Intel LiveChess application requires Rosetta. Apple Silicon/Rosetta operation and physical-board recording have not been tested.

The launcher checks the supported application package, and the add-on accepts runtime builds **2.2 / 18071800** and **2.2.11 / 26052800**, including the loader's update to the latter. Unknown application builds fail closed. Actual pairing imports, duplicate protection and restart recovery were verified with isolated data on Windows, Intel macOS 15 and Ubuntu 24.04. CI uses the official native macOS/Linux installers; physical-board operation remains untested.

Sign in to Lichess, open the first broadcast round to synchronize, choose an existing LiveChess tournament, its destination starting round, and the expected physical board count. Leave automatic future-round discovery enabled. Broadcaster then follows that tournament's rounds in their saved order while it stays open. Settings shows the mappings and pause controls. Sign in and start the managed LiveChess instance again after reboot if necessary; startup services are not installed.

Each published game must have a unique **Board** header (`1` through the configured board count), or an explicit **Round** value such as `5.1`, `5.2` describing round and board. The add-on imports in physical-board order, never arbitrary chapter order. Only a complete set of unplayed pairings is accepted; moves, finished results, byes, custom positions, conflicting numbering, and partial publication block import. Configure only the games for connected broadcast boards. A fixed expected count applies to future rounds; events that change that count need their mapping reconciled.

The app saves each pending request before sending it. LiveChess backs up the tournament, persists the changes, and records a receipt. Lost responses retry the same request; conflicting or populated rounds are not overwritten. Pausing a tournament stops undispatched imports; an already-dispatched import can finish. Changing Lichess server or account pauses sync until explicitly resumed. Starting board recording is still a separate LiveChess action.

This uses private LiveChess internals. Source, protocol, reproducible build instructions and isolated-JVM test evidence are in [`livechess-agent/README.md`](livechess-agent/README.md) and [`livechess-agent/TESTING.md`](livechess-agent/TESTING.md). No DGT application binary is redistributed. Bridge credentials remain in the app's local data folder; the OS account running the app is trusted. Development builds keep automatic binary updates disabled until compatible release artifacts are available.

The integration workflow builds platform artifacts with the agent resource and embedded frontend. Keep each executable or application bundle together with its resource files when extracting an artifact. These development builds are unsigned and are not installers; Windows requires WebView2, and every platform requires a supported LiveChess installation. Follow the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your operating system before running normal development/build commands. CI compilation does not establish that a physical DGT board or a particular LiveChess installation has been tested on that platform.

This app is built with [Tauri](https://tauri.app/), a framework for building desktop apps with web technologies. It's written in Rust and TypeScript.

Contributions are welcome. Please read our [Contributing](https://lichess.org/help/contribute) guide if you're interested in helping with this or our other projects.

## Download

To download the latest version, go to the [Releases](https://github.com/lichess-org/broadcaster/releases) and download the installer for your operating system.

## Code signing policy

This program uses free code signing provided by [SignPath.io](https://signpath.io?utm_source=foundation&utm_medium=github&utm_campaign=lichess) and a certificate by the [SignPath Foundation](https://signpath.org?utm_source=foundation&utm_medium=github&utm_campaign=lichess)

## Privacy Policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. See the Lichess [Privacy Policy](https://lichess.org/privacy).

## Development Setup

### Prerequisites

1. Follow steps for installing Rust + Tauri here: https://tauri.app/start/prerequisites/
2. Install pnpm
   ```bash
    npm install -g pnpm
   ```

### Run

```bash
pnpm install
pnpm tauri dev
```

### Formatting / Linting / Tests

```bash
pnpm format
pnpm tsc

pnpm test
# or
pnpm test:watch
```

### Testing

#### To seed a bunch of test broadcasts with rounds:

```bash
pnpx tsx sample-data/generate/add-broadcasts.ts
```

#### To simulate boards writing PGN to a folder:

1. In the app, select a Round and start a folder watch.
2. Run this to automatically write a bunch of PGN to the folder:

```bash
pnpx tsx sample-data/generate/index.ts games path/to/folder
```

#### Test that `games.pgn` is given priority over any `game-*.pgn` files:

```bash
pnpx tsx sample-data/generate/index.ts multigame path/to/folder
```

#### Test errors by writing bad PGN files:

```bash
pnpx tsx sample-data/generate/index.ts errors path/to/folder
```

### Icon Generation

Given a source image file, generate the icon files for the app:

```bash
convert src/assets/app-icon.png -size 702x702 xc:none -fill white -draw "roundrectangle 0,0,702,702,351,351" src/assets/mask.png
convert src/assets/app-icon.png \( src/assets/mask-1.png -alpha off \) -compose copy_opacity -composite src/assets/rounded.png
pnpm tauri icon src/assets/rounded.png
```

### Test Release Build

```bash
export TAURI_SIGNING_PRIVATE_KEY="..."
pnpm tauri build
```

Release artifacts are in `src-tauri/target/release/bundle/`

## Release (for maintainers)

1. Tag the new version:

   ```bash
   ./scripts/release
   ```

2. Github workflow will build the app for each OS, create a release, and attach the artifacts.
   - Approve the signing request in the SignPath dashboard when the workflow gets to that step.

3. When ready to recommend the update, update the ["Check for Updates" endpoint](https://lichess-org.github.io/broadcaster/version.json) ([source](https://github.com/lichess-org/broadcaster/blob/main/updater/version.json)):

   ```bash
   ./scripts/updater.py
   ```

   Then push the change to Github. Workflow will automatically publish to Github Pages.
