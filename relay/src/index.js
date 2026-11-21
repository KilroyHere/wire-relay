// wire relay v2 — a mailbox per pairing of two people, with conversations bound to sessions.
//
// Trust is person<->person (one pairing = one Durable Object, created only by the relay owner and
// claimed once by the invitee). Conversations live inside a pairing; each side attaches a conversation
// to one session handle at a time. The relay stores only ciphertext (titles, notes, messages are
// encrypted client-side), hashes of member tokens, and the two public keys.
//
// Plain HTTPS only (no WebSockets) so it works through egress proxies.
//   GET  /i#...                       invite page (the secret stays in the URL fragment, never sent here).
//                                     With PLUGIN_SOURCE set (owner/repo), its one paste also installs the plugin.
//   GET  /wire.mjs, /v/<ver>/wire.mjs  the client this relay was deployed with; /wire.mjs.sha256 its checksum
//   POST /pairs                       (x-wire-owner)            create a pairing (owner only)
//   POST /p/<pair>/claim              {invite, pub_b, tok_b}    invitee claims the pairing, once
//   member endpoints (x-wire-side: a|b, x-wire-token):
//   GET  /p/<pair>/stream?handle=&since=   NDJSON event stream for one session
//   POST /p/<pair>/open    {conv, title, handle}
//   POST /p/<pair>/attach  {conv, handle}
//   POST /p/<pair>/send    {conv, body}
//   POST /p/<pair>/ack     {handle, upto}
//   POST /p/<pair>/note    {conv, note?}
//   POST /p/<pair>/convs   {}
//   POST /p/<pair>/close   {conv}
//   POST /p/<pair>/revoke  {}
//   vault (x-wire-vault-token; an encrypted copy of a person's identity + contacts, so new sessions can restore it):
//   POST /vault/<id>/get   {}
//   POST /vault/<id>/put   {data, if_version?}   creating one needs the owner token or a pairing's member headers
import { DurableObject } from 'cloudflare:workers';
import CLIENT from '../../plugin/client/wire.mjs'; // bundled as text (see "rules" in wrangler.jsonc)

const CLIENT_VERSION = CLIENT.match(/const VERSION = '([^']+)'/)[1];
let clientSha;
async function clientSha256() {
  if (!clientSha) clientSha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CLIENT)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return clientSha;
}

