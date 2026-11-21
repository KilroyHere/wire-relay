#!/usr/bin/env bash
# End-to-end test: starts the relay locally (wrangler dev) and drives two people ("uday", "priya")
# and several of their sessions through the full flow. Run: npm test
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD PORT=${PORT:-8799} R="http://127.0.0.1:${PORT:-8799}"
T=$(mktemp -d) PASS=0 FAIL=0
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}" no_proxy="127.0.0.1,localhost${no_proxy:+,$no_proxy}"

# Listeners run detached and are told apart only by their WIRE_DIR, so find this run's by environment.
cleanup() {
  for p in $(pgrep -f "wire.mjs listen"); do
    tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -q "^WIRE_DIR=$T/" && kill "$p" 2>/dev/null
  done
  pkill -P $ 2>/dev/null; kill "$DEV" 2>/dev/null; pkill -f "wrangler dev --port $PORT" 2>/dev/null; pkill -f "$T/" 2>/dev/null; rm -rf "$T"
}
trap cleanup EXIT

npx wrangler dev --port "$PORT" --ip 127.0.0.1 --var OWNER_TOKEN:devtoken > "$T/dev.log" 2>&1 & DEV=$!
for _ in $(seq 1 60); do curl -s -m 2 "$R/" 2>/dev/null | grep -q 'wire relay' && break; sleep 1; done

