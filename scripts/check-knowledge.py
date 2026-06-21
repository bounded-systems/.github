#!/usr/bin/env python3
"""Self-consistency checks for the knowledge graph.

The canonical frontmatter contract lives in knowledge/note.schema.json; this
script reads that schema and enforces it, plus a small set of graph invariants,
then exits non-zero on any violation. Stdlib only — no install step in CI.

Supported frontmatter grammar (a deliberately small YAML subset):

    key: scalar
    key: [a, b, c]
    key:
      - item
      - item
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KNOWLEDGE = ROOT / "knowledge"
SCHEMA = KNOWLEDGE / "note.schema.json"
WIKILINK = re.compile(r"\[\[([^\]]+)\]\]")
KEY_LINE = re.compile(r"([A-Za-z0-9_]+):\s*(.*)$")


def _scalar(s: str):
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return s[1:-1]
    return s


def parse_frontmatter(text: str, rel: str, errors: list[str]):
    """Return (frontmatter_dict, body) or (None, text) on failure."""
    if not text.startswith("---\n"):
        errors.append(f"{rel}: missing frontmatter (file must start with '---')")
        return None, text
    end = text.find("\n---", 4)
    if end == -1:
        errors.append(f"{rel}: unterminated frontmatter block")
        return None, text
    block, body = text[4:end], text[end + 4:]
    data: dict = {}
    key = None
    for raw in block.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if raw.startswith(("  - ", "- ")):
            if key is None:
                errors.append(f"{rel}: list item with no key: {raw!r}")
                continue
            data.setdefault(key, [])
            if not isinstance(data[key], list):
                data[key] = []
            data[key].append(_scalar(raw.split("-", 1)[1].strip()))
            continue
        m = KEY_LINE.match(raw)
        if not m:
            errors.append(f"{rel}: cannot parse frontmatter line: {raw!r}")
            continue
        key, val = m.group(1), m.group(2).strip()
        if val == "":
            data[key] = []
        elif val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            data[key] = [_scalar(x.strip()) for x in inner.split(",")] if inner else []
        else:
            data[key] = _scalar(val)
    return data, body


def validate_schema(data: dict, schema: dict, rel: str, errors: list[str]):
    for field in schema.get("required", []):
        if field not in data:
            errors.append(f"{rel}: missing required field '{field}'")
    for field, spec in schema.get("properties", {}).items():
        if field not in data:
            continue
        val = data[field]
        if spec.get("type") == "array" and not isinstance(val, list):
            errors.append(f"{rel}: field '{field}' must be a list")
        if spec.get("type") == "string" and isinstance(val, list):
            errors.append(f"{rel}: field '{field}' must be a string, not a list")
        if "enum" in spec and val not in spec["enum"]:
            errors.append(f"{rel}: field '{field}'={val!r} not in {spec['enum']}")
        if "pattern" in spec and isinstance(val, str) and not re.match(spec["pattern"], val):
            errors.append(f"{rel}: field '{field}'={val!r} fails pattern {spec['pattern']!r}")
        if spec.get("minItems") and isinstance(val, list) and len(val) < spec["minItems"]:
            errors.append(f"{rel}: field '{field}' needs >= {spec['minItems']} item(s)")


def main() -> int:
    errors: list[str] = []
    if not KNOWLEDGE.is_dir():
        print(f"knowledge-check: no knowledge/ directory at {KNOWLEDGE}", file=sys.stderr)
        return 1
    try:
        schema = json.loads(SCHEMA.read_text())
    except Exception as exc:  # noqa: BLE001
        print(f"knowledge-check: cannot load {SCHEMA}: {exc}", file=sys.stderr)
        return 1

    notes: dict[str, dict] = {}
    bodies: dict[str, tuple[str, str]] = {}
    ids: dict[str, str] = {}

    for path in sorted(KNOWLEDGE.rglob("*.md")):
        if path.name == "README.md":
            continue
        rel = path.relative_to(ROOT).as_posix()
        data, body = parse_frontmatter(path.read_text(), rel, errors)
        if data is None:
            continue
        notes[path.stem] = data
        bodies[path.stem] = (rel, body)
        validate_schema(data, schema, rel, errors)

        nid = data.get("id")
        if isinstance(nid, str):
            if nid in ids:
                errors.append(f"{rel}: duplicate id '{nid}' (also in {ids[nid]})")
            else:
                ids[nid] = rel
            if nid != path.stem:
                errors.append(f"{rel}: id '{nid}' must equal filename stem '{path.stem}'")

        if data.get("status") == "Aspirational" and not data.get("tracking"):
            errors.append(f"{rel}: status Aspirational requires a 'tracking' reference")

        srcs = data.get("sources")
        if isinstance(srcs, list):
            for src in srcs:
                if isinstance(src, str) and not src.startswith(("http://", "https://")):
                    if not (ROOT / src.split("#", 1)[0]).exists():
                        errors.append(f"{rel}: source path '{src}' does not exist")

    stems = set(notes)
    for stem, (rel, body) in bodies.items():
        for raw in WIKILINK.findall(body):
            target = raw.split("|", 1)[0].split("#", 1)[0].strip()
            if target not in stems:
                errors.append(f"{rel}: wikilink [[{raw}]] -> '{target}' has no matching note")

    if errors:
        print(f"knowledge-check: {len(errors)} problem(s):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print(f"knowledge-check: OK ({len(notes)} node(s), {len(ids)} id(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
