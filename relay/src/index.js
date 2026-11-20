// wire relay v2 — a mailbox per pairing of two people, with conversations bound to sessions.
//
// Trust is person<->person (one pairing = one Durable Object, created only by the relay owner and
// claimed once by the invitee). Conversations live inside a pairing; each side attaches a conversation
// to one session handle at a time. The relay stores only ciphertext (titles, notes, messages are
// encrypted client-side), hashes of member tokens, and the two public keys.
//
// Plain HTTPS only (no WebSockets) so it works through egress proxies.
//   GET  /i#...                       invite page (the secret stays in the URL fragment, never sent here)
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
import { DurableObject } from 'cloudflare:workers';
import CLIENT from '../../client/wire.mjs'; // bundled as text (see "rules" in wrangler.jsonc)

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
      return new Response(INVITE_HTML.replaceAll('__VER__', CLIENT_VERSION).replaceAll('__SHA__', await clientSha256()),
        { headers: { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' } });
    if (url.pathname === '/pairs' && req.method === 'POST') {
      const tok = req.headers.get('x-wire-owner') || '';
      if (!env.OWNER_TOKEN || !tok || !(await safeEq(tok, env.OWNER_TOKEN))) return json({ error: 'not owner' }, 401);
      const b = await readJson(req);
      if (!b || !ID.test(b.pair || '')) return json({ error: 'bad pair id' }, 400);
      const stub = env.PAIR.get(env.PAIR.idFromName(b.pair));
      return stub.fetch(new Request('https://do/init', { method: 'POST', body: JSON.stringify(b) }));
    }
    const m = url.pathname.match(/^\/p\/([A-Za-z0-9_-]{6,64})\/([a-z]+)$/);
    if (!m) return json({ error: 'not found' }, 404);
    return env.PAIR.get(env.PAIR.idFromName(m[1])).fetch(req);
  },
};

export class PairV2 extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS conv (id TEXT PRIMARY KEY, title TEXT, opener TEXT, created INTEGER,
      last INTEGER, closed INTEGER DEFAULT 0, note TEXT, att_a TEXT, att_b TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS msg (id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, sender TEXT, body TEXT, ts INTEGER)`);
    this.streams = new Map(); // `${side}:${handle}` -> { side, handle, write, close }
  }

  get(k) { const r = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0]; return r ? r.v : null; }
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
    s.write({ t: 'hello', peer_pub: this.get('pub_' + other) });
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
    return json({ ok: true, moved_from_other_session: !!(prev && prev !== b.handle), note: c.note });
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
    await this.ctx.storage.deleteAll();
    return json({ ok: true });
  }

  async alarm() {
    const now = Date.now();
    if (!this.get('claimed') && Number(this.get('created')) < now - INVITE_TTL) {
      await this.ctx.storage.deleteAll();
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
main{max-width:680px;margin:0 auto}h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
p,li{color:var(--muted)}code{font:13px/1.5 ui-monospace,monospace}
.box{position:relative;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 14px 14px 14px}
.box pre{margin:0;font:13px/1.55 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;color:var(--fg)}
button{margin-top:10px;font:600 14px system-ui;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--fg);color:var(--bg);cursor:pointer}
.bad{color:var(--accent)}</style></head><body><main>
<h1 id="title">You're invited to a private wire chat</h1><p id="who"></p>
<h2>Paste this into a Claude Code session</h2>
<div class="box"><pre id="prompt"></pre><button id="copy">Copy</button></div>
<h2>What happens</h2><ul>
<li>Claude installs the <code>wire</code> client (version __VER__, checksum verified), joins, and starts listening.</li>
<li>You'll both see a <b>safety code</b>. Compare it with the person who invited you (call or text) to make sure nobody intercepted this link.</li>
<li>Messages are end-to-end encrypted. This link works <b>once</b>; its secret part never leaves your browser.</li>
<li>In a cloud session with limited network access, Claude will ask you to allow <code id="host"></code> once.</li></ul>
</main><script>
const f=location.hash.slice(1).split('.'), ok=f.length>=3&&f[0]&&f[1]&&f[2];
const name=f[3]?decodeURIComponent(f[3]):'Someone', o=location.origin;
document.getElementById('host').textContent=location.host;
if(!ok){document.getElementById('title').textContent='This invite link is incomplete';document.getElementById('who').innerHTML='<span class="bad">Ask for the full link, including everything after the #.</span>';}
else{document.getElementById('who').textContent=name+' invited you.';
const cmd='mkdir -p ~/.wire && curl -fsSL '+o+'/v/__VER__/wire.mjs -o ~/.wire/wire.mjs && echo "__SHA__  '+'$HOME/.wire/wire.mjs" | sha256sum -c - && node ~/.wire/wire.mjs join "'+location.href+'" --name "<my name>"';
document.getElementById('prompt').textContent='Join '+name+"'s wire chat. Run this (use my name in place of <my name>; ask me if you don't know it), then follow the rules it prints:\n\n"+cmd;}
document.getElementById('copy').onclick=()=>navigator.clipboard.writeText(document.getElementById('prompt').textContent).then(()=>{const b=document.getElementById('copy');b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1500)});
</script></body></html>`;
