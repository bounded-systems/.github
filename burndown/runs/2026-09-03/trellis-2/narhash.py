#!/usr/bin/env python3
"""Compute a Nix NAR sha256 (SRI) of a directory tree, skipping .git — reproduces
the flake.lock `narHash` of a github: input. Validated against existing lock entries."""
import sys, os, hashlib, base64, struct

def pad(b: bytes) -> bytes:
    return b + b"\0" * ((8 - len(b) % 8) % 8)

def s(x) -> bytes:
    if isinstance(x, str): x = x.encode()
    return struct.pack("<Q", len(x)) + pad(x)

def node(path: str) -> bytes:
    out = [s("(")]
    st = os.lstat(path)
    if os.path.islink(path):
        out += [s("type"), s("symlink"), s("target"), s(os.readlink(path))]
    elif os.path.isdir(path):
        out += [s("type"), s("directory")]
        for name in sorted(os.listdir(path)):
            if name == ".git": continue
            out += [s("entry"), s("("), s("name"), s(name), s("node"), node(os.path.join(path, name)), s(")")]
    else:
        out += [s("type"), s("regular")]
        if st.st_mode & 0o111: out += [s("executable"), s("")]
        with open(path, "rb") as f: data = f.read()
        out += [s("contents"), s(data)]
    out.append(s(")"))
    return b"".join(out)

def narhash(path: str) -> str:
    nar = s("nix-archive-1") + node(path)
    return "sha256-" + base64.b64encode(hashlib.sha256(nar).digest()).decode()

if __name__ == "__main__":
    for p in sys.argv[1:]: print(narhash(p))
