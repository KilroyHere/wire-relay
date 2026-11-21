#!/usr/bin/env bash
# Look at the wire panel the way a person sees it: runs a second Claude Code in a hidden terminal (tmux) with
# this repository's plugin, opens /wire, and lets you read the screen and type into it.
#
# It never touches your real ~/.wire. The viewer gets a throwaway identity and either a sample conversation
# (default) or a copy of one session log you name with --log. Logs hold plain text only, no keys.
#
#   test/panel-view.sh start [COLS] [ROWS] [--log FILE]   start the viewer (default 200x50) and open /wire
#   test/panel-view.sh shot [--panel]                      print the screen, or only the panel's columns
#   test/panel-view.sh type "TEXT"                         type TEXT and press Enter (into whatever has focus)
#   test/panel-view.sh keys KEY...                         send tmux keys, e.g. Tab Enter Escape Up
#   test/panel-view.sh resize COLS ROWS                    change the terminal size
#   test/panel-view.sh stop                                stop the viewer and delete its files
#
# Needs tmux, node, and a Claude Code that is signed in. Claude Code's first-run screens (theme, notes,
# folder trust) are answered for you.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
BASE=${PANEL_VIEW_DIR:-${TMPDIR:-/tmp}/wire-panel-view}
NAME=wire-panel-view
CLIENT="$ROOT/plugin/client/wire.mjs"

screen() { tmux capture-pane -t "$NAME" -p; }
has() { screen | grep -q -- "$1"; }
die() { echo "panel-view: $*" >&2; exit 1; }

sample_log() {
  # A conversation with every kind of row the panel draws: both people, both Claudes, a long message,
  # an unverified contact, a lobby request, and a second conversation (so the panel shows two tabs).
  node -e '
    const now = Date.now(), m = 60000, ref = "sam/general";
    const rows = [
      { at: now - 50*m, kind: "joined", contact: "sam", code: "🦊 🌲 🚀 ⏳ 42", line: "🤝 sam is paired with you but NOT verified yet." },
      { at: now - 48*m, kind: "local", contact: "sam", ref, title: "General", line: "↘ attached" },
      { at: now - 47*m, kind: "msg", contact: "sam", ref, title: "General", from: "human", name: "sam", self: "Samantha", text: "hey, are you around?", line: "📨 sam [human]: hey, are you around?" },
      { at: now - 46*m, kind: "sent", contact: "sam", ref, from: "human", text: "yes, what is up", id: 1, line: "↗ you: yes, what is up" },
      { at: now - 45*m, kind: "msg", contact: "sam", ref, title: "General", from: "agent", name: "sam", text: "Sam asked me to check the API shape with your Claude before they merge. getUser now returns {id, email, role}; the old field name was user_id and the mobile client still reads it, so either we keep both fields for a release or the mobile client ships first. Which does your side prefer, and is there anything else on your side reading user_id that we should know about before Friday?", line: "📨 Claude (sam) [agent]: long" },
      { at: now - 44*m, kind: "sent", contact: "sam", ref, from: "agent", text: "Keep both fields for one release. Nothing else here reads user_id.", id: 2, line: "↗ your Claude: Keep both fields" },
      { at: now - 20*m, kind: "msg", contact: "sam", ref, title: "General", from: "human", via: "claude", name: "sam", text: "thanks!", line: "📨 sam [human]: thanks!" },
      { at: now - 19*m, kind: "acked", contact: "sam", upto: 2, line: "acked" },
      { at: now - 2*m, kind: "sent", contact: "sam", ref, from: "human", text: "shipping it now", id: 3, line: "↗ you: shipping it now" },
      { at: now - 30*m, kind: "local", contact: "sam", ref: "sam/Rk2PqZ8a", title: "release notes", line: "↗ opened" },
      { at: now - 29*m, kind: "msg", contact: "sam", ref: "sam/Rk2PqZ8a", title: "release notes", from: "human", name: "sam", via: "typed", text: "can you draft the release notes?", line: "📨 sam [human]: draft" },
      { at: now - 3*m, kind: "msg", contact: "sam", ref: "sam/Rk2PqZ8a", title: "release notes", from: "agent", name: "sam", text: "Draft is in the note.", line: "📨 Claude (sam) [agent]: draft" },
      { at: now - 1*m, kind: "lobby", contact: "jo", ref: "jo/Q7kPzX2a", title: "deploy", line: "🔔 jo wants to talk" },
    ];
    for (const r of rows) console.log(JSON.stringify(r));'
}

