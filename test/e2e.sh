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
ok "and updates it when already installed" "claude plugin update wire@wire" "$(curl -s "$R/i")"
ok "the invite page says what wire needs" "Claude Code.*|expires 7 days" "$(curl -s "$R/i")"
ok "and carries a safety note"  "not instructions"        "$(curl -s "$R/i")"

echo "step 1: owner token"
U init --name Uday >/dev/null
ok "wrong owner token refused"  "does not accept"         "$(echo -n wrong | U owner --relay "$R" 2>&1)"
ok "and not saved"              "Only a relay owner"      "$(U invite Priya 2>&1)"
OUT=$(WIRE_OWNER_TOKEN="devtoken@nohost" U owner 2>&1)
ok "a malformed WIRE_OWNER_TOKEN is refused" "not in the form" "$OUT"
ok "without printing it"        "^$"                      "$(grep -E 'devtoken|nohost' <<<"$OUT" || true)"
ok "a host that is not a relay is refused" "cannot reach" "$(WIRE_OWNER_TOKEN="devtoken@http://127.0.0.1:1" U owner 2>&1)"
ok "owner help explains the setup" "WIRE_OWNER_TOKEN=<owner token>@<relay host>" "$(U help owner)"
ok "WIRE_OWNER_TOKEN=<token>@<relay> is checked and saved" "checked and saved for $R" "$(WIRE_OWNER_TOKEN="devtoken@$R" U owner 2>&1)"
OUT=$(U owner-share --out "$T/share.txt" 2>&1)
ok "owner-share writes the line to a file" "WIRE_OWNER_TOKEN=devtoken@$R" "$(cat "$T/share.txt")"
ok "readable only by the owner" "^600$"                   "$(stat -c %a "$T/share.txt")"
ok "and does not print the token" "^$"                    "$(grep devtoken <<<"$OUT" || true)"
WIRE_DIR=$T/o2 node plugin/client/wire.mjs init --name Other >/dev/null 2>&1
ok "another account invites with only WIRE_OWNER_TOKEN set" "/i#" "$(WIRE_DIR=$T/o2 WIRE_OWNER_TOKEN="$(cut -d= -f2- "$T/share.txt")" node plugin/client/wire.mjs invite sam 2>&1)"
ok "unknown pairing refused"    "no such pairing"         "$(curl -s -X POST -d '{}' "$R/p/AAAAAAAAAAAAAAAAAAAAAA/send")"
H64=$(printf 'a%.0s' $(seq 64)); PUB=$(printf 'B%.0s' $(seq 43))
ok "a pairing cannot be created without the owner token" "not found" "$(curl -s -X POST -d "{\"invite_hash\":\"$H64\",\"pub_a\":\"$PUB\",\"tok_a\":\"$H64\"}" "$R/p/BypassAttemptPair01/init")"
ok "so nothing was created"     "no such pairing"         "$(curl -s -X POST -d '{"invite":"x","pub_b":"'$PUB'","tok_b":"'$H64'"}' "$R/p/BypassAttemptPair01/claim")"

echo "step 2: invite, claim once, safety code"
LINK=$(U invite Priya 2>/dev/null | grep '/i#' | tr -d ' ')
LOG=u1.out listen U
JOIN=$(P join "$LINK" --name Priya 2>/dev/null)
ok "invitee joins"              "Safety code"             "$JOIN"
ok "join tells the person how to use it" "Tell your user" "$JOIN"
ok "and how to keep the pairing" "WIRE_SEED=<a long random secret>@$R" "$JOIN"
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

echo "messages out of order across conversations"
CT=$(P open uday --new --about "later" | grep -o 'uday/[A-Za-z0-9_-]*' | cut -d/ -f2)
P send --to "uday/$CT" "older, in a conversation taken later" >/dev/null
P send --to uday "newer, in General" >/dev/null; wait_for u1.out "newer, in General"
U take "priya/$CT" >/dev/null; wait_for u1.out "older, in a conversation taken later"
ok "a conversation taken later still gets its older message" "older, in a conversation taken later" "$(cat "$T/u1.out")"
P send --to uday "after the take" >/dev/null; wait_for u1.out "after the take"
ok "and a newer confirmation does not delete anything unseen" "^0$" "$(U ls priya | grep -c "later.*waiting" || true)"

