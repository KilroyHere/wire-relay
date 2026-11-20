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
- Never commit `.dev.vars`, owner tokens, account ids, or anyone's `contacts.json` / backups.
