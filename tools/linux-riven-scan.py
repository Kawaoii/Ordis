#!/usr/bin/env python3
"""
Scan a running Warframe client for riven summaries, the way riven-memory.ps1 does on
Windows. Read-only: opens nothing, injects nothing, writes nothing to the game.

WHY THIS IS A SEPARATE IMPLEMENTATION
-------------------------------------
Windows has ReadProcessMemory. Linux has process_vm_readv, and it is gated by
kernel.yama.ptrace_scope, which most distributions set to 1 (restricted). Under
ptrace_scope=1 a process may only read the memory of its own children, so this will
fail with EPERM until that is relaxed. See the instructions, not the code.

SELF-CONTAINED ON PURPOSE
-------------------------
This is meant to be run from a bootable drive with nothing installed: standard library
and ctypes only, no pip, no compiler. Python 3 ships on CachyOS.

    python3 linux-riven-scan.py            # human readable
    python3 linux-riven-scan.py --json out.json
"""

import ctypes
import ctypes.util
import errno
import json
import os
import re
import sys

# ---------------------------------------------------------------------------
# Process discovery
# ---------------------------------------------------------------------------

# Under Proton the game is an ordinary Linux process, so it shows up in /proc like
# anything else. Match on the binary name rather than assuming, because the comm field
# is truncated to 15 characters and "Warframe.x64" is 13 but the full path is longer.
CANDIDATES = ("warframe.x64", "warframe", "warframe.bin")


def find_pid():
    me = os.getpid()
    hits = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid == me:
            continue
        try:
            with open("/proc/%d/comm" % pid, "r", errors="replace") as fh:
                comm = fh.read().strip().lower()
        except (IOError, OSError):
            continue
        if comm in CANDIDATES:
            hits.append((pid, comm))
        else:
            # comm truncates, so also check the exe name for anything warframe-ish.
            try:
                exe = os.path.basename(os.readlink("/proc/%d/exe" % pid)).lower()
            except (IOError, OSError):
                continue
            if exe in CANDIDATES:
                hits.append((pid, exe))
    return hits


# ---------------------------------------------------------------------------
# Memory reading
# ---------------------------------------------------------------------------

libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)

# struct iovec from <sys/uio.h>
class IOVec(ctypes.Structure):
    _fields_ = [("iov_base", ctypes.c_void_p),
                ("iov_len", ctypes.c_size_t)]


def process_vm_readv(pid, addr, length):
    """Read `length` bytes at `addr`. Returns bytes, or None on failure."""
    local = ctypes.create_string_buffer(length)
    local_iov = IOVec(ctypes.cast(local, ctypes.c_void_p), length)
    remote_iov = IOVec(ctypes.c_void_p(addr), length)
    n = libc.process_vm_readv(
        ctypes.c_int(pid),
        ctypes.byref(local_iov), ctypes.c_ulong(1),
        ctypes.byref(remote_iov), ctypes.c_ulong(1),
        ctypes.c_ulong(0),
    )
    if n != length:
        return None
    return local.raw


def readable_regions(pid):
    """Yield (start, end) for readable, committed, private or shared mappings."""
    out = []
    with open("/proc/%d/maps" % pid, "r", errors="replace") as fh:
        for line in fh:
            parts = line.split()
            if len(parts) < 2:
                continue
            perms = parts[1]
            if "r" not in perms:
                continue
            # Skip the file-backed code and data of the loader and the driver: it is
            # large, it is mapped read-only from disk, and it holds no player state.
            if len(parts) >= 6 and parts[5].startswith("/"):
                continue
            bounds = parts[0].split("-")
            try:
                start = int(bounds[0], 16)
                end = int(bounds[1], 16)
            except ValueError:
                continue
            if end > start:
                out.append((start, end))
    return out


# ---------------------------------------------------------------------------
# Riven extraction
# ---------------------------------------------------------------------------

# Each riven summary is one NUL-terminated lowercase string ending in the mastery rank
# and the weapon class, e.g. "... bows) mr 10 shotgun". See the notes in
# docs/FEATURE-NOTES.md.
TRAILER = re.compile(rb"mr\s{0,3}(\d{1,2})\s{1,4}([a-z]{3,14})", re.I)
STAT = re.compile(rb"[+\-]\d{1,4}(\.\d{1,2})?%")
MULT = re.compile(rb"\bx\d\.\d{1,3}\b", re.I)
MAX_STRING = 2048

# The stored summaries carry UTF-8 debris in front of a stat name, e.g. the bytes for
# "e-acute" before "electricity", which reads as "+84.1% e-electricity".
DEBRIS = bytes([0x80, 0x81, 0x8d, 0x9d, 0xe9])


def clean(raw):
    if not any(b in raw for b in DEBRIS):
        return raw.decode("latin-1")
    kept = bytes(b for b in raw if b < 0x80)
    return re.sub(rb"\s{2,}", b" ", kept).decode("latin-1")


