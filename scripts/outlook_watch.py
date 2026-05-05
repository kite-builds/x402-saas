#!/usr/bin/env python3
"""outlook_watch.py — poll the open outlook.live.com tab via CDP and Telegram new mail.

Microsoft has disabled IMAP basic-auth on personal outlook accounts and
the modern-auth OAuth flow is heavyweight. The OpenClaw browser already
has a logged-in session, so we drive that via Chrome DevTools Protocol
and read the inbox DOM. Fragile to UI changes, fine for now.

Usage:
    python3 outlook_watch.py [--debug]

State (last-seen message IDs) lives at .outlook_state.json next to the
script's parent dir so we don't re-spam the same mail.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib import parse, request

# Re-use the CDP helpers + Telegram POST from the outreach watcher
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from _cdp_lib import CDPClient, pick_page  # noqa: E402
from outreach_watch import _telegram_post  # noqa: E402

JOB_NAME = "outlook-watch"
STATE_PATH = HERE.parent / ".outlook_state.json"
DEBUG_DUMP = Path("/tmp/outlook_watch_debug.json")


# JS snippet runs inside the outlook tab. Returns a JSON string with
# {selector, items: [{id, sender, subject, time, snippet, unread}, ...]}.
EXTRACT_JS = r"""
(function() {
  const rows = document.querySelectorAll('div[role="option"]');
  const items = [];
  rows.forEach(row => {
    const aria = row.getAttribute('aria-label') || '';
    const text = (row.innerText || '').replace(/\s+/g, ' ').trim();
    // Stable-ish id: data-convid, data-itemid, or first 40 chars of aria-label hash
    let id = row.getAttribute('data-convid')
          || row.getAttribute('data-itemid')
          || row.id
          || '';
    if (!id) {
      // Fallback: aria + first child id
      const child = row.querySelector('[id]');
      id = (child ? child.id : '') + '|' + aria.slice(0, 60);
    }
    // Unread heuristic — outlook bolds unread; check font-weight
    const heading = row.querySelector('[role="heading"], h3, h2');
    const unread = row.matches('[aria-label*="Ulest"], [aria-label*="Unread"]')
                || (row.querySelector('[class*="unread" i], [class*="Unread"]') !== null)
                || (heading && getComputedStyle(heading).fontWeight >= '600');
    items.push({
      id: id.slice(0, 200),
      aria: aria.slice(0, 500),
      text: text.slice(0, 500),
      unread: !!unread,
    });
  });
  return JSON.stringify({rowCount: rows.length, items: items, ts: Date.now()});
})();
"""


def _load_state() -> dict:
    if not STATE_PATH.exists():
        return {"seen_ids": []}
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"seen_ids": []}


def _save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def _format_item(item: dict) -> str:
    aria = item.get("aria", "")
    # Aria typically looks like:
    # "<Sender> <Subject> <DateTimeShortcut> <BodyPreview>"
    # Truncate aggressively for Telegram readability.
    short = " ".join(aria.split())
    if len(short) > 240:
        short = short[:239] + "…"
    flag = "🆕" if item.get("unread") else "📧"
    return f"{flag} {short}"


FOLDERS = [
    ("inbox", "https://outlook.live.com/mail/0/inbox"),
    ("junkemail", "https://outlook.live.com/mail/0/junkemail"),
]


def _navigate_and_extract(folder_url: str) -> dict:
    """Drive the browser to a folder URL and return {rowCount, items}.
    Reuses the first available CDP page; OK to navigate it freely between
    folders since outlook keeps the session cookie."""
    from _cdp_lib import list_pages
    import time as _t
    pages = list_pages()
    if not pages:
        return {"error": "no CDP pages"}
    target = pages[0]
    cli = CDPClient(target["webSocketDebuggerUrl"])
    try:
        cli.call("Page.navigate", {"url": folder_url})
        for _ in range(50):
            _t.sleep(0.5)
            try:
                state = cli.evaluate("document.readyState")
                title = cli.evaluate("document.title") or ""
                if state == "complete" and "moment" not in title.lower():
                    break
            except Exception:
                break
        _t.sleep(2.0)
        raw = cli.evaluate(EXTRACT_JS)
    finally:
        cli.close()
    try:
        return json.loads(raw or "{}")
    except Exception:
        return {"error": "json parse"}


def main() -> int:
    debug = "--debug" in sys.argv

    state = _load_state()
    seen: set[str] = set(state.get("seen_ids", []))
    fresh: list[dict] = []
    all_items: list[dict] = []

    # Walk both Inbox and Junk — junk-folder catches new senders Outlook hasn't trusted yet
    # (e.g., the lablab.ai approval landed in junk on 2026-05-05).
    for folder_name, folder_url in FOLDERS:
        try:
            payload = _navigate_and_extract(folder_url)
        except Exception as exc:
            if debug:
                print(f"folder {folder_name} skipped: {exc}")
            continue
        if not isinstance(payload, dict):
            continue
        for it in payload.get("items", []):
            it["_folder"] = folder_name
            all_items.append(it)

    if debug:
        DEBUG_DUMP.write_text(json.dumps(all_items, indent=2, ensure_ascii=False))
        print(f"debug dump: {DEBUG_DUMP}")

    if not all_items:
        print("NO_REPLY (no rows extracted from any folder)")
        return 0

    for it in all_items:
        iid = it.get("id") or ""
        if iid and iid not in seen:
            fresh.append(it)
            seen.add(iid)

    state["seen_ids"] = sorted(seen)[-500:]
    _save_state(state)

    if not fresh:
        print("NO_REPLY")
        return 0

    header = f"📬 Outlook — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}: {len(fresh)} new"
    body = "\n\n".join(_format_item(x) for x in fresh[:8])
    if len(fresh) > 8:
        body += f"\n\n…and {len(fresh) - 8} more (truncated)"
    msg = f"{header}\n\n{body}"

    if not _telegram_post(msg):
        print(msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