const DAY = 86400000;
const MSG_TTL = 7 * DAY;          // undelivered messages expire after 7 days
const INVITE_TTL = 7 * DAY;       // unclaimed invites expire after 7 days
const MAX_BODY = 16 * 1024;       // one encrypted message
const MAX_META = 8 * 1024;        // encrypted title / note
const MAX_PENDING = 2000;         // per pairing
const MAX_STREAMS = 8;            // per side
const MAX_OPEN_CONVS = 200;       // per pairing
const MAX_VAULT = 256 * 1024;     // one encrypted identity blob
const ID = /^[A-Za-z0-9_-]{6,64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const PUB = /^[A-Za-z0-9_-]{43}$/;

const te = new TextEncoder();
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', te.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function safeEq(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', te.encode(a)), crypto.subtle.digest('SHA-256', te.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}
const readJson = async (req) => { try { return await req.json(); } catch { return null; } };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response(`wire relay v2 · client ${CLIENT_VERSION}\n`);
    if (url.pathname === '/wire.mjs' || url.pathname === `/v/${CLIENT_VERSION}/wire.mjs`)
      return new Response(CLIENT, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'x-wire-sha256': await clientSha256() } });
    if (url.pathname === '/wire.mjs.sha256') return new Response(`${await clientSha256()}  wire.mjs\n`);
    if (url.pathname === '/i')
      return new Response(INVITE_HTML.replaceAll('__VER__', CLIENT_VERSION).replaceAll('__SHA__', await clientSha256())
        .replaceAll('__PLUGIN__', /^[\w.-]+\/[\w.-]+$/.test(env.PLUGIN_SOURCE || '') ? env.PLUGIN_SOURCE : ''),
        { headers: { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' } });
    if (url.pathname === '/pairs' && req.method === 'POST') {
      const tok = req.headers.get('x-wire-owner') || '';
      if (!env.OWNER_TOKEN || !tok || !(await safeEq(tok, env.OWNER_TOKEN))) return json({ error: 'not owner' }, 401);
      const b = await readJson(req);
      if (!b || !ID.test(b.pair || '')) return json({ error: 'bad pair id' }, 400);
      const stub = env.PAIR.get(env.PAIR.idFromName(b.pair));
      return stub.fetch(new Request('https://do/init', { method: 'POST', body: JSON.stringify(b) }));
    }
    const vm = url.pathname.match(/^\/vault\/([A-Za-z0-9_-]{24,64})\/(get|put)$/);
    if (vm && req.method === 'POST') return vault(req, env, vm[1], vm[2]);
    const m = url.pathname.match(/^\/p\/([A-Za-z0-9_-]{6,64})\/([a-z]+)$/);
    if (!m) return json({ error: 'not found' }, 404);
    return env.PAIR.get(env.PAIR.idFromName(m[1])).fetch(req);
  },
};

// A vault is addressed and authenticated by values derived from the owner's WIRE_SEED. Anyone holding the
// token may read or replace it; creating a new one is limited to the relay owner and paired members, so the
// relay cannot be used as free storage by strangers.
async function vault(req, env, id, action) {
  const b = (await readJson(req)) || {};
  const token = req.headers.get('x-wire-vault-token') || '';
  if (!token) return json({ error: 'unauthorized' }, 401);
  const stub = env.VAULT.get(env.VAULT.idFromName(id));
  const ask = (creator_ok) => stub.fetch(new Request(`https://do/${action}`, {
    method: 'POST', body: JSON.stringify({ token, data: b.data, if_version: b.if_version, creator_ok }),
  }));
  const r = await ask(false);
  if (r.status !== 428) return r;
  let ok = false;
  const owner = req.headers.get('x-wire-owner') || '';
  if (owner && env.OWNER_TOKEN && (await safeEq(owner, env.OWNER_TOKEN))) ok = true;
  const pair = req.headers.get('x-wire-pair') || '';
  if (!ok && ID.test(pair)) {
    const pr = await env.PAIR.get(env.PAIR.idFromName(pair)).fetch(new Request('https://do/convs', {
      method: 'POST', body: '{}',
      headers: { 'x-wire-side': req.headers.get('x-wire-side') || '', 'x-wire-token': req.headers.get('x-wire-token') || '' },
    }));
    ok = pr.status === 200;
  }
  return ok ? ask(true) : json({ error: 'only the relay owner or a paired member can create a vault here' }, 403);
}

export class Vault extends DurableObject {
  async fetch(req) {
    const action = new URL(req.url).pathname.slice(1), b = (await readJson(req)) || {};
    const row = await this.ctx.storage.get('vault'); // reading a missing key stores nothing
    if (row && row.tok !== (await sha(b.token || ''))) return json({ error: 'unauthorized' }, 401);
    if (action === 'get') return row ? json({ v: row.v, data: row.data }) : json({ error: 'no vault' }, 404);
    if (typeof b.data !== 'string' || !b.data || b.data.length > MAX_VAULT) return json({ error: 'bad data' }, 400);
    if (!row && !b.creator_ok) return json({ error: 'create not allowed' }, 428);
    if (row && b.if_version != null && Number(b.if_version) !== row.v) return json({ error: 'version', v: row.v }, 409);
    const v = (row ? row.v : 0) + 1;
    await this.ctx.storage.put('vault', { tok: row ? row.tok : await sha(b.token), v, data: b.data, updated: Date.now() });
    return json({ v });
  }
}

export class PairV2 extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Tables exist only for pairings the owner created; a request for an unknown pairing stores nothing.
    this.ready = this.sql.exec(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).one().n > 0;
    this.streams = new Map(); // `${side}:${handle}` -> { side, handle, write, close }
  }

  schema() {
    this.ready = true;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS conv (id TEXT PRIMARY KEY, title TEXT, opener TEXT, created INTEGER,
      last INTEGER, closed INTEGER DEFAULT 0, note TEXT, att_a TEXT, att_b TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS msg (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, sender TEXT, body TEXT, ts INTEGER)`);
  }

  get(k) { if (!this.ready) return null; const r = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0]; return r ? r.v : null; }
  set(k, v) { this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`, k, String(v)); }
  conv(id) { return this.sql.exec(`SELECT * FROM conv WHERE id = ?`, id).toArray()[0]; }
  push(side, ev, handle) {
    for (const s of this.streams.values()) if (s.side === side && (handle === undefined || s.handle === handle)) s.write(ev);
  }
  async ensureAlarm(at) {
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || at < cur) await this.ctx.storage.setAlarm(at);
  }

  async fetch(req) {
    const url = new URL(req.url);
    const action = url.hostname === 'do' ? url.pathname.slice(1) : url.pathname.split('/')[3];
    if (action === 'init') return this.init(await readJson(req));
    if (!this.get('created')) return json({ error: 'no such pairing' }, 404);
    if (action === 'claim' && req.method === 'POST') return this.claim(await readJson(req));

    const side = req.headers.get('x-wire-side');
    if (side !== 'a' && side !== 'b') return json({ error: 'bad side' }, 400);
    const want = this.get('tok_' + side), tok = req.headers.get('x-wire-token') || '';
    if (!want || !tok || want !== (await sha(tok))) return json({ error: 'unauthorized' }, 401);
    const other = side === 'a' ? 'b' : 'a';

    if (action === 'stream' && req.method === 'GET')
      return this.stream(side, other, url.searchParams.get('handle') || '', Number(url.searchParams.get('since')) || 0);
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    const b = await readJson(req);
    if (!b) return json({ error: 'bad json' }, 400);
    switch (action) {
      case 'open': return this.open(side, other, b);
      case 'attach': return this.attach(side, other, b);
      case 'send': return this.send(side, other, b);
      case 'ack': return this.ack(side, b);
      case 'note': return this.note(b);
      case 'convs': return this.convs(side, other);
      case 'close': return this.close(other, b);
      case 'revoke': return this.revoke(other);
    }
    return json({ error: 'unknown action' }, 404);
  }

  async init(b) {
    if (this.get('created')) return json({ error: 'pairing exists' }, 409);
    if (!b || !HEX64.test(b.invite_hash || '') || !PUB.test(b.pub_a || '') || !HEX64.test(b.tok_a || ''))
      return json({ error: 'bad init' }, 400);
    this.schema();
    const now = Date.now();
    this.set('created', now); this.set('invite_hash', b.invite_hash); this.set('pub_a', b.pub_a); this.set('tok_a', b.tok_a);
    await this.ensureAlarm(now + INVITE_TTL);
    return json({ ok: true });
  }

  async claim(b) {
    if (!b || typeof b.invite !== 'string' || !PUB.test(b.pub_b || '') || !HEX64.test(b.tok_b || '')) return json({ error: 'bad claim' }, 400);
    if (this.get('claimed')) return json({ error: 'invite already used' }, 409);
    if ((await sha(b.invite)) !== this.get('invite_hash')) return json({ error: 'wrong invite' }, 403);
    this.set('claimed', Date.now()); this.set('pub_b', b.pub_b); this.set('tok_b', b.tok_b);
    this.sql.exec(`DELETE FROM meta WHERE k = 'invite_hash'`);
    this.push('a', { t: 'joined', peer_pub: b.pub_b });
    return json({ ok: true, pub_a: this.get('pub_a') });
  }

  stream(side, other, handle, since) {
    if (!ID.test(handle)) return json({ error: 'bad handle' }, 400);
    const key = `${side}:${handle}`;
    this.streams.get(key)?.close(); // same session reconnecting: replace silently
    if ([...this.streams.values()].filter((s) => s.side === side).length >= MAX_STREAMS) return json({ error: 'too many sessions' }, 429);
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const s = {
      side, handle,
      write: (ev) => writer.write(te.encode(JSON.stringify(ev) + '\n')).catch(() => s.close()),
      close: () => { clearInterval(ping); if (this.streams.get(key) === s) this.streams.delete(key); writer.close().catch(() => {}); },
    };
    const ping = setInterval(() => s.write({ t: 'ping' }), 20000);
    this.streams.set(key, s);
    s.write({ t: 'hello', peer_pub: this.get('pub_' + other), client: CLIENT_VERSION });
    s.write({
      t: 'state',
      convs: this.sql.exec(`SELECT id, closed, att_${side} AS att FROM conv`).toArray()
        .map((c) => ({ conv: c.id, closed: !!c.closed, mine: c.att === handle })),
    });
    for (const c of this.sql.exec(`SELECT id, title, opener, created FROM conv WHERE closed = 0 AND att_${side} IS NULL`))
      s.write({ t: 'lobby', conv: c.id, title: c.title, opener: c.opener, created: c.created });
    for (const r of this.sql.exec(`SELECT m.id, m.conv, m.body FROM msg m JOIN conv c ON c.id = m.conv
        WHERE m.sender = ? AND m.id > ? AND c.att_${side} = ? ORDER BY m.id`, other, since, handle))
      s.write({ t: 'msg', id: r.id, conv: r.conv, body: r.body });
    return new Response(readable, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
  }

  open(side, other, b) {
    if (!ID.test(b.conv || '') || !ID.test(b.handle || '') || typeof b.title !== 'string' || b.title.length > MAX_META)
      return json({ error: 'bad open' }, 400);
    if (!this.get('claimed')) return json({ error: 'invite not used yet' }, 409);
    if (this.conv(b.conv)) return json({ error: 'conversation exists' }, 409);
    if (this.sql.exec(`SELECT COUNT(*) AS n FROM conv WHERE closed = 0`).one().n >= MAX_OPEN_CONVS) return json({ error: 'too many conversations' }, 429);
    const now = Date.now();
    this.sql.exec(`INSERT INTO conv (id, title, opener, created, last, att_${side}) VALUES (?, ?, ?, ?, ?, ?)`, b.conv, b.title, side, now, now, b.handle);
    this.push(other, { t: 'lobby', conv: b.conv, title: b.title, opener: side, created: now });
    return json({ ok: true });
  }

  attach(side, other, b) {
    if (!ID.test(b.handle || '')) return json({ error: 'bad handle' }, 400);
    const c = this.conv(b.conv || '');
    if (!c || c.closed) return json({ error: 'no such conversation' }, 404);
    const prev = c['att_' + side];
    this.sql.exec(`UPDATE conv SET att_${side} = ? WHERE id = ?`, b.handle, c.id);
    if (prev && prev !== b.handle) this.push(side, { t: 'detached', conv: c.id }, prev);
    if (prev !== b.handle)
      for (const r of this.sql.exec(`SELECT id, body FROM msg WHERE conv = ? AND sender = ? ORDER BY id`, c.id, other))
        this.push(side, { t: 'msg', id: r.id, conv: c.id, body: r.body }, b.handle);
    return json({ ok: true, moved_from_other_session: !!(prev && prev !== b.handle), note: c.note, title: c.title });
  }

  async send(side, other, b) {
    const c = this.conv(b.conv || '');
    if (!c || c.closed) return json({ error: 'no such conversation' }, 404);
    if (typeof b.body !== 'string' || !b.body || b.body.length > MAX_BODY) return json({ error: 'bad body' }, 400);
    if (this.sql.exec(`SELECT COUNT(*) AS n FROM msg`).one().n >= MAX_PENDING) return json({ error: 'mailbox full' }, 429);
    const now = Date.now();
    const { id } = this.sql.exec(`INSERT INTO msg (conv, sender, body, ts) VALUES (?, ?, ?, ?) RETURNING id`, c.id, side, b.body, now).one();
    this.sql.exec(`UPDATE conv SET last = ? WHERE id = ?`, now, c.id);
    await this.ensureAlarm(now + MSG_TTL);
    const dest = c['att_' + other];
    if (dest) this.push(other, { t: 'msg', id, conv: c.id, body: b.body }, dest);
    return json({ id, delivered_to_session: !!dest && [...this.streams.values()].some((s) => s.side === other && s.handle === dest) });
  }

  ack(side, b) {
    if (!ID.test(b.handle || '')) return json({ error: 'bad handle' }, 400);
    this.sql.exec(`DELETE FROM msg WHERE sender != ? AND id <= ? AND conv IN (SELECT id FROM conv WHERE att_${side} = ?)`,
      side, Number(b.upto) || 0, b.handle);
    return json({ ok: true });
  }

  note(b) {
    const c = this.conv(b.conv || '');
    if (!c) return json({ error: 'no such conversation' }, 404);
    if (b.note === undefined) return json({ note: c.note });
    if (typeof b.note !== 'string' || b.note.length > MAX_META) return json({ error: 'bad note' }, 400);
    this.sql.exec(`UPDATE conv SET note = ?, last = ? WHERE id = ?`, b.note, Date.now(), c.id);
    return json({ ok: true });
  }

  convs(side, other) {
    const rows = this.sql.exec(`SELECT c.*, (SELECT COUNT(*) FROM msg m WHERE m.conv = c.id AND m.sender = ?) AS pending
      FROM conv c ORDER BY c.last DESC`, other).toArray();
    return json({
      claimed: !!this.get('claimed'),
      peer_pub: this.get('pub_' + other),
      convs: rows.map((c) => ({
        conv: c.id, title: c.title, opener: c.opener, created: c.created, last: c.last, closed: !!c.closed,
        has_note: !!c.note, my_session: c['att_' + side], peer_attached: !!c['att_' + other], pending: c.pending,
      })),
    });
  }

  close(other, b) {
    const c = this.conv(b.conv || '');
    if (!c) return json({ error: 'no such conversation' }, 404);
    this.sql.exec(`UPDATE conv SET closed = 1, last = ? WHERE id = ?`, Date.now(), c.id);
    this.sql.exec(`DELETE FROM msg WHERE conv = ?`, c.id);
    this.push(other, { t: 'closed', conv: c.id });
    return json({ ok: true });
  }

  async revoke(other) {
    this.push(other, { t: 'revoked' });
    for (const s of [...this.streams.values()]) s.close();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll(); // drops the tables too
    this.ready = false;
    return json({ ok: true });
  }

  async alarm() {
    if (!this.ready) return;
    const now = Date.now();
    if (!this.get('claimed') && Number(this.get('created')) < now - INVITE_TTL) {
      await this.ctx.storage.deleteAll();
      this.ready = false;
      return;
    }
    this.sql.exec(`DELETE FROM msg WHERE ts < ?`, now - MSG_TTL);
    this.sql.exec(`DELETE FROM conv WHERE closed = 1 AND last < ?`, now - MSG_TTL);
    const oldest = this.sql.exec(`SELECT MIN(ts) AS t FROM msg`).one().t;
    if (oldest != null) await this.ctx.storage.setAlarm(oldest + MSG_TTL);
  }
}