def extract(window):
    """Trim a window down to just the riven block."""
    text = clean(window)
    lines = re.split(r"\r\n|\n|\r", text)
    kept = []
    started = False
    for raw in lines:
        line = raw.strip()
        if not line:
            if started:
                break
            continue
        looks_stat = STAT.search(line) or MULT.search(line)
        if not started and looks_stat:
            started = True
            # The name shares the first stat's line, so split it back off.
            m = re.match(r"^(?P<name>.*?)\s*(?=[+\-]\d|\bx\d\.)", line, re.I)
            if m and m.group("name").strip():
                kept.append(m.group("name").strip())
                rest = line[m.end():].strip()
                if rest:
                    kept.append(rest)
            else:
                kept.append(line)
            continue
        if started:
            kept.append(line)
    return "\n".join(kept).strip()


def normalise(block):
    return re.sub(r"\s+", " ", block.lower()).strip()


def scan(pid, limit_bytes=0):
    found = []
    seen = set()
    scanned = 0
    for start, end in readable_regions(pid):
        if limit_bytes and scanned >= limit_bytes:
            break
        pos = start
        carry = b""
        while pos < end:
            want = min(4 * 1024 * 1024, end - pos)
            at = max(start, pos - len(carry))
            buf = process_vm_readv(pid, at, min(want + (pos - at), end - at))
            if not buf:
                pos += want
                carry = b""
                continue
            for m in TRAILER.finditer(buf):
                t_start = max(0, m.start() - MAX_STRING)
                # Exact string start: the byte after the previous NUL.
                nul = buf.rfind(b"\x00", t_start, m.start())
                w_start = nul + 1 if nul >= t_start else max(0, m.start() - 700)
                window = buf[w_start:m.end()]
                if len(STAT.findall(window)) < 2 and not MULT.search(window):
                    continue
                block = extract(window)
                if len(block) < 16:
                    continue
                key = normalise(block)
                if key in seen:
                    continue
                seen.add(key)
                found.append({
                    "address": hex(at + w_start),
                    "text": block,
                    "stats": len(STAT.findall(window)),
                })
            carry = buf[-MAX_STRING:] if len(buf) >= MAX_STRING else buf
            pos += want
            scanned += want
    return found, scanned


# ---------------------------------------------------------------------------

def main():
    as_json = False
    out_path = None
    args = sys.argv[1:]
    if "--json" in args:
        as_json = True
        i = args.index("--json")
        out_path = args[i + 1] if len(args) > i + 1 else None

    ptrace = open("/proc/sys/kernel/yama/ptrace_scope").read().strip() \
        if os.path.exists("/proc/sys/kernel/yama/ptrace_scope") else "n/a"

    hits = find_pid()
    if not hits:
        msg = "Warframe is not running. Start it and log in, then run this again."
        print(msg, file=sys.stderr)
        if as_json:
            print(json.dumps({"error": msg, "ptrace_scope": ptrace}))
        return 1

    # Prefer the biggest match, which is the real game rather than a launcher.
    pid = hits[0][0]
    results = []
    for p, name in hits:
        try:
            got, _ = scan(p)
        except Exception as exc:                      # noqa: BLE001
            results.append({"pid": p, "error": str(exc)})
            continue
        results.append({"pid": p, "name": name, "rivens": got, "count": len(got)})
        if len(got) > len(results[-1].get("rivens", [])) - 1 and got:
            pid = p

    best = max(results, key=lambda r: r.get("count", 0), default=None)
    payload = {"ptrace_scope": ptrace, "results": results}

    if as_json:
        text = json.dumps(payload, indent=2)
        if out_path:
            with open(out_path, "w") as fh:
                fh.write(text)
            print("wrote " + out_path, file=sys.stderr)
        else:
            print(text)
        return 0

    print("ptrace_scope        : %s" % ptrace)
    if ptrace not in ("0", "n/a"):
        print("  ^ if this is 1 or higher, reading another process's memory is blocked.")
        print("    Fix for one session:  sudo sysctl kernel.yama.ptrace_scope=0")
        print("    To make it stick:     echo 'kernel.yama.ptrace_scope = 0' | "
              "sudo tee /etc/sysctl.d/99-ptrace.conf")
    print("processes matched   : %d" % len(hits))
    for r in results:
        if r.get("error"):
            print("  pid %-7d ERROR %s" % (r["pid"], r["error"]))
        else:
            print("  pid %-7d %-16s %d riven block(s)" % (r["pid"], r.get("name", ""), r["count"]))

    if not best or not best.get("count"):
        print("\nNo riven blocks found.")
        print("That is only meaningful if the riven screen has been opened this session:")
        print("the summaries are built when a riven is equipped or viewed, not at login.")
        return 2

    print("\n%d distinct riven(s):\n" % best["count"])
    for r in best["rivens"]:
        print("--- %s  (%d stats)" % (r["address"], r["stats"]))
        for line in r["text"].split("\n"):
            print("    " + line)
        print("")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
