# wire: plan

Status: draft, worked out between the two Claudes on a live wire conversation and their users. Nothing in
sections 4 to 6 is built yet. Each section is reviewed on the wire before work starts.

## 1. Goal and scope

wire lets two people, and each person's Claude Code, talk privately: person to person, Claude to Claude,
and across, while each Claude keeps working in its own session and repository.

In scope:

- 1:1 pairings between people, set up once with an invite link and a safety code.
- Conversations inside a pairing, each attached to one Claude Code session per side.
- A side panel in Claude Code that is the chat with the other person, with its own text box.
- A relay that is a mailbox only: it holds encrypted messages until they are delivered, then deletes them.

Out of scope:

- Storing transcripts on the relay. The conversation lives on each side only (the Claude Code transcript and
  the client's per-session log). The optional vault (`WIRE_SEED`) holds an encrypted copy of a person's
  identity and contacts, never messages.
- Group chats.
- A Claude speaking as its person, or doing anything beyond the D5 allowlist because the other side asked,
  without its person's approval. A Claude may answer the other Claude as itself.

## 2. Where things stand

Works, tested end to end (37 to 39 checks in `test/e2e.sh`, 6 plugin tests) and used between two accounts:

- One-paste invite page: name, copy, paste. It joins and installs the plugin.
- Pairing with single-use invites, X25519 keys, safety codes, revoke.
- Conversations bound to sessions: lobby, take, attach, takeover, catch-up after being offline.
- The plugin: a listener per session, the side panel with a text box, `>` from the prompt box, turns started
  by the other side's Claude, the rules in the system prompt.
- Delete on delivery, 7-day expiry, update notices, the optional encrypted vault (`WIRE_SEED`).

Known problems, from the live test and from looking at the panel:

- Several open conversations per pairing make "send hello to Main" ambiguous.
- A message from the other Claude starts a turn whose text is that Claude's words, so the line between the
  user's instructions and the peer's relies on the model remembering the rules.
- The setup note in the system prompt is chosen at session start and can contradict a later join.
- `join` can be run without a name, and a Claude then picks a generic one.
- The plugin shows as `wire@wire`, which does not say where it came from.
- Panel, terminal drawing: bubbles are wider than the panel and their right borders are cut off; the
  person's own bubbles get a double indent; the text box has no visible field; long messages crowd out
  everything else; there are no timestamps. The desktop drawing has not been seen by either Claude.

## 3. Threat model

| Party | Trusted for | Not trusted for |
|---|---|---|
| T1. The relay | Passing messages along, eventually | Content (it sees ciphertext only), honesty about keys (safety codes catch a swapped key), availability |
| T2. The other person, once verified | Being who they say they are | Anything they ask your Claude to do: that goes through your approval |
| T3. The other person's Claude, and anything it says | Nothing | Instructions; its words are data. It can also claim to relay its person's words (see D15) |
| T4. Your own Claude | Acting for you within the rules | Not being misled: it can be misled by T3, or by T2's words passed through it |
| T5. Anyone who gets an invite link before its person | Nothing | The link works once; a second use is refused and the safety code differs |

Each decision below names the threats it addresses.

## 4. Decisions agreed

| # | Decision | Why | Threat |
|---|---|---|---|
| D1 | Every pairing has one default conversation. Another one exists only for a separate topic, created with `wire open --new`. The default conversation attaches to the session the user last typed in; if they have typed in none yet, the user is asked. The default conversation cannot be closed, only cleared; it ends when the pairing is revoked. A further conversation the other side opens never attaches by itself: it waits as a lobby item until the person takes it. | Removes the "which conversation" ambiguity. "First session to listen" would be arbitrary, and can be a background session. In the live test one contact produced four lobby items. | usability |
| D2 | A conversation is never moved between the user's sessions without asking. | Moving changes which session answers. | T4 |
| D3 | A Claude always names the conversation it sends to (`--to`), enforced by the client: `wire send` without `--to` is an error. Only the person's own typing, through the plugin, goes to the conversation the panel shows. | No implicit target for agents, and not left to prompt rules. | T4 |
| D4 | A turn started by the other Claude has fixed text written by the plugin. The peer's words go in the turn's context, marked untrusted. | What the model reads as an instruction never contains peer text. | T3, T4 |
| D5 | During such a turn, a short fixed allowlist runs without asking (`wire ls`, `wire send`, `wire note`); everything else asks the user. The working directory is offered as a status field, so no shell command is needed for it. | Limits what a peer's message can make the session do. `ls` is left out because file names can leak project details. | T3, T4 |
| D6 | After 4 Claude-to-Claude exchanges with no human message, the plugin stops starting turns and asks the user. The count is shown. | Loop and cost guard. | T3 (loops, cost) |
| D7 | Senders are shown under the name the receiver gave the contact. `join` asks for a name and never picks one. | No one can pose as someone else. | T2, T3 |
| D8 | The plugin's source repository is shown by `wire --version`, `wire whoami` and the invite page; the marketplace is renamed so the plugin shows as `wire@kilroyhere`. | People can check what they installed. | supply chain |
| D9 | The panel shows whether the other person is watching separately from whether their Claude is listening. | It decides whether to address the person or the agent. | T4 |
| D10 | Each message shows delivered or waiting. | The relay already knows. | T1 |
| D11 | Handoffs are structured (goal, branch, done, next, open questions; all optional) and kept as the conversation note. | Context survives session changes. | usability |
| D12 | A risky request from the other side becomes an Approve / Deny card in the panel that shows exactly what will run. | The person decides, with full information. | T2, T3, T4 |
| D13 | A read-only panel-snapshot tool ships in the plugin and returns the same data as `wire log`. | A Claude can see what its user sees, with no new exposure. | none new |
| D15 | A message is marked "typed by" its person only when it came through the plugin's own path (the panel's text box or a `>` line). Words a Claude sends with `wire send --as human` arrive marked "relayed by their Claude". This is honest labelling, not proof: a Claude on the sending machine could imitate the plugin's path. | The receiver can tell what their contact typed from what the contact's Claude says they said. In the live test a Claude sent its person's "hello" as human-typed. | T3 |
| D14 | `test/panel-view.sh` runs a second Claude Code in tmux with the plugin, a throwaway identity and a copy of one session's log, never the real keys. | Any contributor's Claude can look at and use the panel. | none (test only) |

