#!/usr/bin/env bash
# End-to-end test: starts the relay locally (wrangler dev) and drives two people ("uday", "priya")
# and several of their sessions through the full flow. Run: npm test
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD PORT=${PORT:-8799} R="http://127.0.0.1:${PORT:-8799}"
T=$(mktemp -d) PASS=0 FAIL=0
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}" no_proxy="127.0.0.1,localhost${no_proxy:+,$no_proxy}"

cleanup() { pkill -P $$ 2>/dev/null; kill "$DEV" 2>/dev/null; pkill -f "wrangler dev --port $PORT" 2>/dev/null; pkill -f "$T/" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT

npx wrangler dev --port "$PORT" --ip 127.0.0.1 --var OWNER_TOKEN:devtoken > "$T/dev.log" 2>&1 & DEV=$!
for _ in $(seq 1 60); do curl -s -m 2 "$R/" 2>/dev/null | grep -q 'wire relay' && break; sleep 1; done

U() { WIRE_DIR=$T/uday  CLAUDE_CODE_SESSION_ID=${SESS:-u-s1} node "$ROOT/client/wire.mjs" "$@"; }
P() { WIRE_DIR=$T/priya CLAUDE_CODE_SESSION_ID=${SESS:-p-s1} node "$ROOT/client/wire.mjs" "$@"; }
ok() { if grep -qE -- "$2" <<<"$3"; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1"; echo "    expected /$2/ in: $3"; fi; }
listen() { ( "$@" listen > "$T/$LOG" 2>/dev/null & ); }
wait_for() { for _ in $(seq 1 30); do grep -qE -- "$2" "$T/$1" 2>/dev/null && return; sleep 0.3; done; }

echo "relay"
ok "serves the client"          "const VERSION"          "$(curl -s "$R/wire.mjs" | head -20)"
SHA=$(curl -s "$R/wire.mjs" | sha256sum | cut -d' ' -f1)
ok "checksum matches"           "$SHA"                    "$(curl -s "$R/wire.mjs.sha256")"
ok "invite page embeds it"      "$SHA"                    "$(curl -s "$R/i")"

echo "step 1: owner token"
U init --name Uday >/dev/null
echo -n wrong | U owner --relay "$R" >/dev/null
ok "wrong owner token refused"  "not owner"               "$(U invite Priya 2>&1)"
echo -n devtoken | U owner --relay "$R" >/dev/null 2>&1
ok "unknown pairing refused"    "no such pairing"         "$(curl -s -X POST -d '{}' "$R/p/AAAAAAAAAAAAAAAAAAAAAA/send")"

echo "step 2: invite, claim once, safety code"
LINK=$(U invite Priya 2>/dev/null | grep '/i#' | tr -d ' ')
LOG=u1.out listen U
JOIN=$(P join "$LINK" --name Priya 2>/dev/null)
ok "invitee joins"              "Safety code"             "$JOIN"
ok "invite is single-use"       "already used"            "$(WIRE_DIR=$T/mallory node client/wire.mjs join "$LINK" --name Mallory 2>&1)"
wait_for u1.out joined
CODE_P=$(grep -o 'Safety code: [^.]*' <<<"$JOIN" | head -1 | cut -d' ' -f3-7)
ok "inviter sees join + same code" "$CODE_P"              "$(cat "$T/u1.out")"
U verify priya --confirmed >/dev/null 2>&1; P verify uday --confirmed >/dev/null 2>&1
ok "verified"                   "verified ✓"              "$(U contacts)"

echo "step 3: conversations bound to sessions"
LOG=p1.out listen P
C1=$(P open uday --about "api-v2" | grep -o 'uday/[A-Za-z0-9_-]*' | cut -d/ -f2)
P send --to "uday/$C1" "shape ok?" >/dev/null
wait_for u1.out "🔔"
ok "lobby notice"               "🔔 \[priya/$C1 \"api-v2\"\]" "$(cat "$T/u1.out")"
U take "priya/$C1" >/dev/null; wait_for u1.out "shape ok"
ok "held message delivered on take" "Claude \(Priya\) \[agent\]: shape ok" "$(cat "$T/u1.out")"
U send --as human "ship it" >/dev/null; wait_for p1.out "ship it"
ok "reply without --to"         "Uday \[human\]: ship it" "$(cat "$T/p1.out")"
LOG=u2.out SESS=u-s2 listen U
C2=$(SESS=u-s2 U open priya --about "deploy" | grep -o 'priya/[A-Za-z0-9_-]*' | cut -d/ -f2)
P take "uday/$C2" >/dev/null; P send --to "uday/$C2" "deploy q" >/dev/null; wait_for u2.out "deploy q"
ok "parallel conv reaches its own session" "deploy q"     "$(cat "$T/u2.out")"
ok "and not the other session"  "^$"                      "$(grep 'deploy q' "$T/u1.out")"
U note "priya/$C1" "agreed: {id,email,role}" >/dev/null
ok "shared encrypted note"      "agreed"                  "$(P note "uday/$C1")"
LOG=u3.out SESS=u-s3 listen U
ok "takeover reports move"      "other session was told"  "$(SESS=u-s3 U attach "priya/$C1")"
wait_for u1.out "📴"
ok "old session gets 📴"         "📴"                       "$(cat "$T/u1.out")"
P send --to "uday/$C1" "after takeover" >/dev/null; wait_for u3.out "after takeover"
ok "new session gets messages"  "after takeover"          "$(cat "$T/u3.out")"

echo "backup / restore"
git init -q "$T/home" && git -C "$T/home" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t \
  WIRE_PASSPHRASE=pw WIRE_HOME_REPO=$T/home U backup 2>/dev/null
ok "wrong passphrase refused"   "Wrong passphrase"        "$(WIRE_DIR=$T/new WIRE_PASSPHRASE=nope WIRE_HOME_REPO=$T/home node client/wire.mjs restore 2>&1)"
WIRE_DIR=$T/new WIRE_PASSPHRASE=pw WIRE_HOME_REPO=$T/home node client/wire.mjs restore >/dev/null
ok "restored session recognised" "attached HERE"          "$(WIRE_DIR=$T/new CLAUDE_CODE_SESSION_ID=u-s3 node client/wire.mjs ls)"

echo "security"
PAIR=$(node -e "console.log(require('$T/uday/contacts.json').contacts.priya.pair)")
ok "bad member token refused"   "unauthorized"            "$(curl -s -X POST -H 'x-wire-side: a' -H 'x-wire-token: x' -d '{}' "$R/p/$PAIR/convs")"
P close "uday/$C1" >/dev/null; wait_for u3.out "🚪"
ok "close reaches other side"   "🚪"                       "$(cat "$T/u3.out")"
U revoke priya >/dev/null 2>&1; wait_for p1.out "⛔"
ok "revoke reaches other side"  "⛔"                       "$(cat "$T/p1.out")"

echo; echo "$PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
