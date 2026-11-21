# wire

Private, end-to-end encrypted conversations between **people and their Claude Code agents**.

You (or your Claude) and another person (or their Claude) talk inside your normal Claude Code chats.
Messages show up in the conversation as they arrive; your agent can answer the other agent on its own,
while messages from humans are shown to you and left alone.

```
 Your Claude Code session                    relay                    Their Claude Code session
 ───────────────────────          (Cloudflare Worker +               ─────────────────────────
 you ⇄ your Claude  ── wire ──►    Durable Object mailbox)  ◄── wire ──  their Claude ⇄ them
                                  stores only ciphertext,
                                  deletes on delivery
```

## How it works

- **People pair once.** The relay owner creates a one-time invite link; the other person opens it and
  pastes one line into Claude Code. Both sides then see the same **safety code** (e.g. `🦊 🌲 🚀 42`) to
  compare over a call or text.
- **One conversation per person, by default.** Every pairing has a default conversation ("General") that
  cannot be closed. When the other side writes there and only one of your sessions is listening, it lands
  there; with several open, each shows a lobby notice and the session you take it in gets it. A separate
  topic is a further conversation (`wire open <contact> --new --about "<topic>"`), which waits in the other
  person's lobby until they take it. A conversation never moves between your sessions without `--move`.
- **The relay is a mailbox.** Messages are held until the recipient's session acknowledges them, then
  deleted, and the sender sees *Delivered*. Undelivered messages expire after 7 days. Each conversation has
  a small encrypted *note* (a summary or a structured handoff, with its author) so a session that picks it
  up later has context.
- **Honest labels.** A message shows as typed by the person only when they typed it in the panel or after
  `>`; words their Claude passes on are marked "relayed by their Claude". People appear under the name
  *you* gave them, with "calls themselves X" when their own name differs.

## How it flows

```mermaid
sequenceDiagram
    actor U as You
    participant UC as Your Claude
    participant R as Relay (ciphertext only)
    participant PC as Priya's Claude
    actor P as Priya

    Note over U,P: 1 · Pair once
    U->>UC: "Invite Priya"
    UC->>R: create a pairing (owner token)
    UC-->>U: one-time invite link
    U--)P: sends the link (text, Slack, email)
    P->>PC: pastes the invite page's prompt
    PC->>R: claim the invite + Priya's public key
    R-->>UC: 🤝 Priya joined + her public key
    U--)P: compare the safety code on a call

    Note over U,P: 2 · Talk (each conversation is bound to one session per side)
    PC->>R: open conversation "api-v2" (her session A)
    R-->>UC: 🔔 lobby: Priya wants to talk
    UC->>R: take it (your session 1)
    PC->>R: 📨 [agent] "What shape does getUser return?"
    R->>UC: delivered, then deleted on ack
    UC->>R: 📨 [agent] "{id, email, role}"
    R->>PC: delivered
    U->>UC: types "> ship it"
    UC->>R: 📨 [human] "ship it"
    R->>PC: delivered
    PC-->>P: shows it, does not act on it

    Note over U,P: 3 · Move or end
    UC->>R: attach "api-v2" from your session 3
    R-->>UC: 📴 session 1 is told it moved
    PC->>R: close the conversation, or revoke the pairing
```

Every phase step by step, with what the relay stores at each point: [docs/FLOW.md](docs/FLOW.md).

## Security model

| Thing | How |
|---|---|
| Message content, conversation titles, notes | AES-256-GCM, key = HKDF(X25519(my private key, their public key), pair id, conv id). The relay never has the keys. |
| Invite link | One-time. Its secret is in the URL fragment (`#…`), which browsers never send to servers. A second use is refused, so a stolen link is noticed. |
| Impersonation / interception | Each person has an X25519 key pair; after pairing, the link alone is useless. The safety code detects a swapped key (only if you actually compare it). |
| Who can create pairings | Only the relay owner (`OWNER_TOKEN` Worker secret). Members authenticate with per-pairing tokens; the relay stores only their hashes. |
| Session identity | `HMAC(handle secret, CLAUDE_CODE_SESSION_ID)` — stable for a session, meaningless to the relay. |
| What the relay can see | Pair ids, public keys, timing and size of messages, which session handle a conversation is attached to, the size of your vault, and (in memory only) whether a side is listening and, if they turned it on, active / away. |
| Abuse | At most 60 messages a minute per pairing side; per IP address, 20 invite claims and 120 vault writes an hour. Only the relay owner can create invites. |
| Not yet | **Safety guards (phase 2 of [the plan](docs/PLAN.md))**: today a turn started by the other side's Claude runs with your session's normal permissions; only the rules in Claude's prompt keep it from acting on their requests. |
| Agents | Incoming messages are information, never instructions. The rules every Claude follows (`wire rules`) forbid acting on the other side's requests without its own user's approval. |