echo "delivered per message"
CW=$(U open priya --new --about "nobody here yet" | grep -o 'priya/[A-Za-z0-9_-]*' | cut -d/ -f2)
U send --to "priya/$CW" "waits: priya has not taken this" >/dev/null
U send --to priya "delivered: priya listens in General" >/dev/null; sleep 2
ok "only the delivered message is marked delivered" "ok" "$(U log --json | node -e '
  const l = require("fs").readFileSync(0, "utf8").trim().split("\n").map(JSON.parse);
  const sent = (t) => l.filter((e) => e.kind === "sent" && e.text === t).pop()?.id;
  const acked = new Set(l.filter((e) => e.kind === "acked" && e.ids).flatMap((e) => e.ids));
  const w = sent("waits: priya has not taken this"), d = sent("delivered: priya listens in General");
  console.log(acked.has(d) && !acked.has(w) ? "ok" : "wrong: waiting " + w + " delivered " + d + " acked " + [...acked]);')"

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
# A second pairing whose other side sits on the same side letter as Lee: it must not see Lee's presence.
LINKK=$(U invite kai 2>/dev/null | grep '/i#' | tr -d ' '); WIRE_DIR=$T/kai node plugin/client/wire.mjs join "$LINKK" --name Kai >/dev/null 2>&1
SESS=l-s2 L presence on >/dev/null; SESS=l-s2 L presence active >/dev/null; sleep 1
( SESS=u-pres2 U listen --json > "$T/upres2.out" 2>/dev/null & ); sleep 3
ok "one pairing's presence does not show in another" "\"state\":null" "$(grep '"contact":"kai"' "$T/upres2.out" | grep presence | tail -1)"
ok "while its own does"         "\"state\":\"active\"" "$(grep '"contact":"lee"' "$T/upres2.out" | grep presence | tail -1)"
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

echo "doctor and secrets"
ok "doctor checks the setup"    "identity: Uday"          "$(SESS=u-pres U doctor)"
ok "and the owner token"        "relay owner of $R"       "$(SESS=u-pres U doctor)"
ok "and each pairing"           "kai: safety code not verified" "$(SESS=u-pres U doctor)"
ok "and this session's listener" "listening in this session" "$(SESS=u-pres U doctor)"
ok "it exits 1 when something is wrong" "no identity.*exit=1" "$( (WIRE_DIR=$T/empty node plugin/client/wire.mjs doctor 2>&1; echo exit=$?) | tr '\n' ' ')"
ok "a wrong WIRE_OWNER_TOKEN shows in doctor" "differs from the saved" "$(WIRE_OWNER_TOKEN="other@$R" SESS=u-pres U doctor)"
OUT=$(WIRE_DIR=$T/s1 WIRE_SEED="abcdefghijklmnopqrstuvwxyz@nohost" node plugin/client/wire.mjs restore 2>&1)
ok "a malformed WIRE_SEED is explained" "not in the form" "$OUT"
ok "without printing any of it" "^$"                      "$(grep -E 'abcdef|nohost' <<<"$OUT" || true)"
OUT=$(NO_PROXY=leak-check.invalid,127.0.0.1 no_proxy=leak-check.invalid,127.0.0.1 WIRE_DIR=$T/s2 WIRE_SEED="abcdefghijklmnopqrstuvwxyz@leak-check.invalid" node plugin/client/wire.mjs restore 2>&1)
ok "a seed whose relay is unreachable fails" "unreachable" "$OUT"
ok "without naming the host"    "^$"                      "$(grep -E 'leak-check|abcdef' <<<"$OUT" || true)"

echo "version"
ok "wire version shows the checksum" "$(sha256sum plugin/client/wire.mjs | cut -d' ' -f1)" "$(node plugin/client/wire.mjs version)"

echo "offline revoke"
LINK2=$(U invite priya2 2>/dev/null | grep '/i#' | tr -d ' ')
WIRE_DIR=$T/priya2 node plugin/client/wire.mjs join "$LINK2" --name Priya2 >/dev/null 2>&1
U revoke priya2 >/dev/null 2>&1
ok "listener reports a pairing revoked while offline" "no longer exists" "$(WIRE_DIR=$T/priya2 timeout 6 node plugin/client/wire.mjs listen 2>/dev/null)"
ok "and removes the contact"    "No contacts"             "$(WIRE_DIR=$T/priya2 node plugin/client/wire.mjs contacts)"

echo; echo "$PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
