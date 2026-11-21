#!/usr/bin/env python3
"""
Example AI agent for the Open Questions platform, powered by Claude.

It polls the platform for notifications addressed to the agent (@mentions,
replies to its comments, being added to a conversation), reads the
conversation or comment thread, and answers. Files that are @mentioned are
sent to Claude as PDFs. Everything the agent writes is labelled as AI on the platform.

Setup:
    pip install anthropic requests
    export OQ_URL=https://research.example.org      # platform URL
    export OQ_TOKEN=oq_...                           # agent token (People → AI agents)
    export ANTHROPIC_API_KEY=sk-ant-...              # or `ant auth login`

Run:
    python claude_agent.py              # poll forever
    python claude_agent.py --once       # handle pending notifications once, then exit
    python claude_agent.py --dry-run    # print the prompts instead of calling Claude / posting
"""
import argparse
import base64
import os
import re
import sys
import time

import requests

MODEL = "claude-opus-5-5"
POLL_SECONDS = 60
MAX_PDFS = 3            # PDFs attached per answer (mentioned files)
MAX_PDF_BYTES = 20_000_000

SYSTEM_PROMPT = """You are an AI research collaborator in a small group of mathematicians working on one open question. \
You take part in their conversations and comment threads through a collaborative platform.

How to work:
- Be mathematically rigorous. Separate what you have proved from what you conjecture or only checked on examples, \
and say so explicitly. If an argument has a gap, point to the exact step.
- Prefer concrete, checkable contributions: a lemma with proof, a counterexample, a computation, a precise reference \
to the bibliography.
- Be concise: this is a discussion, not a paper. If a long derivation is needed, give the key steps and offer to write \
it up as a separate file.
- Never invent references. Cite only entries of the project bibliography, or say that a reference is needed.

Formatting (plain text, rendered by the platform):
- Write LaTeX between $...$ (inline) or $$...$$ (display).
- Separate paragraphs with a blank line; **bold**, *italic* and `code` are supported.
- Mention people, files, facts and references with exactly these tokens: @{user:ID}, @{document:ID}, @{fact:LABEL}, @{bib:CITEKEY} \
(the IDs are listed in the project context). Mention a person only when you need their attention.
- Reply with the message text only, without a greeting header or signature."""


class Platform:
    """Minimal client for the Open Questions agent API."""

    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.s = requests.Session()
        self.s.headers["Authorization"] = f"Bearer {token}"
        # Some hosts strip the Authorization header; the platform also accepts X-Api-Key.
        self.s.headers["X-Api-Key"] = token

    def get(self, path, **params):
        r = self.s.get(f"{self.url}/{path}", params=params, timeout=60)
        r.raise_for_status()
        return r.json()

    def post(self, path, payload):
        r = self.s.post(f"{self.url}/{path}", json=payload, timeout=60)
        r.raise_for_status()
        return r.json()

    def file_bytes(self, file_id: int) -> bytes:
        r = self.s.get(f"{self.url}/api/files/{file_id}", timeout=120)
        r.raise_for_status()
        return r.content


def project_context(ctx: dict) -> str:
    """Stable description of the project (question, people, files, bibliography)."""
    p = ctx["project"]
    lines = [f"# Project: {p['title']} (status: {p['status']})", "", "## Open question", p["question_text"], "", "## Members"]
    for m in ctx["members"]:
        kind = "AI agent" if m["kind"] == "agent" else m["role"]
        lines.append(f"- @{{user:{m['id']}}} {m['name']} ({kind})")
    lines += ["", "## Files (origin = who wrote it)"]
    for d in ctx["documents"]:
        model = f", {d['ai_model']}" if d.get("ai_model") else ""
        lines.append(f"- @{{document:{d['id']}}} \"{d['title']}\" v{d['current_version_no']} [{d['origin']}{model}]")
    lines += ["", "## Fact database (status = review state; do not rely on disputed or retracted facts)"]
    for f in ctx.get("facts", []):
        model = f", {f['ai_model']}" if f.get("ai_model") else ""
        lines.append(f"- @{{fact:{f['label']}}} {f['kind']} {f['labels']} [{f['status']}, proof: {f['proof_origin']}{model}, lean: {f['lean']}]: {f['statement_text']}")
    lines += ["", "## Bibliography"]
    for b in ctx["bibliography"]:
        lines.append(f"- @{{bib:{b['cite_key']}}} {b['authors']} ({b['year'] or 'n.d.'}). {b['title']}. {b['venue'] or ''}")
    return "\n".join(lines)


def conversation_transcript(conv: dict, my_id: int) -> str:
    out = [f"# Conversation: {conv['subject']}",
           "Participants: " + ", ".join(f"{p['name']} (@{{user:{p['id']}}})" for p in conv["participants"]), ""]
    for m in conv["messages"]:
        who = "you" if m["author_id"] == my_id else m["author_name"] + (" [AI]" if m["author_kind"] == "agent" else "")
        out.append(f"--- {who}, {m['created_at']} UTC ---\n{m['body_text']}\n")
    return "\n".join(out)


def thread_transcript(thread: dict, my_id: int, target: str) -> str:
    out = [f"# Comment thread on {target}"]
    a = thread.get("anchor") or {}
    if a.get("quote"):
        out.append(f"Anchored on the passage (page {a.get('page', '?')}): \"{a['quote']}\"")
    for c in [thread] + thread["replies"]:
        who = "you" if c["author_id"] == my_id else c["author_name"]
        out.append(f"--- {who}, {c['created_at']} UTC ---\n{c['body_text']}\n")
    return "\n".join(out)


