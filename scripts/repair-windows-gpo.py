#!/usr/bin/env python3
"""Repair the GPO registry block in an already prepared, stopped installer."""
import re
import shutil
import sys
from pathlib import Path


def repair(script: Path) -> None:
    source = script.read_bytes().decode("utf-8")
    block = re.compile(
        r'(?m)(^[ \t]*cat > "\$_gpo_reg" <<\'EOF_BOT_GPO_REG\'\r?\n)'
        r'(.*?)'
        r'(^EOF_BOT_GPO_REG$)',
        re.DOTALL,
    )
    matches = list(block.finditer(source))
    if len(matches) != 1:
        raise ValueError("Expected exactly one bot-tele GPO registry block; installer left unchanged.")
    match = matches[0]
    seen = set()
    output = []
    for line in match[2].splitlines():
        key = re.fullmatch(r"\[(\\[^\]]+)\]", line)
        if key:
            parts = key[1].split("\\")[1:]
            for depth in range(1, len(parts)):
                parent = "\\" + "\\".join(parts[:depth])
                if parent not in seen:
                    output.extend((f"[{parent}]", ""))
                    seen.add(parent)
            seen.add(key[1])
        value = re.fullmatch(r'("(?:Script|FileSysPath)"="C:)(.*)(")', line)
        if value:
            # A .reg quoted string needs two backslashes for each path separator.
            # Normalize existing pairs too, so running this repair twice is safe.
            escaped = re.sub(r"\\+", lambda _: "\\\\", value[2])
            line = value[1] + escaped + value[3]
        output.append(line)
    payload = "\n".join(output) + "\n"
    updated = source[:match.start(2)] + payload + source[match.end(2):]
    if updated == source:
        print("Windows startup registry block is already repaired.")
        return
    backup = script.with_name(script.name + ".bot-tele-gpo.bak")
    if not backup.exists():
        shutil.copy2(script, backup)
    script.write_bytes(updated.encode("utf-8"))
    print(f"Windows startup registry block repaired. Backup: {backup}")
    print("The installer has not been run or rebooted.")


if __name__ == "__main__":
    try:
        repair(Path(sys.argv[1] if len(sys.argv) > 1 else "/trans.sh"))
    except (OSError, UnicodeError, ValueError) as error:
        sys.exit(str(error))