const INVITE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>wire invite</title><style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--card:#fff;--line:#e7e5e4;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--accent:#fb923c}}
*{box-sizing:border-box}body{background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif;margin:0;padding:40px 16px}
main{max-width:640px;margin:0 auto}h1{font-size:26px;line-height:1.2;margin:0 0 6px}
p,li,summary{color:var(--muted)}code{font:13px/1.5 ui-monospace,monospace}
ol{padding-left:22px;margin:22px 0}ol>li{margin:0 0 18px;color:var(--fg);font-weight:600}ol>li>*{font-weight:400}
label{display:block;color:var(--muted);margin:6px 0}
input{width:100%;font:16px system-ui;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{margin-top:8px;font:600 15px system-ui;padding:10px 18px;border-radius:8px;border:1px solid var(--line);background:var(--fg);color:var(--bg);cursor:pointer}
button:disabled{opacity:.45;cursor:not-allowed}
details{margin-top:26px}pre{margin:8px 0 0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;
font:12.5px/1.55 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;color:var(--fg)}
.bad{color:var(--accent)}</style></head><body><main>
<h1 id="title">You're invited to a private chat</h1><p id="who"></p>
<ol id="steps">
<li>Your name<label for="name">How you'll appear to the person who invited you.</label>
<input id="name" autocomplete="name" placeholder="Your name" maxlength="40"></li>
<li>Copy the message<br><button id="copy" disabled>Copy</button></li>
<li>Paste it into Claude Code<label>Claude sets everything up and tells you a short safety code. Compare it with the person
who invited you, on a call or by text, to make sure nobody intercepted this link.</label></li>
</ol>
<details><summary>What the message does</summary><pre id="prompt"></pre>
<p>It downloads the wire client from this site (version __VER__) and checks its checksum, joins the chat<span id="plug">,
and installs the wire plugin for Claude Code from GitHub (<code>__PLUGIN__</code>), which adds the chat panel</span>.
Messages are end-to-end encrypted. This link works once, and its secret part never leaves your browser.
In a cloud session with limited network access, Claude asks you to allow <code id="host"></code> once.</p></details>
</main><script>
const f=location.hash.slice(1).split('.'), ok=f.length>=3&&f[0]&&f[1]&&f[2];
const inviter=f[3]?decodeURIComponent(f[3]):'Someone', o=location.origin, plugin='__PLUGIN__';
const $=(id)=>document.getElementById(id);
$('host').textContent=location.host; if(!plugin)$('plug').hidden=true;
function build(){
  const name=$('name').value.trim().replace(/["\\\\$\`]/g,'');
  const join='mkdir -p ~/.wire && curl -fsSL '+o+'/v/__VER__/wire.mjs -o ~/.wire/wire.mjs && echo "__SHA__  '+'$HOME/.wire/wire.mjs" | sha256sum -c - && node ~/.wire/wire.mjs join "'+location.href+'" --name "'+name+'"';
  const add=plugin?'\\n\\nThen install the chat panel (skip it if this fails):\\n\\nclaude plugin install wire --marketplace '+plugin:'';
  return 'Join '+inviter+"'s private wire chat for me. Run this, then follow the rules it prints:\\n\\n"+join+add;
}
function refresh(){ $('copy').disabled=!$('name').value.trim(); $('prompt').textContent=build(); }
if(!ok){ $('title').textContent='This invite link is incomplete'; $('steps').hidden=true;
  $('who').innerHTML='<span class="bad">Ask for the full link, including everything after the #.</span>'; }
else{ $('who').textContent=inviter+' invited you. Three steps:'; $('name').addEventListener('input',refresh); refresh(); }
$('copy').onclick=()=>{ const t=build(), b=$('copy');
  navigator.clipboard.writeText(t).then(()=>{b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1500)})
    .catch(()=>{ $('prompt').parentElement.open=true; const r=document.createRange(); r.selectNodeContents($('prompt')); const sel=getSelection(); sel.removeAllRanges(); sel.addRange(r); }); };
</script></body></html>`;