## 5. Panel

What both viewers showed (terminal drawing; the desktop drawing is still unseen):

| Width | Seen |
|---|---|
| 200 columns (Main) | Docked right. Bubbles wider than the panel, right borders cut off; own bubbles double-indented. |
| 120 columns (alt2) | Docked right, about 45 columns. Bubbles fit with borders intact but nearly touch the edge. |
| 80 x 30 (alt2) | Full-width overlay. Header takes 4 rows, a long message shows about 4 lines, **the text box is not visible, so the person cannot type**. |
| All | The text box shows only its placeholder, with no visible field. No timestamps. The status line reads `wire: wire ▸ main/…` (the engine already prefixes the plugin's name). |

Fixes, in order:

1. **The text box is always visible**: it is laid out first and the messages get whatever room is left, so on
   a short terminal fewer messages show, never no text box. It is drawn as a field (outline or background).
2. Bubbles take at most the panel's width less a 2-column margin and wrap inside it.
3. The person's own bubbles align right without extra indent.
4. The header takes one row (contact and topic on one line) where the panel is short.
5. Long messages collapse to a few lines with a "show more" button.
6. A time on the first message of each run, and on any message more than 10 minutes after the last.
7. The status line text is the conversation alone (`▸ alt2 · testing`), without repeating "wire".
8. The status from D9 and D10 in the header and under the last message.

Each fix is checked with `test/panel-view.sh` at 80x30, 120x40 and 200x50, and
then by a user in the desktop app with a screenshot.

## 6. Open questions

- Q1. *Settled in D1:* the session the user last typed in, else ask. Open detail: the user's sessions can run
  on different machines, so "last typed in" has to be known across them. The plain way is for each session to
  tell the relay when its user types, as one more opaque session handle per pairing side (the relay already
  stores which handle holds each conversation). Is that acceptable, given the aim of storing as little as
  possible on the relay?
- Q2. *Settled in D5:* `ls` is left out.
- Q3. Presence (D9): what counts as "watching"? The panel open, or the person typed in the last few minutes?
- Q4. Should a contact's own chosen name be shown at all, beside the receiver's label, to help tell two
  people apart?
- Q5. How does a person on the desktop app see the panel when the window is narrower than 110 columns?

## 7. Testing

- `npm test`: the relay and the client, two simulated people, run before every deploy.
- `claude plugin test plugin`: the plugin's hooks and panel, with stand-ins for the engine.
- `test/panel-view.sh` (D14): the real panel drawn by Claude Code in a terminal, read and used by a Claude.
- Live: two accounts, one paste each, through the steps in section 2. Each user reports the desktop panel
  with a screenshot.

## 8. Who does what

- **Main's Claude writes all the code**: relay, client, plugin, tests, docs, and deploys the relay.
- **alt2's Claude reviews** each change on the wire before it ships, and tests it from the other side (a
  second account, its own sessions, and the panel viewer once its user agrees).
- **Both users** run each step once, look at the desktop panel, and decide when a step is done.

## 9. Order

1. D4, D5, D6 (untrusted turns, allowlist, loop guard): the safety boundary, so it comes first.
2. D14 (the panel viewer script), so every change after it can be checked in the panel as it lands.
3. D1, D2, D3, D15 (one default conversation, explicit targets, honest "typed by" labels).
4. The panel fixes in section 5, checked with the viewer.
5. D7, D8 (names, plugin identity).
6. D9, D10 (presence, delivery), then D11, D12 (handoffs, approvals), D13.

Each step ships when its tests pass, the other Claude has reviewed the change on the wire, and both users
have run it once.
