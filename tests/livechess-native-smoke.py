"""Verify native LiveChess imports and durable retries using isolated synthetic data."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

TOURNAMENT_ID = "11111111-1111-4111-8111-111111111111"
launcher = Path(sys.argv[1]).resolve()
agent = Path(sys.argv[2]).resolve()
fixture = Path(__file__).parent / "fixtures" / "livechess-tournament.json"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(token, path, body=None):
    headers = {"Authorization": "Bearer " + token}
    encoded = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        encoded = json.dumps(body).encode()
    call = urllib.request.Request("http://127.0.0.1:1983" + path, data=encoded, headers=headers)
    with opener.open(call, timeout=40) as response:
        return json.load(response)


def import_body(round_number, request_id, pgn):
    return {"tournamentId": TOURNAMENT_ID, "roundNumber": round_number,
            "requestId": request_id, "pgn": pgn}


def rejected(token, body, expected_status):
    try:
        request(token, "/pairings", body)
    except urllib.error.HTTPError as error:
        assert error.code == expected_status, f"Unexpected rejection {error.code}"
        return
    raise AssertionError("Unsafe import was accepted")


def stop(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    # Native launcher/Xvfb wrappers can exit before a descendant completes shutdown.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", 1983), timeout=0.2):
                time.sleep(0.1)
        except OSError:
            return
    raise RuntimeError("Native adapter did not release its listener after shutdown")


with tempfile.TemporaryDirectory(prefix="livechess-smoke-") as isolated:
    home = Path(isolated)
    data_directory = home / ("Library/Application Support/DGT LiveChess" if sys.platform == "darwin"
                             else ".dgt_livechess")
    index = data_directory / "tournament" / TOURNAMENT_ID / "index.json"
    index.parent.mkdir(parents=True)
    shutil.copyfile(fixture, index)
    token = secrets.token_hex(32)
    credential = home / "bridge-token"
    credential.write_text(token, encoding="utf-8")
    credential.chmod(0o600)
    environment = os.environ.copy()
    environment["HOME"] = str(home)
    environment.pop("_JAVA_OPTIONS", None)
    environment.pop("JDK_JAVA_OPTIONS", None)
    # Java parses quotes itself, independently of the native process argument list.
    options = ["-Dfile.encoding=UTF-8", f"-Duser.home={home}", f"-javaagent:{agent}=1983,@{credential}"]
    environment["JAVA_TOOL_OPTIONS"] = " ".join('"' + option + '"' for option in options)
    command = [str(launcher)]
    if sys.platform.startswith("linux"):
        command = ["xvfb-run", "-a", *command]
    pgn = ('[White "Test, Élodie"]\n[Black "王伟"]\n[Round "1"]\n[Result "*"]\n\n*\n\n'
           '[White "Test, Alice"]\n[Black "Test, Bob"]\n[Round "1"]\n[Result "*"]\n\n*\n')
    original = import_body(1, "native-smoke-original", pgn)
    fingerprint = None
    for launch in range(2):
        log = home / f"launcher-{launch}.log"
        with log.open("wb") as output:
            process = subprocess.Popen(command, env=environment, cwd=home, stdout=output,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            try:
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError(f"Native LiveChess exited with status {process.returncode}")
                    try:
                        nonce = secrets.token_hex(32)
                        with opener.open(f"http://127.0.0.1:1983/health?nonce={nonce}", timeout=2) as response:
                            data = json.load(response)
                        expected = hmac.new(token.encode(), nonce.encode(), hashlib.sha256).hexdigest()
                        assert hmac.compare_digest(data.get("serverProof", ""), expected), "Invalid adapter proof"
                        if not data.get("ready"):
                            time.sleep(1)
                            continue
                        assert data.get("supported") and data.get("protocolVersion") == 1
                        assert (data.get("version"), data.get("build")) in [("2.2", 18071800), ("2.2.11", 26052800)]
                        break
                    except (OSError, ValueError):
                        time.sleep(1)
                else:
                    raise RuntimeError("Native LiveChess adapter startup timed out")
                tournaments = request(token, "/tournaments")
                assert len(tournaments) == 1 and tournaments[0]["id"] == TOURNAMENT_ID, "Home isolation failed"
                assert tournaments[0]["rounds"] == 1, "Unexpected fixture round count"
                imported = request(token, "/pairings", original)
                assert imported["status"] == ("imported" if launch == 0 else "already_imported")
                assert imported["count"] == 2
                assert "Élodie" in imported["pairings"][0]["white"] and "王伟" in imported["pairings"][0]["black"]
                if fingerprint is None:
                    fingerprint = imported["fingerprint"]
                assert imported["fingerprint"] == fingerprint, "Pairing identity changed after restart"
                replay = request(token, "/pairings", original)
                assert replay["status"] == "already_imported" and replay["fingerprint"] == fingerprint
                rejected(token, import_body(1, "native-smoke-overwrite", pgn), 409)
                rejected(token, import_body(2, "native-smoke-moves", pgn.replace("\n\n*", "\n\n1. e4 *", 1)), 400)
                assert request(token, "/tournaments")[0]["rounds"] == 1, "Rejected PGN changed the tournament"
                if launch == 1:
                    next_round = request(token, "/pairings", import_body(2, "native-smoke-next", pgn.replace('[Round "1"]', '[Round "2"]')))
                    assert next_round["status"] == "imported" and next_round["count"] == 2
                    assert request(token, "/tournaments")[0]["rounds"] == 2
                print(f"Native LiveChess {data['version']}/{data['build']}: import/retry/guards verified (launch {launch + 1})")
            except BaseException:
                output.flush()
                print(log.read_text(encoding="utf-8", errors="replace")[-12000:], file=sys.stderr)
                raise
            finally:
                stop(process)

