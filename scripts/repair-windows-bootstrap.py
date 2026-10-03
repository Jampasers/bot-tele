#!/usr/bin/env python3
"""Repair the known Chrome CMD escaping bug on a mounted Windows partition."""
import os
import sys
import tempfile
from pathlib import Path


def child(directory: Path, name: str) -> Path:
    matches = [entry for entry in directory.iterdir() if entry.name.casefold() == name.casefold()]
    if len(matches) != 1 or matches[0].is_symlink():
        raise ValueError(f"Expected one real {name} in {directory}; files left unchanged.")
    return matches[0]


def chrome_block(separator: bytes, newline: bytes) -> bytes:
    return newline.join((
        b'if exist "%SystemRoot%' + separator + b'bot-tele-chrome-required" '
        b'if not exist "%SystemRoot%' + separator + b'bot-tele-chrome-ready" (',
        b'    if exist "%SystemDrive%' + separator + b'windows-install-chrome.bat" '
        b'call "%SystemDrive%' + separator + b'windows-install-chrome.bat"',
        b')',
        b'',
    ))


def repair(root: Path) -> None:
    root = root.resolve(strict=True)
    windows = child(root, "Windows")
    config = child(child(windows, "System32"), "config")
    if not child(config, "SYSTEM").is_file():
        raise ValueError("This is not a mounted Windows OS partition; files left unchanged.")
    script = child(root, "windows-fix-rdp.bat")
    if script.stat().st_size > 256 * 1024:
        raise ValueError("Unexpected bootstrap size; files left unchanged.")
    source = script.read_bytes()
    if b"bot-tele critical bootstrap start" not in source or b":BOT_TELE_WAIT_SETUP" not in source:
        raise ValueError("This is not a recognized bot-tele bootstrap; files left unchanged.")
    legacy = [chrome_block(separator, b"\\n") for separator in (b"\\\\", b"\\")]
    matches = [block for block in legacy if block in source]
    if not matches:
        if any(b"\\n" in line and b"bot-tele-chrome-required" in line for line in source.splitlines()):
            raise ValueError("Unrecognized literal newline escapes; files left unchanged. Inspect windows-setup.log.")
        print("No known Chrome newline bug found. Inspect windows-setup.log for the remaining cause.")
        return
    block = matches[0]
    password_line = b'if exist "%SystemRoot%\\bot-tele-password-ready" ('
    if len(matches) != 1 or source.count(block) != 1 or block + password_line not in source:
        raise ValueError("Expected exactly one known Chrome prerequisite block; files left unchanged.")
    newline = b"\r\n" if b"\r\n" in source else b"\n"
    updated = source.replace(block, chrome_block(b"\\", newline), 1)
    backup = script.with_name(script.name + ".bot-tele-bootstrap.bak")
    if backup.is_symlink() or (backup.exists() and not backup.is_file()):
        raise ValueError("Backup is not a regular file; files left unchanged.")
    if not backup.exists():
        with backup.open("xb") as saved:
            saved.write(source)
            saved.flush()
            os.fsync(saved.fileno())
    # Replace only after the complete repaired file and the original backup
    # have been saved. No registry, credentials, network, or disk layout edits.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=root, prefix=script.name + ".", delete=False) as output:
            temporary = Path(output.name)
            output.write(updated)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, script.stat().st_mode & 0o777)
        os.replace(temporary, script)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    print(f"Chrome prerequisite block repaired. Original backup: {backup}")
    print("Return the Droplet to Boot from Hard Drive to retry its existing startup bootstrap.")
    print("This script has not run the installer or rebooted the VPS. RDP still needs verification.")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Usage: python3 repair-windows-bootstrap.py /path/to/mounted/windows")
        repair(Path(sys.argv[1]))
    except (OSError, ValueError) as error:
        sys.exit(str(error))