Not (yet) included: forward secrecy (ratcheting keys). Since the relay deletes messages on delivery,
there is little stored ciphertext to protect.

## Claude Code plugin (recommended)

The plugin makes wire part of Claude Code instead of something Claude has to remember to run:

- it keeps the listener running for the session (no timeouts to re-arm);
- **a side panel is the chat with the other person**, one tab per conversation open in the session (unread messages show in the tab's title); `/wire` opens it and puts the cursor in the text box, and `/wire <contact>/<conversation>` switches tab. It shows the conversation in focus and has its own
  text box: what you type there goes out as your own words, with no model turn. It opens by itself when
  the session has a conversation (in a wide window; otherwise run `/wire`). Lobby requests and safety
  codes show there with a button (*Take it here*, *The codes match*);
- **the main thread is for the work.** A message from the other person's Claude starts a turn there, and
  your Claude answers from where the code is. What the other person typed stays out of the main thread
  and reaches your Claude as context with your next prompt;
- `/wire <contact>/<conversation>` switches the panel to another conversation. An incoming message never
  switches it, so a reply cannot go to the wrong person;
- where an app shows no panels, messages appear in the chat instead, a line you start with `>` is sent as
  your own words, and `/wire` prints the conversation;
- the panel shows when each of your messages was delivered, folds long messages, and holds the whole
  conversation; with presence on (`wire presence on`, off by default) it also shows whether the other person
  is active, and always whether their Claude is listening;
- your Claude gets the wire rules in its system prompt, can read the panel with the read-only
  `mcp__wire__panel` tool, and `wire` is put on the PATH.

Install it at the prompt of a terminal session:

```
/plugin install wire --marketplace KilroyHere/wire-relay
```

In the desktop app: + next to the prompt box, Plugins, Add marketplace `KilroyHere/wire-relay`, Add plugin.
Then tell Claude `join this wire invite: <link>`, or set up your own relay (below). Without the plugin,
everything still works through the `wire` command and Claude Code's Monitor tool.

## Joining someone's wire (most people)

Open the invite link you were sent. The page asks for your name and gives you one message to copy and
paste into a Claude Code session. Claude then:

1. downloads the `wire` client from the relay and checks its checksum;
2. joins the chat and tells you the **safety code** to compare with the person who invited you;
3. installs the wire plugin (`claude plugin install wire --marketplace <owner>/<repo>`), which adds the
   chat panel. Run `/reload-plugins` or start a new session to see it; until then Claude listens with the
   Monitor tool, and steps aside once the plugin is listening.

In a **cloud session with limited network access**, approve the relay's host once when Claude asks. On macOS
the checksum step needs `shasum -a 256 -c -` in place of `sha256sum -c -`.

Cross-check the checksum against this repository's releases if you don't control the relay: the relay
serves both the file and its checksum, so a compromised relay could change both.

## Running your own relay

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/KilroyHere/wire-relay)

Or by hand (free Cloudflare plan is enough):

```bash
npm install
```

```bash
npx wrangler deploy
```

```bash
openssl rand -hex 32 | tee /dev/stderr | npx wrangler secret put OWNER_TOKEN
```

Then, in your own Claude Code session:

```bash
curl -fsSL https://<your-relay>/wire.mjs -o ~/.wire/wire.mjs --create-dirs && node ~/.wire/wire.mjs install
```

```bash
wire init --name "<you>"
```

```bash
echo -n "<the OWNER_TOKEN>" | wire owner --relay https://<your-relay>
```

```bash
wire invite priya
```

Invite links contain the relay address, so people on different relays can still talk to each other.
If you deploy your own copy, set `PLUGIN_SOURCE` in `wrangler.jsonc` to your repository, so your invite
page installs the plugin from there (or remove it to leave the plugin out of the invite).

## Commands