U() { WIRE_DIR=$T/uday  CLAUDE_CODE_SESSION_ID=${SESS:-u-s1} node "$ROOT/plugin/client/wire.mjs" "$@"; }
P() { WIRE_DIR=$T/priya CLAUDE_CODE_SESSION_ID=${SESS:-p-s1} node "$ROOT/plugin/client/wire.mjs" "$@"; }
ok() { if grep -qE -- "$2" <<<"$3"; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1"; echo "    expected /$2/ in: $3"; fi; }
listen() { ( "$@" listen > "$T/$LOG" 2>/dev/null & ); }
wait_for() { for _ in $(seq 1 30); do grep -qE -- "$2" "$T/$1" 2>/dev/null && return; sleep 0.3; done; }

echo "relay"
ok "serves the client"          "const VERSION"          "$(curl -s "$R/wire.mjs" | head -20)"
SHA=$(curl -s "$R/wire.mjs" | sha256sum | cut -d' ' -f1)
ok "checksum matches"           "$SHA"                    "$(curl -s "$R/wire.mjs.sha256")"
ok "invite page embeds it"      "$SHA"                    "$(curl -s "$R/i")"
ok "its one paste installs the plugin too" "claude plugin install wire --marketplace '\+plugin" "$(curl -s "$R/i")"

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
ok "invite is single-use"       "already used"            "$(WIRE_DIR=$T/mallory node plugin/client/wire.mjs join "$LINK" --name Mallory 2>&1)"
wait_for u1.out joined
CODE_P=$(grep -o 'Safety code: [^.]*' <<<"$JOIN" | head -1 | cut -d' ' -f3-7)
ok "inviter sees join + same code" "$CODE_P"              "$(cat "$T/u1.out")"
U verify priya --confirmed >/dev/null 2>&1; P verify uday --confirmed >/dev/null 2>&1
ok "verified"                   "verified ✓"              "$(U contacts)"

echo "step 3: conversations bound to sessions"
LOG=p1.out listen P

echo "default conversation"
sleep 1
P send --to uday "hello in general" >/dev/null; wait_for u1.out "hello in general"
ok "it attaches to the only listening session" "\"General\"\] Claude \(Priya\) \[agent\]: hello in general" "$(cat "$T/u1.out")"
ok "it cannot be closed"        "cannot be closed"        "$(U close priya 2>&1)"
U send --to priya --as human "words my Claude relays" >/dev/null; wait_for p1.out "words my Claude relays"
ok "relayed words are marked"   "Uday \[human, relayed by their Claude\]: words my Claude relays" "$(cat "$T/p1.out")"
U send --to priya --as human --typed "words I typed" >/dev/null; wait_for p1.out "words I typed"
ok "typed words are not"        "Uday \[human\]: words I typed" "$(cat "$T/p1.out")"
sleep 1
ok "the sender learns it was delivered" '"kind":"acked"' "$(U log --json)"
ok "open without --new uses it"  "General\" is in this session" "$(SESS=u-s1 U open priya)"
ok "a topic needs --new"         "add --new|For a separate topic" "$(U open priya --about stuff 2>&1)"

echo "notes with authors"
P note uday "keep both fields one release" --goal "ship api-v2" --next "mobile update" >/dev/null; wait_for u1.out "updated the note"
ok "the other side is told who updated the note" "Priya updated the note: ship api-v2" "$(cat "$T/u1.out")"
ok "reading it shows the fields and the author" "goal: ship api-v2.*" "$(U note priya | tr '\n' ' ')"
ok "and who wrote it"           "written by Priya"        "$(U note priya)"

echo "presence (off by default)"
( SESS=u-pres U listen --json > "$T/upres.out" 2>/dev/null & ); sleep 1.5
SESS=p-s1 P presence active >/dev/null; sleep 1
ok "nothing is shared while it is off" "\"state\":null" "$(grep presence "$T/upres.out" | tail -1)"
P presence on >/dev/null; SESS=p-s1 P presence active >/dev/null; sleep 1.5
ok "once on, active is shared"  "\"state\":\"active\"" "$(grep presence "$T/upres.out" | tail -1)"
ok "with whether their Claude listens" "\"listening\":true" "$(grep presence "$T/upres.out" | tail -1)"
P presence off >/dev/null; sleep 1.5
ok "turning it off clears it"   "\"state\":null" "$(grep presence "$T/upres.out" | tail -1)"
C1=$(P open uday --new --about "api-v2" | grep -o 'uday/[A-Za-z0-9_-]*' | cut -d/ -f2)
P send --to "uday/$C1" "shape ok?" >/dev/null
wait_for u1.out "🔔"
ok "lobby notice"               "🔔 \[priya/$C1 \"api-v2\"\]" "$(cat "$T/u1.out")"
U take "priya/$C1" >/dev/null; wait_for u1.out "shape ok"
ok "held message delivered on take" "Claude \(Priya\) \[agent\]: shape ok" "$(cat "$T/u1.out")"
ok "a send must name its conversation" "Say which conversation" "$(U send --as human "ship it" 2>&1)"
U send --to "priya/$C1" --as human --typed "ship it" >/dev/null; wait_for p1.out "ship it"
ok "reply without --to"         "Uday \[human\]: ship it" "$(cat "$T/p1.out")"
LOG=u2.out SESS=u-s2 listen U
C2=$(SESS=u-s2 U open priya --new --about "deploy" | grep -o 'priya/[A-Za-z0-9_-]*' | cut -d/ -f2)
P take "uday/$C2" >/dev/null; P send --to "uday/$C2" "deploy q" >/dev/null; wait_for u2.out "deploy q"
ok "parallel conv reaches its own session" "deploy q"     "$(cat "$T/u2.out")"
ok "and not the other session"  "^$"                      "$(grep 'deploy q' "$T/u1.out")"
U note "priya/$C1" "agreed: {id,email,role}" >/dev/null
ok "shared encrypted note"      "agreed"                  "$(P note "uday/$C1")"
LOG=u3.out SESS=u-s3 listen U
ok "moving needs --move"        "attached to another of your sessions" "$(SESS=u-s3 U attach "priya/$C1" 2>&1)"
ok "takeover reports move"      "other session was told"  "$(SESS=u-s3 U attach "priya/$C1" --move)"
wait_for u1.out "📴"
ok "old session gets 📴"         "📴"                       "$(cat "$T/u1.out")"
P send --to "uday/$C1" "after takeover" >/dev/null; wait_for u3.out "after takeover"
ok "new session gets messages"  "after takeover"          "$(cat "$T/u3.out")"

echo "rename"
ok "a topic can be renamed"     "renamed priya/$C2 to \"deploy v2\"" "$(SESS=u-s2 U rename "priya/$C2" "deploy v2")"
wait_for p1.out "renamed this conversation"
ok "the other side is told"     "Uday renamed this conversation \"deploy v2\"" "$(cat "$T/p1.out")"
ok "and lists the new name"     "deploy v2"               "$(P ls uday)"
ok "the default keeps its name" "keeps its name"          "$(U rename priya "x" 2>&1)"

echo "session log"
LOGGED=$(SESS=u-s3 U log)
ok "log keeps what arrived"     "Claude \(Priya\) \[agent\]: after takeover" "$LOGGED"
ok "and what this session did"  "attached to this session" "$LOGGED"
ok "sent messages are logged"   "you: ship it"            "$(U log)"

echo "catch-up on reconnect"
C3=$(P open uday --new --about "catchup" | grep -o 'uday/[A-Za-z0-9_-]*' | cut -d/ -f2)
SESS=u-s4 U take "priya/$C3" >/dev/null
P close "uday/$C3" >/dev/null
LOG=u4.out SESS=u-s4 listen U; wait_for u4.out "not listening"
ok "a close missed while offline is reported" "🚪 \[priya/$C3 \"catchup\"\] was closed while" "$(cat "$T/u4.out")"

echo "update notice"
sed "s/^const VERSION = '[^']*';/const VERSION = '0.0.1';/" plugin/client/wire.mjs > "$T/old.mjs"
ok "older client is told to update" "\"kind\":\"update\"" "$(WIRE_DIR=$T/uday CLAUDE_CODE_SESSION_ID=u-old timeout 5 node "$T/old.mjs" listen --json 2>/dev/null)"
ok "wire update replaces it (checksum checked)" "updated 0.0.1" "$(WIRE_DIR=$T/uday node "$T/old.mjs" update --relay "$R" 2>&1)"
ok "and it is the relay's version" "$SHA" "$(sha256sum "$T/old.mjs")"

echo "vault (WIRE_SEED)"
RUN=$(openssl rand -hex 12)   # wrangler dev keeps Durable Object state between runs, so vault seeds are per run
SEED="$RUN-owner@$R"
ok "owner's vault is created"   "vault updated"           "$(WIRE_SEED=$SEED U backup 2>&1)"
ok "new container restores itself" "attached HERE"        "$(WIRE_DIR=$T/new WIRE_SEED=$SEED CLAUDE_CODE_SESSION_ID=u-s3 node plugin/client/wire.mjs ls 2>/dev/null)"
ok "a different seed finds nothing" "No vault"            "$(WIRE_DIR=$T/new2 WIRE_SEED="$RUN-nobody@$R" node plugin/client/wire.mjs restore 2>&1)"
WIRE_DIR=$T/stranger node plugin/client/wire.mjs init --name Stranger >/dev/null 2>&1
ok "strangers cannot create vaults" "not saved"           "$(WIRE_DIR=$T/stranger WIRE_SEED="$RUN-stranger@$R" node plugin/client/wire.mjs backup 2>&1)"
WIRE_SEED=$SEED U invite carol >/dev/null 2>&1
ok "a contact added in one session reaches another" "carol" "$(WIRE_DIR=$T/new WIRE_SEED=$SEED node plugin/client/wire.mjs contacts 2>/dev/null)"
ok "a paired member can keep a vault" "vault updated"     "$(WIRE_SEED="$RUN-priya@$R" P backup 2>&1)"
ok "the relay holds only ciphertext" "^$"                 "$(curl -s -X POST -H "x-wire-vault-token: x" -d '{}' "$R/vault/$(printf 'A%.0s' $(seq 32))/get" | grep -i 'uday\|priya')"

echo "one listener per session"
( SESS=u-lock U listen --json > "$T/lock.out" 2>/dev/null & ); sleep 1
ok "a hand-started listener steps aside for the plugin's" "already listening" "$(WIRE_DIR=$T/uday CLAUDE_CODE_SESSION_ID=u-lock timeout 5 node "$ROOT/plugin/client/wire.mjs" listen 2>/dev/null <<<'' || true)"

echo "security"
PAIR=$(node -e "console.log(require('$T/uday/contacts.json').contacts.priya.pair)")
ok "bad member token refused"   "unauthorized"            "$(curl -s -X POST -H 'x-wire-side: a' -H 'x-wire-token: x' -d '{}' "$R/p/$PAIR/convs")"
P close "uday/$C1" >/dev/null; wait_for u3.out "🚪"
ok "close reaches other side"   "🚪"                       "$(cat "$T/u3.out")"
U revoke priya >/dev/null 2>&1; wait_for p1.out "⛔"
ok "revoke reaches other side"  "⛔"                       "$(cat "$T/p1.out")"

echo "default conversation with two sessions open"
LINK3=$(U invite lee 2>/dev/null | grep '/i#' | tr -d ' ')
WIRE_DIR=$T/lee node plugin/client/wire.mjs join "$LINK3" --name "Lee Ann" >/dev/null 2>&1
L() { WIRE_DIR=$T/lee CLAUDE_CODE_SESSION_ID=$SESS node "$ROOT/plugin/client/wire.mjs" "$@"; }
LOG=l1.out SESS=l-s1 listen L; LOG=l2.out SESS=l-s2 listen L; sleep 1.5
U send --to lee "which session gets this?" >/dev/null; wait_for l1.out "🔔"; wait_for l2.out "🔔"
ok "both sessions get a lobby notice" "🔔.*General" "$(cat "$T/l1.out")"
SESS=l-s2 L take uday >/dev/null; wait_for l2.out "which session gets this"; wait_for l1.out "taken in another"
ok "the one that takes it gets the message" "which session gets this" "$(cat "$T/l2.out")"
ok "the other drops its notice" "taken in another of your sessions" "$(cat "$T/l1.out")"
SESS=l-s2 L send --to uday "hello from lee" >/dev/null; sleep 1; SESS=u-s1 U take lee >/dev/null 2>&1; wait_for u1.out "hello from lee"
ok "a self-chosen name that differs is shown" "lee \(calls themselves Lee Ann\)" "$(cat "$T/u1.out")"

echo "rate limit"
OUT=$(for i in $(seq 1 62); do SESS=l-s2 L send --to uday "burst $i" 2>&1 | tail -1; done)
ok "more than 60 messages a minute are refused" "rate limited" "$OUT"

echo "leave and forget"
ok "leave ends a pairing from the invited side" "Ended the pairing with uday" "$(SESS=l-s2 L leave uday 2>&1)"
ok "and clears this machine's log of it" "^$" "$(SESS=l-s2 L log | grep -i 'lee\|uday' || true)"
ok "forget deletes the vault" "vault is deleted" "$(WIRE_SEED=$SEED U forget 2>&1)"
ok "after which none is found" "No vault" "$(WIRE_DIR=$T/new3 WIRE_SEED=$SEED node plugin/client/wire.mjs restore 2>&1)"

echo "status"
ok "status says when nothing is listening" "listener: NOT running" "$(SESS=u-none U status)"
ok "and when the session is"    "listener: running"       "$(SESS=u-pres U status)"

echo "version"
ok "wire version shows the checksum" "$(sha256sum plugin/client/wire.mjs | cut -d' ' -f1)" "$(node plugin/client/wire.mjs version)"

echo "offline revoke"
LINK2=$(U invite priya2 2>/dev/null | grep '/i#' | tr -d ' ')
WIRE_DIR=$T/priya2 node plugin/client/wire.mjs join "$LINK2" --name Priya2 >/dev/null 2>&1
U revoke priya2 >/dev/null 2>&1
ok "listener reports a pairing revoked while offline" "no longer exists" "$(WIRE_DIR=$T/priya2 timeout 6 node plugin/client/wire.mjs listen 2>/dev/null)"
ok "and removes the contact"    "No contacts"             "$(WIRE_DIR=$T/priya2 node plugin/client/wire.mjs contacts)"

echo; echo "$PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
