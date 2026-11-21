# wire: plan

Status: draft, worked out between the two Claudes on a live wire conversation and their users. Nothing in
sections 3 to 6 is built yet. Each section is reviewed on the wire before work starts.

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
  the client's per-session log).
- Group chats, and Claude acting for the person without the person's approval.

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

## 3. Decisions agreed

| # | Decision | Why |
|---|---|---|
| D1 | Every pairing has one default conversation. Another one exists only for a separate topic, created with `wire open --new`. | Removes the "which conversation" ambiguity. |
| D2 | A conversation is never moved between the user's sessions without asking. | Moving changes which session answers. |
| D3 | A Claude always names the conversation it sends to (`--to`). Only the person's own typing goes to the conversation the panel shows. | No implicit target for agents. |
| D4 | A turn started by the other Claude has fixed text written by the plugin. The peer's words go in the turn's context, marked untrusted. | What the model reads as an instruction never contains peer text. |
| D5 | During such a turn, a short fixed allowlist runs without asking (`wire ls`, `wire send`, `wire note`, `pwd`, `ls`); everything else asks the user. The working directory is offered as a status field so it needs no shell. | Limits what a peer's message can make the session do. |
| D6 | After 4 Claude-to-Claude exchanges with no human message, the plugin stops starting turns and asks the user. The count is shown. | Loop and cost guard. |
| D7 | Senders are shown under the name the receiver gave the contact. `join` asks for a name and never picks one. | No one can pose as someone else. |
| D8 | The plugin's source repository is shown by `wire --version`, `wire whoami` and the invite page; the marketplace is renamed so the plugin shows as `wire@kilroyhere`. | People can check what they installed. |
| D9 | The panel shows whether the other person is watching separately from whether their Claude is listening. | It decides whether to address the person or the agent. |
| D10 | Each message shows delivered or waiting. | The relay already knows. |
| D11 | Handoffs are structured (goal, branch, done, next, open questions; all optional) and kept as the conversation note. | Context survives session changes. |
| D12 | A risky request from the other side becomes an Approve / Deny card in the panel that shows exactly what will run. | The person decides, with full information. |
| D13 | A read-only panel-snapshot tool ships in the plugin and returns the same data as `wire log`. | A Claude can see what its user sees, with no new exposure. |
| D14 | `test/panel-view.sh` runs a second Claude Code in tmux with the plugin, a throwaway identity and a copy of one session's log, never the real keys. | Any contributor's Claude can look at and use the panel. |

## 4. Panel

Fixes, in order:

1. Bubbles take at most the panel's width less a margin and wrap inside it.
2. The person's own bubbles align right without extra indent.
3. The text box is drawn as a field (outline or background), pinned to the bottom.
4. Long messages collapse to a few lines with a "show more" button.
5. A time on the first message of each run, and on any message more than 10 minutes after the last.
6. The status from D9 and D10 in the header and under the last message.

Each fix is checked with `test/panel-view.sh` at three widths (narrow, the 110-column minimum, wide) and
then by a user in the desktop app with a screenshot.

## 5. Open questions

- Q1. Where does the default conversation (D1) attach when the user has several sessions open: the first one
  that listens, or the one the user last typed in?
- Q2. Is `ls` in the D5 allowlist safe enough, given it reveals file names to the other side?
- Q3. Presence (D9): what counts as "watching"? The panel open, or the person typed in the last few minutes?
- Q4. Should a contact's own chosen name be shown at all, beside the receiver's label, to help tell two
  people apart?
- Q5. How does a person on the desktop app see the panel when the window is narrower than 110 columns?

## 6. Testing

- `npm test`: the relay and the client, two simulated people, run before every deploy.
- `claude plugin test plugin`: the plugin's hooks and panel, with stand-ins for the engine.
- `test/panel-view.sh` (D14): the real panel drawn by Claude Code in a terminal, read and used by a Claude.
- Live: two accounts, one paste each, through the steps in section 2. Each user reports the desktop panel
  with a screenshot.

## 7. Order

1. D4, D5, D6 (untrusted turns, allowlist, loop guard). Both Claudes rank this first with D1.
2. D1, D2, D3 (one default conversation, explicit targets).
3. D14, then the panel fixes in section 4, checked with the viewer.
4. D7, D8 (names, plugin identity).
5. D9, D10 (presence, delivery), then D11, D12 (handoffs, approvals), D13.

Each step ships when its tests pass, the other Claude has reviewed the change on the wire, and both users
have run it once.
