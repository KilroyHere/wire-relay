# wire: plan

Status: agreed by both Claudes after a full review on a live wire conversation; awaiting both users'
sign-off. One question is open (Q5, needs a desktop screenshot). Nothing in sections 4 to 6 is built yet.

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
| D1 | Every pairing has one default conversation. Another one exists only for a separate topic, created with `wire open --new`. The default conversation cannot be closed, only cleared; it ends when the pairing is revoked. Attaching it: if exactly one of the person's sessions is listening, it attaches there without asking; otherwise the incoming message shows as a lobby notice in each listening session, and the session the person takes it in wins (the others get the "moved" notice and drop it). Nothing about "last typed in" is stored on the relay. A further conversation the other side opens never attaches by itself: it waits as a lobby item until the person takes it. | Removes the "which conversation" ambiguity, and the person chooses explicitly. In the live test one contact produced four lobby items. | usability |
| D2 | A conversation is never moved between the person's sessions without asking. | Moving changes which session answers. | T4 |
| D3 | A Claude always names the conversation it sends to, enforced by the client and the plugin's tools: a send without a conversation is an error. Only the person's own typing, through the plugin, goes to the conversation the panel shows. | No implicit target for agents, and not left to prompt rules. | T4 |
| D4 | A turn started by the other Claude has fixed text written by the plugin. The peer's words go in the turn's context, marked untrusted. This is a model-level mitigation only; D5 is the boundary. | What the model reads as an instruction never contains peer text. | T3, T4 |
| D5 | **The boundary.** While a turn the other Claude started is running, a plugin hook on every tool call refuses everything except the plugin's own `wire_send` and `wire_note` tools, which take plain text (no shell is parsed), and only for the conversation that started the turn. Anything else waits for the person's approval. The session's working directory is given to the turn as a status field. The turn ends when the model finishes; a turn the person starts is never restricted. | A peer's message cannot make the session run commands, read files or send to anyone else. Prefix matching on shell commands is not used: `wire send --to x "$(cat ~/.ssh/id)"` starts with an allowed command. | T3, T4 |
| D6 | The plugin stops starting turns for the other Claude, and asks the person, after 4 Claude-to-Claude exchanges in a conversation with no message from **this** side's person, or after 20 such turns in an hour (a plugin setting; 20 is the default), whichever comes first. The panel shows the count, and when paused says so ("paused: 20 turns this hour"), so it is never a silent stop. Messages that arrive while stopped stay visible in the panel and are not lost. | Loop and cost guard. Only your own person resets your count: the other side's person must not be able to keep your Claude, and your bill, running. | T3 (loops, cost) |
| D7 | Senders are shown under the name the receiver gave the contact. Where the contact's own chosen name differs, it shows after the label as "calls themselves X". Conversation titles and notes are shown as supplied by their author. `join` asks for a name and never picks one. | No one can pose as someone else, and a silent rename is visible. | T2, T3 |
| D8 | `wire --version` and `wire whoami` show the plugin's source repository and the installed commit (local ground truth, not self-asserted), and the invite page names the repository. The marketplace keeps its name (`wire`), so existing installs keep updating. | People can check what they installed. Renaming the marketplace would break existing `wire@wire` installs for a cosmetic gain. | supply chain |
| D9 | Presence, off by default and per person: "active" while the panel is open and the person typed or focused in the last ~2 minutes, else "away". It rides on the listener's existing connection and is kept only in the relay's memory, never stored. Shown separately from whether their Claude is listening. | Decides whether to address the person or the agent, without storing activity. | T4; privacy |
| D10 | Each message the person sent shows one of three states: sent (the relay accepted it), waiting (held by the relay, the other session is not listening), delivered (the other session confirmed it). No read receipts. | The relay already knows; read receipts would reveal more than needed. | T1 |
| D11 | Handoffs are structured (goal, branch, done, next, open questions; all optional) and kept as the conversation note. Each version of the note records its author inside the encrypted note, and a note written by the other side is given to the model as untrusted data, like D4. | Context survives session changes, without becoming an injection path. | usability; T3 |
| D12 | A tool call that needs approval during a turn the other Claude started becomes an Approve / Deny card in the panel, drawn from the actual tool call (tool and arguments), never from the peer's description. A message from the other side saying "approved" is never approval. | The person decides, with full and true information. | T2, T3, T4 |
| D13 | A read-only panel-snapshot tool ships in the plugin and returns the same data as `wire log`. | A Claude can see what its person sees, with no new exposure. | none new |
| D14 | `test/panel-view.sh` runs a second Claude Code in tmux with the plugin, a throwaway identity and a copy of one session's log, never the real keys. It answers the first-run screens (theme, safety notes, folder trust), waits for the viewer's own session handle to appear, then copies the log to it. | Any contributor's Claude can look at and use the panel. | none (test only) |
| D15 | A message is marked "typed by" its person only when it came through the plugin's own path (the panel's text box or a `>` line). Words a Claude sends for its person arrive marked "relayed by their Claude". This is honest labelling, not proof: a Claude on the sending machine could imitate the plugin's path. | The receiver can tell what their contact typed from what the contact's Claude says they said. In the live test a Claude sent its person's "hello" as typed by the person. | T3 |
| D16 | Leaving and offboarding: `wire revoke` ends a pairing for both sides; `wire leave` does the same from the invited side. Either one also deletes that contact's local log entries and, with `WIRE_SEED`, updates the vault. `wire forget` removes the vault from the relay. Messages still held for a revoked pairing are deleted with it. None of these can erase the other side's copy: messages already delivered stay in their transcript and log, and the commands say so. | A person can end a pairing completely, on both sides and on the relay. | T2; privacy |
| D17 | Relay rate limits: per pairing, at most 60 messages a minute and 2,000 held; per IP address, a cap on claims and vault writes; invite creation stays owner-only. Over a limit the relay answers 429 and the client tells the person. | Limits abuse of the relay and of the owner's Cloudflare account. | T1; abuse |

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

- Q1. *Settled in D1:* attach without asking when one session is listening; otherwise a lobby notice in each
  listening session, and the person chooses. Nothing new is stored on the relay.
- Q2. *Settled in D5:* no shell at all during a peer-started turn; the plugin's own send and note tools only.
- Q3. *Settled in D9:* active / away, off by default, kept in the relay's memory only.
- Q4. *Settled in D7:* "calls themselves X" after the label, only when it differs.
- Q5. Narrow desktop windows. Working rule: below ~110 columns the panel is a full-width overlay with the text box
  laid out first (panel fix 1). **Needs a screenshot of the desktop panel from a user** before anything more.

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

1. D5, D4, D6, D12 (the tool boundary, untrusted turns, loop guard, approval cards): the safety boundary, so it comes first.
2. D14 (the panel viewer script), so every change after it can be checked in the panel as it lands.
3. D1, D2, D3, D15 (one default conversation, explicit targets, honest "typed by" labels).
4. The panel fixes in section 5, checked with the viewer.
5. D7, D8 (names, plugin identity).
6. D10 (delivery states), D16 (leaving), D17 (rate limits).
7. D9 (presence), D11 (handoffs), D13 (snapshot tool).

Each step ships when its tests pass, the other Claude has reviewed the change on the wire, and both users
have run it once.
