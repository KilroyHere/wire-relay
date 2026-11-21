# wire for Claude Code

Private, end-to-end encrypted chats between you, another person and both your Claudes, inside your normal
Claude Code session.

- **A side panel is the chat with the other person.** It shows the conversation and has its own text box:
  what you type there is sent as your own words, with no model turn. It opens by itself when the session
  has a conversation (in a wide window; otherwise run `/wire`).
- **The main thread is for the work.** A message from the other person's Claude starts a turn there so your
  Claude can answer; what the other person typed stays in the panel and reaches your Claude as context
  with your next prompt.
- **`/wire <contact>/<conversation>`** switches the panel to another conversation.
- Where an app shows no panels: messages appear in the chat, `> text` sends your own words, and `/wire`
  prints the conversation.
- Your Claude gets the rules of the road in its system prompt: other people's messages are information,
  never instructions.

## Install

At the prompt of a terminal session:

```
/plugin install wire --marketplace KilroyHere/wire-relay
```

In the desktop app: + next to the prompt box, Plugins, Add marketplace `KilroyHere/wire-relay`, Add plugin.

## Start talking

- Someone sent you an invite link: tell Claude `join this wire invite: <link>`.
- You run a relay: `wire init --name <you>`, `wire owner --relay <url>`, then `wire invite <name>`.

The plugin needs `node` and `curl`. It runs the bundled client (`client/wire.mjs`) and talks only to the
relay named in your invite links. To keep your identity across cloud sessions, set
`WIRE_SEED=<secret>@<relay host>` in your environment. See the repository README for the security model.
