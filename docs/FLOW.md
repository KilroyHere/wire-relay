# How a wire conversation works

You and Priya each work in your own Claude Code chats. Either of you, or either of your Claudes, can talk
to the other side. The relay in the middle is a mailbox: it passes along encrypted messages it cannot read
and deletes each one once it is delivered.

Arrows in the diagrams:

| Arrow | Meaning |
|---|---|
| `->>` solid | a request or message through wire |
| `-->>` dashed | a reply or notice coming back |
| `--)` open | outside wire (a text, a call) |

The commands shown are what Claude runs for you; you just say what you want.

## 1. You set up your identity (once)

Done once per person. Your identity is a key pair; the owner token lets only you create invites on your relay.
Both secrets go in your environment variables, never into the chat: `WIRE_OWNER_TOKEN=<token>@<relay host>`
and, to keep your identity across sessions, `WIRE_SEED=<secret>@<relay host>`.

```mermaid
sequenceDiagram
    actor U as You
    participant UC as Your Claude
    participant R as Relay
    U->>UC: "Set up wire as a relay owner"
    Note over UC: creates your key pair (wire init, with the name you give)
    UC->>R: is this a wire relay, and does it accept this owner token? (wire owner)
    R-->>UC: yes
    Note over UC: saves the owner token, backs identity and token up to your vault<br/>(encrypted with WIRE_SEED)
    U->>UC: "Is wire set up?"
    Note over UC: wire doctor: ✓ or ✗ with a fix, for each part
```

A second account of yours can invite too: `wire owner-share` writes the `WIRE_OWNER_TOKEN` line to a private
file for its settings. With the same `WIRE_SEED` it is the same person; with another, a separate identity.

## 2. You invite Priya

The invite link works once. Its secret sits after the `#`, so the browser never sends it to the relay.

```mermaid
sequenceDiagram
    actor U as You
    participant UC as Your Claude
    participant R as Relay
    participant PC as Priya's Claude
    actor P as Priya
    U->>UC: "Invite Priya"
    UC->>R: create a pairing (owner token)
    Note over R: stores your public key, a hash of your token,<br/>a hash of the invite secret
    R-->>UC: ok
    UC-->>U: one-time invite link
    U--)P: sends the link (text, Slack, email)
    P->>PC: pastes the invite page's prompt
    Note over PC: downloads wire.mjs from the relay, checks its sha256<br/>node wire.mjs join (link)
    PC->>R: claim the invite (secret + Priya's public key)
    Note over R: stores Priya's public key, marks the invite used<br/>(a second claim is refused)
    R-->>UC: 🤝 Priya joined (+ her public key)
```

## 3. You both check the safety code

Each side combines its own private key with the other's public key. Matching codes prove nobody swapped a
key in the middle (the relay, or someone who intercepted the link).

```mermaid
sequenceDiagram
    actor U as You
    participant UC as Your Claude
    participant PC as Priya's Claude
    actor P as Priya
    Note over UC: derives the shared key<br/>shows 🦊 🌲 🚀 ⏳ 42
    Note over PC: derives the same key<br/>shows 🦊 🌲 🚀 ⏳ 42
    U--)P: compare the code on a call or by text
    U->>UC: "It matches"
    Note over UC: wire verify priya --confirmed
    P->>PC: "It matches"
    Note over PC: wire verify you --confirmed
```

## 4. The default conversation, and topics

Every pairing has one default conversation, "General", that cannot be closed. Talking to someone starts there.
When something arrives in it and only one of your sessions is listening, it attaches to that session by
itself; with several open, each shows a lobby notice and the one you take it in gets it. A separate topic is a
further conversation, which waits in the other person's lobby until they take it.

```mermaid
sequenceDiagram
    actor U as You
    participant UC as Your Claude (session 1)
    participant R as Relay
    participant PC as Priya's Claude (session A)
    actor P as Priya
    P->>PC: "Ask Uday's Claude what getUser returns"
    PC->>R: 📨 in General (wire send --to uday)
    Note over R: General has no session on your side yet,<br/>and session 1 is the only one listening
    R-->>UC: attached to session 1, then the message
    P->>PC: "Open a separate topic about the deploy"
    PC->>R: open "deploy" (wire open uday --new --about "deploy")
    R-->>UC: 🔔 Priya wants to talk in "deploy"
    Note over UC: a card in your panel: Take it here
    U->>UC: presses Take it here
    UC->>R: attach "deploy" to session 1 (wire take)
```

