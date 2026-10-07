#!/usr/bin/env python3
"""Reproducibly build our agent; proprietary compile inputs stay in the ignored cache."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
TRACKED = ROOT.parent / "src-tauri/resources/livechess-agent.jar"
INPUTS = {
    "livechess.deb": ("https://download.livechesscloud.com/installer/2.2/DGT-LiveChess-2.2-x86_64.deb",
                     "456abb65819bdb56cf0918b523b32cf3ea53a3c5ba6be933e666895279ecfe2f"),
    "ecj.jar": ("https://repo.maven.apache.org/maven2/org/eclipse/jdt/ecj/3.26.0/ecj-3.26.0.jar",
                "ac0ba5876eaf7ebb47749a0d1be179c51f194b9dd0b875d1c09e1b530f5a2db5"),
}
EXTRACTED_HASHES = {
    "package.jar": "9a57916ca020f8745cefaa1a85f29b7d04d08511c8ff856d5150909b602754de",
    "application.jar": "abab780db894ab418488f0796b41f0a504161528ffcfa7b73ae3319dcc867699",
    "rt.jar": "2eee944a3ec3ada59d452dd923b3bed4340f300ad3ed7a7e187c2716a0c06f3f",
    "jce.jar": "41c99fea1ed6501c0cee298380ccb75baac4d9e3390fdb67c3cc2807240155e6",
    "jfxrt.jar": "09b98f9c7d9d5a2c3b83afa9de0d3becf623e657d7b8b452fe4354a16d93415e",
}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(path, expected):
    if sha256(path) != expected:
        raise RuntimeError(f"SHA-256 mismatch: {path.name}")


def download(cache, name, url, expected):
    target = cache / name
    if target.exists():
        verify(target, expected)
        return
    with tempfile.NamedTemporaryFile(dir=cache, delete=False) as temporary:
        pending = Path(temporary.name)
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                shutil.copyfileobj(response, temporary)
        except BaseException:
            pending.unlink(missing_ok=True)
            raise
    try:
        verify(pending, expected)
        pending.replace(target)
    finally:
        pending.unlink(missing_ok=True)


def deb_data_archive(deb):
    """Read the pinned Debian ar container without executing installer scripts."""
    with deb.open("rb") as stream:
        if stream.read(8) != b"!<arch>\n":
            raise RuntimeError("Invalid Debian archive")
        while header := stream.read(60):
            if len(header) != 60 or header[58:] != b"`\n":
                raise RuntimeError("Invalid ar header")
            size = int(header[48:58].strip())
            name = header[:16].decode("ascii").strip().rstrip("/")
            body = stream.read(size)
            if len(body) != size:
                raise RuntimeError("Truncated Debian archive")
            if size % 2:
                stream.read(1)
            if name == "data.tar.xz":
                return body
    raise RuntimeError("Debian archive contains no data.tar.xz")


def dependencies(cache):
    for name, (url, expected) in INPUTS.items():
        download(cache, name, url, expected)
    if not all((cache / name).exists() for name in EXTRACTED_HASHES):
        wanted = {
            "opt/DGTLiveChess/app/package.jar": "package.jar",
            "opt/DGTLiveChess/runtime/lib/rt.jar": "rt.jar",
            "opt/DGTLiveChess/runtime/lib/jce.jar": "jce.jar",
            "opt/DGTLiveChess/runtime/lib/ext/jfxrt.jar": "jfxrt.jar",
        }
        with tarfile.open(fileobj=io.BytesIO(deb_data_archive(cache / "livechess.deb")), mode="r:xz") as archive:
            for member in archive:
                name = member.name.removeprefix("./")
                if name in wanted:
                    if not member.isfile():
                        raise RuntimeError(f"Expected regular dependency: {name}")
                    with archive.extractfile(member) as source:
                        (cache / wanted[name]).write_bytes(source.read())
        with zipfile.ZipFile(cache / "package.jar") as package:
            (cache / "application.jar").write_bytes(package.read("application.jar"))
    for name, expected in EXTRACTED_HASHES.items():
        verify(cache / name, expected)


def package_jar(classes, output):
    entries = {"META-INF/MANIFEST.MF": b"Manifest-Version: 1.0\r\nPremain-Class: BridgeAgent\r\n\r\n"}
    for file in sorted(classes.glob("*.class")):
        entries[file.name] = file.read_bytes()
    if "BridgeAgent.class" not in entries or "PairingBridge.class" not in entries:
        raise RuntimeError("Compiler produced no agent classes")
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as jar:
        for name in sorted(entries):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 0
            info.external_attr = 0x20
            jar.writestr(info, entries[name])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--java", default="java", help="Java executable (8 or newer)")
    parser.add_argument("--cache", type=Path, default=ROOT / "build/dependencies")
    parser.add_argument("--output", type=Path, default=ROOT / "build/livechess-agent.jar")
    parser.add_argument("--verify-tracked", action="store_true", help="Fail if tracked resource differs from fresh source build")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    (ROOT / "build").mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    dependencies(args.cache)
    # Removed/renamed source classes cannot survive this clean, temporary compilation.
    with tempfile.TemporaryDirectory(prefix="agent-classes-", dir=ROOT / "build") as directory:
        classes = Path(directory)
        sources = sorted((ROOT / "src").glob("*.java"))
        command = [args.java, "-jar", str(args.cache / "ecj.jar"), "-1.8", "-encoding", "UTF-8", "-g:none",
                   "-bootclasspath", os.pathsep.join(str(args.cache / name) for name in ("rt.jar", "jce.jar")),
                   "-classpath", os.pathsep.join(str(args.cache / name) for name in ("application.jar", "jfxrt.jar")),
                   "-d", str(classes), *map(str, sources)]
        subprocess.run(command, check=True)
        pending = classes / "agent.jar"
        package_jar(classes, pending)
        if args.verify_tracked and (not TRACKED.exists() or sha256(pending) != sha256(TRACKED)):
            raise RuntimeError("Tracked livechess-agent.jar differs from sources; rebuild with --output src-tauri/resources/livechess-agent.jar")
        shutil.copyfile(pending, args.output)
    print(json.dumps({"output": str(args.output.resolve()), "sha256": sha256(args.output)}))


if __name__ == "__main__":
    main()

