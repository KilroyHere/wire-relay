# wire: what is left

Done so far: phase 1 of [docs/PLAN.md](docs/PLAN.md), plus the review fixes, setup work and docs (A–F) below.
Everything still open is under **Next** and **Later**.

## Done in this round

- **A. Review bugs.** A pairing can only be created through `/pairs` with the owner token, so the public
  `init` route is gone. Each message is confirmed by its exact id after it is processed, using a seen-set
  instead of a cursor, so an older message in a conversation taken later is no longer skipped and deleted.
  *Delivered* is shown per message. One pairing's presence no longer shows in another. Each of these has an
  e2e test that fails on the old code.
- **B. Owner setup.**
  - `WIRE_OWNER_TOKEN=<token>@<relay host>` is read from the environment. `wire owner` checks the relay
    (`GET /`) and the token (`POST /owner/check`) before saving.
  - `wire invite` picks up the variable by itself.
  - `WIRE_SEED` is validated, and no message prints it or a host taken from it, curl errors included.
  - New commands: `wire help owner`, and `wire owner-share`, which writes the token line to a 0600 file.
- **C. What the agent knows.** The plugin's "not set up" note covers joining and becoming an owner. The
  rules say to ask the user for names and relay URLs, and never to print the seed or tokens.
- **D. Invite page and first run.** The invite page now covers:
  - what wire is and that it needs Claude Code
  - the 7-day expiry
  - how to use it, plus a safety note
  - `claude plugin update wire@wire`, and the new-session note

  `wire join` tells the person how to use it and how to keep the pairing (`WIRE_SEED` with the real relay host).
- **E. `wire doctor` and `/wire doctor`.** They check:
  - node and curl
  - identity
  - `WIRE_SEED` and the vault
  - the owner token
  - each relay and its client version
  - each pairing
  - the listener and the PATH

  Each failing check comes with its fix, and `wire doctor` exits 1 when something is wrong.

- **F. Docs.** README sections "Setting up a cloud environment" (variables, setup script, network, `wire doctor`)
  and "Adding another account as owner" (`wire owner-share`; same `WIRE_SEED` = same person, another = a
  separate identity). The plugin README shows the setup script and variables. docs/FLOW.md step 1 shows
  `wire owner` checking the relay and token, and `wire doctor`.

## Later

### G. Product

- [ ] "Needs a reply" marks on tabs, with the latest-message previews sorted by what is waiting on you.
- [ ] Per-account owner tokens: several tokens per relay (named, revocable one by one), instead of one shared
      `OWNER_TOKEN` copied to every account.
- [ ] Split `plugin/hooks/register.tsx` into modules (panel drawing, listener, commands, rules); it is near
      900 lines.

### G. Relay

- [ ] Per-IP rate limits are weak behind shared egress (cloud sandboxes share proxy IPs): consider limits keyed
      on the pairing or vault id as well, so one busy neighbour cannot exhaust another's claims.
- [ ] After `wrangler deploy`, a pairing's Durable Object keeps old code while streams stay open, so new
      actions answer "unknown action" until they reconnect. Option: the stream sends its code version and the
      client reconnects on a mismatch, or the DO closes streams when it sees a newer version.

### Phase 2: the safety guards (docs/PLAN.md §4, §9 step 7)

- [ ] **D5** The tool boundary: during a turn the other Claude started, only the plugin's own `wire_send` /
      `wire_note` tools for that conversation; everything else waits for the person.
- [ ] **D4** Turns started by the other Claude carry fixed plugin text; the peer's words go in context, marked
      untrusted. The same for notes the other side wrote (D11).
- [ ] **D6** Turn cap: pause after 4 Claude-to-Claude exchanges with no message from this side's person, or
      20 such turns an hour; shown in the panel, never silent.
- [ ] **D12** Approve / Deny cards in the panel, drawn from the actual tool call.
