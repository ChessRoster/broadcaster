# Inspected official platform packages

Inspection date: 2026-10-07. These are Intel packages; no ARM-native installer was found on the official download page. Downloaded proprietary artifacts and extraction tools remain in ignored `build/platform-research`, not in distribution resources.

| Platform      | Launcher                                         | Loader JAR                          |
| ------------- | ------------------------------------------------ | ----------------------------------- |
| Windows       | `DGT LiveChess.exe`                              | `app/package.jar`                   |
| macOS         | `DGT LiveChess.app/Contents/MacOS/DGT LiveChess` | `Contents/Java/package.jar`         |
| Linux DEB/RPM | `/opt/DGTLiveChess/DGTLiveChess`                 | `/opt/DGTLiveChess/app/package.jar` |

All inspected loader JARs have SHA-256 `9a57916ca020f8745cefaa1a85f29b7d04d08511c8ff856d5150909b602754de` (14,487,065 bytes). They install base LiveChess 2.2 and may load the updated application from the user data directory.

macOS contains a trimmed Oracle Java runtime under `Contents/PlugIns/Java.runtime/Contents/Home/jre` (`lib/server/libjvm.dylib`); Linux under `runtime` (`lib/amd64/server/libjvm.so`). Neither has `bin/java`. Their Java packager native launchers use the installed configuration files, `Contents/Java/DGT LiveChess.cfg` and `app/DGTLiveChess.cfg`, whose JVM options include `-Dcom.novotea.livechess.loader.directory=user`.

For Unix native launch, set `JAVA_TOOL_OPTIONS` only on the child process to include `-Dfile.encoding=UTF-8` and `-javaagent:<absolute-agent>=1983,@<absolute-private-tokenfile>`. Quote the complete Java agent option when paths contain spaces. This uses the standard JVM invocation mechanism without editing installed proprietary files. Clear inherited `_JAVA_OPTIONS`/`JDK_JAVA_OPTIONS` and control the child options to prevent accidental overrides. The loader main class is `com.novotea.livechess.loader.LiveChessLoader` on every platform.

User data directories from the actual loader's `userDir()` implementation:

- Windows: `%APPDATA%/DGT LiveChess/data`.
- macOS: `${user.home}/Library/Application Support/DGT LiveChess`.
- Linux: `${user.home}/.dgt_livechess`. The loader attempts to rename legacy `.dgt livechess` into this path.

For isolated Unix tests, set both child HOME and `-Duser.home=<isolated-home>`; Java's default home may derive from OS account records rather than HOME. Without user-directory mode the loader instead uses relative `livechess` under its working directory. Do not run two instances against one directory.

Official download page: <https://www.livechesscloud.com/software/>. Package SHA-256 values:

- macOS: <https://download.livechesscloud.com/installer/2.2/DGT-LiveChess-2.2.dmg> — `f66c071957254e7614e4fcac520e60659605a1611416314a53ea334015c25a34`.
- Linux DEB: <https://download.livechesscloud.com/installer/2.2/DGT-LiveChess-2.2-x86_64.deb> — `456abb65819bdb56cf0918b523b32cf3ea53a3c5ba6be933e666895279ecfe2f`.
- Linux RPM: <https://download.livechesscloud.com/installer/2.2/DGT-LiveChess-2.2-x86_64.rpm> — `56dab0ebd74ebe396a10cc62154434e8652baacb80e283705f41aa80059969ae`.

The official updater manifest <https://release.livechesscloud.com/release/livechess-2.json> identifies automatic update build 26052800 at <https://release.livechesscloud.com/image/release-2.2.11.jar>. That JAR has SHA-256 `fa4c7542ff9d2eab04b66a19bd66114d8c0c266d642a34293bcf32b8bb62a17c`; its release properties contain `Version: 2.2.11`, `Build: 26052800`, and `Timestamp: 2026-05-28T13:19:56Z`. This establishes the artifact build timestamp, not a separately published announcement date. The installer download page still identifies 2.2 released July 19, 2018.

Local Windows tests verified the token-file startup option against isolated 2.2.11 data. Platform CI verified actual native launcher startup, Unicode pairing imports, duplicate/conflict guards, persistence across restart and next-round import on Intel macOS 15 and Ubuntu 24.04 using the official installers. These tests use an isolated synthetic tournament; physical-board and Apple Silicon operation remain untested.