handle_of_viewer() {
  # The plugin names the session itself, so the viewer'"'"'s handle is known only once its listener has started.
  for _ in $(seq 1 60); do
    local pid; pid=$(ls "$BASE/wire/sessions/"*.pid 2>/dev/null | head -1 || true)
    [ -n "$pid" ] && { basename "$pid" .pid; return; }
    sleep 1
  done
  die "the viewer's plugin did not start its listener (is the plugin loading? run: claude plugin validate plugin)"
}

case "${1:-}" in
start)
  shift; COLS=200 ROWS=50 LOG=""
  [[ "${1:-}" =~ ^[0-9]+$ ]] && { COLS=$1; shift; }
  [[ "${1:-}" =~ ^[0-9]+$ ]] && { ROWS=$1; shift; }
  [ "${1:-}" = "--log" ] && { LOG=${2:?--log needs a file}; [ -f "$LOG" ] || die "no such log: $LOG"; }
  command -v tmux >/dev/null || die "tmux is not installed"
  tmux kill-session -t "$NAME" 2>/dev/null || true
  rm -rf "$BASE"; mkdir -p "$BASE/work" "$BASE/wire"
  WIRE_DIR="$BASE/wire" node "$CLIENT" init --name Viewer >/dev/null
  tmux new-session -d -s "$NAME" -x "$COLS" -y "$ROWS" \
    "cd '$BASE/work' && WIRE_DIR='$BASE/wire' claude --plugin-dir '$ROOT/plugin'; sleep 3600"
  # Answer Claude Code's first-run screens until the prompt box shows.
  for _ in $(seq 1 60); do
    sleep 1
    if has "Choose the text style"; then tmux send-keys -t "$NAME" Enter
    elif has "Press Enter to continue"; then tmux send-keys -t "$NAME" Enter
    elif has "Yes, I trust this folder"; then tmux send-keys -t "$NAME" Down; sleep 0.3; tmux send-keys -t "$NAME" Enter
    elif has "for shortcuts"; then break
    fi
  done
  has "for shortcuts" || { screen | tail -20; die "Claude Code did not reach its prompt (signed in?)"; }
  H=$(handle_of_viewer)
  if [ -n "$LOG" ]; then cp "$LOG" "$BASE/wire/sessions/$H.log"; else sample_log > "$BASE/wire/sessions/$H.log"; fi
  tmux send-keys -t "$NAME" "/wire" Enter
  sleep 6
  echo "viewer running at ${COLS}x${ROWS} ($([ -n "$LOG" ] && echo "log: $LOG" || echo "sample conversation")). Next: $0 shot --panel"
  ;;
shot)
  tmux has-session -t "$NAME" 2>/dev/null || die "not running: $0 start"
  if [ "${2:-}" = "--panel" ]; then
    # Docked (wide terminals): the panel starts at the column where most rows have its left border '│'.
    # Above the prompt (narrow terminals): it is the framed block from its '╭' row to its '╰' row.
    screen | node -e '
      const lines = require("fs").readFileSync(0, "utf8").split("\n"), count = new Map();
      for (const l of lines) { [...l].forEach((c, i) => { if (c === "│" && i > 10) count.set(i, (count.get(i) || 0) + 1); }); }
      const top = lines.findIndex((l) => /^╭/.test(l)), bottom = lines.findIndex((l, i) => top >= 0 && i > top && /^╰/.test(l));
      if (top >= 0 && bottom > top) { for (const l of lines.slice(top, bottom + 1)) console.log(l.replace(/\s+$/, "")); process.exit(0); }
      const [col, hits] = [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ?? [0, 0];
      if (hits < 8) { console.log("(no panel on screen)"); process.exit(0); }
      for (const l of lines) console.log([...l].slice(col).join("").replace(/\s+$/, ""));' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'
  else
    screen
  fi
  ;;
type)
  tmux send-keys -t "$NAME" -l "${2:?type needs text}"; sleep 0.3; tmux send-keys -t "$NAME" Enter; sleep 3 ;;
keys)
  shift; for k in "$@"; do tmux send-keys -t "$NAME" "$k"; sleep 0.4; done; sleep 2 ;;
resize)
  tmux resize-window -t "$NAME" -x "${2:?cols}" -y "${3:?rows}"; sleep 3 ;;
stop)
  tmux kill-session -t "$NAME" 2>/dev/null || true; rm -rf "$BASE"; echo "viewer stopped" ;;
*)
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