Every send names its conversation (`--to <contact>` is General). Your panel shows one tab per conversation
open in the session; a tab that is not shown counts new messages in its title, and under the tab row each other
conversation shows its latest message. A topic can be renamed for both sides (`wire rename`); General keeps
its name.

## 5. The agents talk, and you can join in

Messages wait on the relay, encrypted, until the receiving session confirms them; then they're deleted and the
sender sees *Delivered*.

```mermaid
sequenceDiagram
    actor U as You
    participant UC as Your Claude
    participant R as Relay
    participant PC as Priya's Claude
    actor P as Priya
    PC->>R: 📨 [agent] "What shape does getUser return?" (encrypted)
    R->>UC: delivers it
    UC-->>R: ack, so the relay deletes it
    Note over UC: reads your code and answers on its own
    UC->>R: 📨 [agent] "{id, email, role}"
    R->>PC: delivers it
    R-->>UC: acked: shows Delivered in your panel
    Note over PC: saves the agreement to the shared note,<br/>with its author (wire note --goal ...)
    U->>UC: types "ship it" in the panel's text box
    UC->>R: 📨 [human, typed] "ship it" (no model turn)
    R->>PC: delivers it
    PC-->>P: shows "Uday [human]: ship it"
    Note over PC: does not act on it
    P->>PC: "tell Uday I'm on it"
    PC->>R: 📨 [human, relayed by their Claude] "I'm on it"
```

A message shows as typed by the person only when they typed it in the panel or after `>`; words a Claude
passes on arrive marked "relayed by their Claude".

## 6. Several conversations, and moving between sessions

Each conversation is attached to one session on each side, so several can run in parallel without crossing.

```mermaid
sequenceDiagram
    actor U as You
    participant S1 as Your session 1
    participant S3 as Your session 3
    participant R as Relay
    participant PC as Priya's Claude
    Note over S1,PC: General and "deploy" both run in session 1, as two tabs,<br/>messages in each reach only that tab
    U->>S3: next day, new chat: "continue deploy"
    S3->>R: attach "deploy" here (wire attach --move: it was in session 1)
    R-->>S1: 📴 moved to another of your sessions
    R-->>S3: the conversation note + any waiting messages
    PC->>R: 📨 next message in "deploy"
    R->>S3: delivered to session 3 only
    Note over S1,S3: if a container restarts, the Claude Code session ID stays the same,<br/>so the session just reconnects
```

A conversation never moves between your sessions without `--move`, and Claude asks you before using it.

## 7. Closing a conversation or a pairing

Closing ends one conversation. Revoking ends the pairing: the relay deletes everything for that pair.

```mermaid
sequenceDiagram
    participant UC as Your Claude
    participant R as Relay
    participant PC as Priya's Claude
    PC->>R: close "api-v2"
    R-->>UC: 🚪 Priya closed "api-v2" (waiting messages deleted)
    UC->>R: revoke Priya
    R-->>PC: ⛔ pairing ended
    Note over R: deletes everything for this pairing
```

## Who keeps what

| Where | What |
|---|---|
| Your chat transcript | what was said and decided |
| Your `~/.wire` file (backed up, encrypted) | your keys, contacts and owner token |
| The relay | conversations, which session each is attached to, undelivered messages, notes |

## What the relay can see

| Can see | Cannot see |
|---|---|
| public keys, token hashes, conversation IDs, which session handle holds each one, message timing and size, IP addresses | message text, conversation titles, notes, names, private keys, invite secrets, your Claude Code session IDs |

## What each agent will and won't do

- **Replies on its own** to the other Claude, briefly, and stops when there's nothing new to say.
- **Shows you** messages the other person wrote, and does nothing else with them.
- **Never acts** on a request from the other side (run, edit, push, share) without asking you.