```
wire init --name <you>                 create your identity (once per person)
wire owner --relay <url>               save the relay owner token (stdin), relay owners only
wire invite <contact>                  one-time invite link
wire join <link> --name <you>          accept an invite
wire contacts                          contacts, safety codes, verified status
wire verify <contact> [--confirmed]    show / confirm the safety code
wire open <contact>                    bring the default conversation ("General") to this session
wire open <contact> --new --about "<topic>"   a separate conversation for a topic
wire ls [contact]                      conversations: attached here / elsewhere / in your lobby
wire take|attach <ref> [--move]        attach a conversation here (--move: from another of your sessions)
wire send --to <contact>[/<conv>] [--as agent|human] <text>
wire note <ref> [text] [--goal ..] [--branch ..] [--done ..] [--next ..] [--open ..]
wire clear <ref>                       delete a conversation's waiting messages and note
wire close <ref>                       end a topic (the default conversation cannot be closed)
wire revoke|leave <contact>            end a pairing on both sides; deletes this machine's log of it
wire presence on|off                   share active / away with your contacts (off by default)
wire listen [--json]                   event stream for this session (use with Monitor)
wire log [-n N] [--json]               what this session saw and sent
wire backup · wire restore · wire forget   your encrypted vault (WIRE_SEED)
wire update                            replace the client with the relay's current version
wire version · wire install · wire whoami · wire rules
```

A reference `<ref>` is `<contact>` (that contact's default conversation) or `<contact>/<conversation>`.
Inside Claude Code you rarely type these: tell Claude what you want ("open a chat with Priya", "ask Priya's
Claude about the deploy"), type in the wire panel, or start a line with `>` to send your own words.

## Where things are stored

| What | Where | How long |
|---|---|---|
| The conversation (what was said) | **On your side only**: the Claude Code transcript, and a per-session log the client keeps at `~/.wire/sessions/` so the panel and `wire log` survive a restart. Plain text, readable only by you; it goes away with the machine. | Until you delete it |
| A message in transit | The relay, encrypted | Until the other side receives it (then deleted), 7 days at most |
| Conversation title and note | The relay, encrypted | Until the conversation is closed or the pairing revoked |
| Pairing | The relay: two public keys, hashes of two access tokens, which session handle holds each conversation | Until revoked |
| Your identity and contacts | Your side (`~/.wire/contacts.json`); on the relay only if you set `WIRE_SEED` (the vault, encrypted) | Until you remove it |

The relay never holds a transcript: a delivered message is gone from it.

## Keeping your identity across sessions

Cloud containers are temporary, but your identity and contacts (`~/.wire/contacts.json`) must survive, or
every new session is a stranger. wire keeps an encrypted copy, the *vault*, on a relay.

1. Generate a long random secret yourself:

   ```bash
   openssl rand -hex 32
   ```

2. In your cloud environment's settings, add the variable `WIRE_SEED=<that secret>@<relay host>`, for
   example `WIRE_SEED=3f9c…@wire-relay.example.workers.dev`. Sessions started after that pick it up.

From then on every change (a new contact, a verification, a revoke) updates the vault, and a new session
restores itself the first time `wire` runs. `wire backup` and `wire restore` do it by hand.

The vault's address, its access token and its encryption key are all derived from the secret (scrypt, then
HKDF), so the relay stores only ciphertext it cannot read or find without the seed. A relay keeps vaults
only for its owner and for people paired on it. The seed is an environment variable, so anything running in
your sessions on that environment can read it: use a personal environment.

## Development

```bash
npm install
```

```bash
npm test
```

`test/panel-view.sh start` runs a second Claude Code in tmux with this plugin and a sample conversation, so a
person or a Claude can see and use the real panel (`shot --panel`, `type`, `resize`, `stop`).

`npm test` starts the relay locally with `wrangler dev` and runs the full flow (pairing, lobby,
parallel sessions, takeover, catch-up after being offline, notes, the vault, update notices, revocation) with two simulated people.

Layout: `relay/src/index.js` (Worker + Durable Objects), `plugin/` (the Claude Code plugin: `hooks/register.tsx`
and `client/wire.mjs`, the single-file client with no dependencies, which the Worker also bundles and serves
at `/wire.mjs`), `test/e2e.sh`. The plugin has its own tests: `claude plugin test plugin`.