def pdf_blocks(platform: Platform, ctx: dict, text: str) -> list:
    """PDFs of the files @mentioned in the discussion, as Claude document blocks."""
    docs = {d["id"]: d for d in ctx["documents"]}
    blocks = []
    for doc_id in dict.fromkeys(int(x) for x in re.findall(r"@\{document:(\d+)\}", text)):
        d = docs.get(doc_id)
        if not d or not d.get("pdf_file_id") or len(blocks) >= MAX_PDFS:
            continue
        data = platform.file_bytes(d["pdf_file_id"])
        if len(data) > MAX_PDF_BYTES:
            continue
        blocks.append({
            "type": "document",
            "title": f"document:{doc_id} — {d['title']} (v{d['current_version_no']}, {d['origin']})",
            "source": {"type": "base64", "media_type": "application/pdf", "data": base64.standard_b64encode(data).decode()},
        })
    return blocks


def ask_claude(client, context_text: str, discussion: str, pdfs: list, task: str):
    """Returns (reply, model that answered, seconds spent), or (None, None, None) if Claude declined."""
    content = pdfs + [{"type": "text", "text": f"{discussion}\n\n{task}"}]
    started = time.monotonic()
    # Streaming avoids HTTP timeouts on long, high-effort answers.
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=32000,
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        # On a policy decline, the API retries on a fallback model chosen by refusal category.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        # The project context changes rarely: cache it.
        system=[
            {"type": "text", "text": SYSTEM_PROMPT},
            {"type": "text", "text": context_text, "cache_control": {"type": "ephemeral"}},
        ],
        messages=[{"role": "user", "content": content}],
    ) as stream:
        msg = stream.get_final_message()
    seconds = round(time.monotonic() - started, 3)
    if msg.stop_reason == "refusal":
        return None, None, None
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    if msg.stop_reason == "max_tokens":
        text += "\n\n*(answer truncated)*"
    # With fallbacks the answering model can differ from MODEL: record the real one.
    return (text, msg.model, seconds) if text else (None, None, None)


def handle(platform: Platform, client, ctx: dict, notif: dict, dry_run: bool) -> None:
    me = ctx["agent"]["id"]
    link = (notif.get("payload") or {}).get("link") or {}
    view, target_id, comment_id = link.get("view"), link.get("id"), link.get("comment")
    context_text = project_context(ctx)

    if comment_id:  # a comment thread on a conversation, file or bibliography entry
        ttype = {"conversations": "conversation", "files": "document", "bib": "bib", "facts": "fact"}[view]
        threads = platform.get("api/comments", type=ttype, id=target_id)["threads"]
        thread = next((t for t in threads if t["id"] == comment_id), None)
        if not thread:
            return
        target = f"{ttype} {target_id}"
        if ttype == "document":
            target = f"@{{document:{target_id}}}"
        discussion = thread_transcript(thread, me, target)
        if ttype == "fact":
            f = platform.get(f"api/facts/{target_id}")
            discussion = (f"# Fact {f['label']} ({f['kind']}, status: {f['status']})\n## Statement\n{f['statement_text']}\n"
                          f"## Proof\n{f['proof_text']}\n## Intuition\n{f['intuition_text']}\n\n{discussion}")
        task = "Write your reply to this comment thread."
        mention_text = discussion + (f" @{{document:{target_id}}}" if ttype == "document" else "")
        post = lambda body, model, seconds: platform.post("api/comments", {
            "target_type": ttype, "target_id": target_id, "parent_id": thread["id"], "body_text": body,
            "ai_model": model, "generation_seconds": seconds})
    elif view == "conversations" and target_id:
        conv = platform.get(f"api/conversations/{target_id}")
        if conv["messages"] and conv["messages"][-1]["author_id"] == me:
            return  # already answered
        discussion = conversation_transcript(conv, me)
        task = "Write your next message in this conversation, answering what was asked of you."
        mention_text = discussion
        post = lambda body, model, seconds: platform.post(f"api/conversations/{target_id}/messages", {
            "body_text": body, "ai_model": model, "generation_seconds": seconds})
    else:
        return

    pdfs = pdf_blocks(platform, ctx, mention_text)
    if dry_run:
        print(f"\n===== notification {notif['id']} ({notif['kind']}) — {len(pdfs)} PDF(s) =====\n{discussion}\n[{task}]")
        return
    reply, model, seconds = ask_claude(client, context_text, discussion, pdfs, task)
    if reply:
        post(reply, model, seconds)
        print(f"answered notification {notif['id']} ({view} {target_id})")
    else:
        print(f"declined to answer notification {notif['id']}", file=sys.stderr)


def run_once(platform: Platform, client, dry_run: bool) -> None:
    ctx = platform.get("api/agent/context")
    for notif in ctx["unread_notifications"]:
        try:
            handle(platform, client, ctx, notif, dry_run)
        except Exception as e:  # keep going with the other notifications
            print(f"notification {notif['id']}: {e}", file=sys.stderr)
            continue
        if not dry_run:
            platform.post("api/notifications/read", {"ids": [notif["id"]]})


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true", help="process pending notifications and exit")
    ap.add_argument("--dry-run", action="store_true", help="print prompts, do not call Claude or post")
    args = ap.parse_args()

    platform = Platform(os.environ["OQ_URL"], os.environ["OQ_TOKEN"])
    client = None
    if not args.dry_run:
        import anthropic
        client = anthropic.Anthropic()

    while True:
        run_once(platform, client, args.dry_run)
        if args.once or args.dry_run:
            break
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
