# Import Lichess pairings into DGT LiveChess

Use this guide to publish pairings once on Lichess and have Lichess Broadcaster put them into your local LiveChess tournament. You still start board recording in LiveChess yourself.

## Before you start

- Use a Broadcaster build that includes **LiveChess pairing import**. The upstream releases linked from the main README do not necessarily include this feature.
- Install DGT LiveChess separately. Supported runtime versions are **2.2 / build 18071800** and **2.2.11 / build 26052800**.
- Sign in to Lichess in Broadcaster with an account that can access your broadcast.
- In LiveChess, create the destination tournament using your normal tournament setup, then close LiveChess. Broadcaster imports into an existing tournament; it does not create one.
- Decide how many physical boards you will broadcast. Include only those games in the Lichess round used for this import. The same board count applies to future rounds.

Try the workflow with a separate test tournament before using it at an event. Actual software imports have been tested on Windows, Intel macOS and Linux; physical-board recording and Apple Silicon/Rosetta operation have not yet been verified.

## 1. Start LiveChess from Broadcaster

Open **Settings** in Broadcaster and find **LiveChess pairing import**. Enter your installation path:

| Operating system | Usual installation path                                  |
| ---------------- | -------------------------------------------------------- |
| Windows          | `C:\Program Files\Digital Game Technology\DGT LiveChess` |
| macOS            | `/Applications/DGT LiveChess.app`                        |
| Linux            | `/opt/DGTLiveChess`                                      |

On macOS, select the `.app` itself. If you installed LiveChess elsewhere, use that location.

Click **Start LiveChess**. Wait for the connected message. Broadcaster starts LiveChess with the pairing add-on automatically; no terminal commands or manual Java configuration are needed. **Check connection** checks an instance already started this way.

If LiveChess is already running from its own shortcut, close it normally first, then click **Start LiveChess**. Broadcaster cannot add the pairing functionality to an ordinarily launched instance and will not close it for you.

## 2. Publish complete, unplayed pairings on Lichess

Create the Lichess broadcast round and upload its pairing PGN using your pairing publisher or the Lichess API. Broadcaster downloads the pairings already on Lichess; it does not generate tournament pairings.

Each game needs player names, `Result "*"`, no moves, and an explicit physical board number. Use unique `Board` tags numbered consecutively from `1` to your expected board count. Alternatively, use `Round` values such as `1.1`, `1.2`, where the suffix identifies the physical board. Ordinary `Round "1"` alone does not identify a board.

For example, this is a complete two-board pairing file:

```pgn
[Event "Example tournament"]
[Site "Example venue"]
[Date "2026.10.07"]
[Round "1"]
[Board "1"]
[White "Alice Example"]
[Black "Bob Example"]
[Result "*"]

*

[Event "Example tournament"]
[Site "Example venue"]
[Date "2026.10.07"]
[Round "1"]
[Board "2"]
[White "Carol Example"]
[Black "David Example"]
[Result "*"]

*
```

Publish all boards before play starts. Missing boards, duplicate players or board numbers, moves, finished results, byes and custom starting positions prevent import. Board 1 in the PGN becomes physical board 1 in LiveChess, regardless of the order games appear on Lichess.

## 3. Connect the Lichess tournament to your local tournament

In Broadcaster, open the first Lichess broadcast round you want to import. In **LiveChess pairing import**:

1. Click **Check connection** to load the local tournament list if necessary.
2. Select your destination under **LiveChess tournament**.
3. Set **Destination LiveChess round for this starting Lichess round**. Use `1` when starting a new event at round 1. Choose an empty destination round; existing pairings are never overwritten.
4. Set **Expected physical boards** to the number of games you published, for example `2` for the sample above.
5. Leave **Automatically discover and import this tournament’s future rounds** checked.
6. Click **Enable automatic tournament pairing sync**.

For example, choosing Lichess round 3 and destination LiveChess round `3` maps that round to local round 3; later Lichess rounds map to local rounds 4, 5 and so on in the tournament's saved round order. This follows round order, not the numbers typed into round names. Keep that order stable after enabling sync.

For a single round only, clear the future-round checkbox and click **Enable pairing import for this round** instead.

## 4. Confirm the import, then start recording

Keep Broadcaster open. It checks for pairings approximately every 15 seconds; incomplete rounds wait rather than importing a partial set.

Look for **Pairings imported. Start recording in LiveChess when ready.** on the round's import status. In LiveChess, inspect the destination round and confirm that each board has the correct White and Black players. Then start recording using your normal LiveChess controls.

To send recorded moves back to Lichess, use LiveChess's PGN filesystem export and Broadcaster's existing folder upload controls for the corresponding Lichess round. Pairing import does not configure move uploads or start recording. DGT Cloud is not required for this local PGN workflow.

## Later rounds and restarting

Publish each new round's complete, unplayed pairings to the same Lichess tournament before play. Broadcaster discovers future rounds automatically and processes the oldest unfinished import first. You do not need to create another mapping for every round.

After restarting your computer, open Broadcaster, sign in if needed, and use **Start LiveChess** again. Saved mappings remain available. If the Lichess account or server changes, sync pauses: review the mapping in **Settings** and use **Resume tournament sync** when it is correct.

Use **Pause tournament sync** before changing pairings or investigating a problem. An import already sent to LiveChess can still finish. Once imported, later edits on Lichess do not update that local round; corrections require manual reconciliation in LiveChess. If the board count changes between rounds, pause and reconcile the mapping rather than leaving the old count active.

## Troubleshooting

| What you see                                                | What to do                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LiveChess is not connected                                  | Close an ordinarily launched instance, check the installation path, and use **Start LiveChess**.                                                                                           |
| Unsupported version or package                              | Use an explicitly supported LiveChess installation. A newer build needs compatibility verification before the integration will accept it.                                                  |
| Waiting for complete pairings, or a validation error        | Check the expected board count, consecutive board numbering, unique player names, `Result "*"`, and absence of moves. Confirm that all games were published to the selected Lichess round. |
| A round already contains pairings or a conflict is reported | Pause sync and inspect the actual destination round. The app will not replace it. Do not delete pairings merely to force a retry.                                                          |
| Import pending confirmation                                 | Restore the connection and resume the same mapping. The app retries the saved request and checks its durable receipt; do not create a replacement mapping.                                 |
| Later rounds do not import                                  | Resolve the earliest incomplete round first. Confirm sync is enabled and the account, connection, round order and board count are correct.                                                 |

Before importing, LiveChess saves a tournament backup in `broadcaster-pairing-backups` under its data directory. See [platform data locations](PLATFORMS.md) if manual recovery is needed.

## macOS and Rosetta

Lichess Broadcaster's release configuration supports native Intel and Apple Silicon builds. The inspected DGT LiveChess macOS package is Intel-only and needs Rosetta on Apple Silicon.

Apple identifies macOS 27 as the last release with general Rosetta support. The current Intel-only LiveChess package will not run on Apple Silicon under macOS 28. Continued use on newer macOS versions will need an ARM-compatible LiveChess runtime or a replacement. A compatible older macOS installation, Windows or Linux remains an alternative. This limitation belongs to the DGT runtime; Broadcaster does not make an Intel-only runtime ARM-compatible. See [Apple's Rosetta announcement](https://developer.apple.com/news/?id=w5ngl9k2) and [platform support details](PLATFORMS.md).
