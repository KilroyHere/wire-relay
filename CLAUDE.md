# wire-relay

- `relay/src/index.js`: Cloudflare Worker + `PairV2` Durable Object (one per pairing of two people). Plain
  HTTPS only — no WebSockets — because Claude Code cloud sandboxes reach the internet through an HTTP proxy
  that does not support WebSocket upgrades.
- `plugin/client/wire.mjs`: single-file Node client, no dependencies, uses `curl` for transport (honours the
  proxy). It is bundled into the Worker as text and served at `/wire.mjs`; bump `VERSION` when it changes.
- Everything stored on the relay is ciphertext or hashes. Never log request bodies or tokens in the Worker.
- Durable Object schema changes need a new class + migration in `wrangler.jsonc`.
- `Vault` Durable Object: one encrypted identity blob per `WIRE_SEED`; changes to identity or contacts in the
  client go through `commit()` so the vault stays in sync.
- `plugin/`: the Claude Code plugin (listed by `.claude-plugin/marketplace.json`). `hooks/register.tsx` runs
  the listener, sends `>` lines, draws the pane. After changing it: `claude plugin validate plugin` and
  `claude plugin test plugin`.
- Run `npm test` (starts `wrangler dev` and runs `test/e2e.sh`) after any change to relay or client.
- `npm run test:plugin` validates the plugin and runs its tests. `test/panel-view.sh start [COLS] [ROWS]` runs a
  second Claude Code in tmux with this plugin so you can look at and use the real panel (`shot --panel`); check
  panel changes there at 80x30, 120x40 and 200x50.
- Lessons learned the hard way:
  - A `ui.render` hook must not write plugin state (`update`, `$.state`): the engine refuses it and skips the
    whole drawing. Keep per-view counters in module variables.
  - `session.start` does not run when the plugin loads into a session already under way (installed or updated
    mid-session); the listener is started from any hook through `ensureListening`.
  - `claude plugin install` does nothing when the plugin is already installed; updates need
    `claude plugin update wire@wire`.
  - After `wrangler deploy`, a pairing's Durable Object can keep running the old code while sessions hold
    their streams open; a new relay action can answer "unknown action" until those reconnect.
  - Bump the plugin's `version` in `plugin/.claude-plugin/plugin.json` with every plugin change, and the
    client's `VERSION` with every client change (the relay tells older clients to update).
- Never commit `.dev.vars`, owner tokens, account ids, or anyone's `contacts.json` / backups.
