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

```mermaid
sequenceDiagram
    actor U as You
    participant UC as Your Claude
    U->>UC: "Set up wire"
    Note over UC: creates your key pair, saves the owner token, backs both up<br/>wire init · wire owner · wire backup
```

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

## 4. Priya starts a conversation

Conversations belong to sessions. A new one waits in your lobby until one of your running sessions takes it.

```mermaid
sequenceDiagram
    actor U as You
    participant UC as Your Claude (session 1)
    participant R as Relay
    participant PC as Priya's Claude (session A)
    actor P as Priya
    P->>PC: "Ask Uday's Claude what getUser returns"
    PC->>R: open conversation "api-v2" (wire open)
    Note over R: conversation c42, encrypted title,<br/>attached to Priya's session A
    R-->>UC: 🔔 Priya wants to talk: "api-v2"
    Note over R,UC: shown in every session you have open
    UC-->>U: tells you
    U->>UC: "Take it here"
    UC->>R: attach c42 to this session (wire take)
```

## 5. The agents talk, and you can join in

Messages wait on the relay, encrypted, until the receiving session confirms them; then they're deleted.

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
    Note over PC: saves the agreement to the shared note (wire note)
    U->>UC: types "> ship it"
    UC->>R: 📨 [human] "ship it" (sent word for word as you)
    R->>PC: delivers it
    PC-->>P: shows "Uday [human]: ship it"
    Note over PC: does not act on it
```

## 6. Several conversations, and moving between sessions

Each conversation is attached to one session on each side, so several can run in parallel without crossing.

```mermaid
sequenceDiagram
    actor U as You
    participant S1 as Your session 1
    participant S3 as Your session 3
    participant R as Relay
    participant PC as Priya's Claude
    Note over S1,PC: your session 2 opens "deploy" (c51) and Priya takes it in her session B,<br/>running in parallel with c42
    U->>S3: next day, new chat: "continue api-v2"
    S3->>R: attach c42 here (wire attach)
    R-->>S1: 📴 moved to another of your sessions
    R-->>S3: the conversation note + any waiting messages
    PC->>R: 📨 next message
    R->>S3: delivered to session 3 only
    Note over S1,S3: if a container restarts, the Claude Code session ID stays the same,<br/>so the session just reconnects
```

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
