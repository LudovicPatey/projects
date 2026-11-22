#!/usr/bin/env python3
"""
Imports a Danus fact graph into an Open Questions project.

Reads <fact_graph>/facts/*.md (YAML frontmatter, then "## statement", "## proof",
optional "## intuition") and sends the facts in dependency order. Facts already
imported are skipped. Revoked facts (in _revoked/) are not read. Labels come from the
Danus memory (<project>/global_memory/<kind>.jsonl, entries with a fact_id), and
default to "conclusion".

Setup:
    pip install requests pyyaml
    export OQ_URL=https://research.example.org
    export OQ_KEY=ouk_...      # personal key from your profile page

Run:
    python import_danus.py path/to/fact_graph --project 1 --model MODEL --dry-run
    python import_danus.py path/to/fact_graph --project 1 --model MODEL
"""
import argparse
import json
import os
import pathlib
import re
import sys

import requests
import yaml

BATCH = 400
LABELS = {"conclusion", "example", "counterexample", "proof_attempt", "plan", "dead_end",
          "direction", "obstacle", "master_guidance", "verification", "elaboration"}


def parse_fact(path: pathlib.Path) -> dict:
    m = re.match(r"\A---\s*\n(.*?)\n---\s*\n(.*)\Z", path.read_text(encoding="utf-8"), re.S)
    if not m:
        raise ValueError(f"{path.name}: no YAML frontmatter")
    meta = yaml.safe_load(m.group(1)) or {}
    parts = re.split(r"^##[ \t]+(statement|proof|intuition)[ \t]*$", m.group(2), flags=re.M | re.I)
    sections = {parts[i].lower(): parts[i + 1].strip() for i in range(1, len(parts) - 1, 2)}
    if not sections.get("statement"):
        raise ValueError(f"{path.name}: no statement section")
    return {
        "fact_id": str(meta.get("fact_id") or path.stem),
        "predecessors": [str(p) for p in meta.get("predecessors") or []],
        "glossary_introduces": meta.get("glossary_introduces") or None,
        "external_refs": meta.get("external_refs") or None,
        "statement": sections["statement"],
        "proof": sections.get("proof", ""),
        "intuition": sections.get("intuition", ""),
    }


def memory_labels(fact_graph: pathlib.Path) -> dict:
    """{fact_id: labels} from the Danus global memory, next to the fact graph."""
    labels = {}
    memory = fact_graph.parent / "global_memory"
    # A finding is linked to its fact in the status log. "verification" is only the trace of the check, present for every fact.
    promoted = {}
    status_log = memory / "_status.jsonl"
    if status_log.exists():
        for line in status_log.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict) and rec.get("id") and rec.get("fact_id"):
                promoted[rec["id"]] = rec["fact_id"]
    for path in memory.glob("*.jsonl"):
        if path.stem not in LABELS or path.stem == "verification":
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            fact = entry.get("fact_id") or promoted.get(entry.get("id")) if isinstance(entry, dict) else None
            if fact:
                labels.setdefault(str(fact), set()).add(path.stem)
    return labels


def in_order(facts: list) -> list:
    """Topological order, so that each batch only refers to earlier facts."""
    by_id = {f["fact_id"]: f for f in facts}
    left = {i: sum(p in by_id for p in f["predecessors"]) for i, f in by_id.items()}
    users = {}
    for i, f in by_id.items():
        for p in f["predecessors"]:
            if p in by_id:
                users.setdefault(p, []).append(i)
    queue = [i for i, n in left.items() if n == 0]
    for i in queue:
        for u in users.get(i, []):
            left[u] -= 1
            if left[u] == 0:
                queue.append(u)
    if len(queue) != len(by_id):
        raise ValueError("the fact graph contains a cycle")
    return [by_id[i] for i in queue]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("fact_graph", type=pathlib.Path)
    ap.add_argument("--project", type=int, required=True)
    ap.add_argument("--model", required=True, help="AI model that produced these facts")
    ap.add_argument("--dry-run", action="store_true", help="validate on the server, save nothing")
    args = ap.parse_args()

    files = sorted((args.fact_graph / "facts").glob("*.md"))
    if not files:
        print(f"No facts in {args.fact_graph / 'facts'}", file=sys.stderr)
        return 1
    facts = in_order([parse_fact(p) for p in files])
    labels = memory_labels(args.fact_graph)
    for f in facts:
        f["labels"] = sorted(labels.get(f["fact_id"], {"conclusion"}))
    url = os.environ["OQ_URL"].rstrip("/") + f"/api/projects/{args.project}/facts/batch"
    headers = {"Authorization": f"Bearer {os.environ['OQ_KEY']}"}

    if args.dry_run and len(facts) > BATCH:
        print(f"Note: a dry run validates the first {BATCH} facts only, since later batches rely on saved facts.")
        facts = facts[:BATCH]
    created = skipped = 0
    for start in range(0, len(facts), BATCH):
        body = {"format": "danus", "ai_model": args.model, "dry_run": args.dry_run, "facts": facts[start:start + BATCH]}
        r = requests.post(url, json=body, headers=headers, timeout=300)
        data = r.json()
        if not r.ok:
            print(f"Rejected: {data.get('error')}", file=sys.stderr)
            for e in data.get("errors", [])[:20]:
                print(f"  {e['ref']}: {e['error']}", file=sys.stderr)
            print(f"Saved before this batch: {created}", file=sys.stderr)
            return 1
        created += len(data["created"])
        skipped += len(data["skipped"])
    print(f"{'Would create' if args.dry_run else 'Created'} {created} facts, skipped {skipped} already present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
