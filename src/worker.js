// Deep Cut party — Cloudflare Worker. Serves the game from ./public and the
// scoreboard API at /api/*, storing scores in D1.
//
//   GET  /api/scores?board=live|test   -> { entries, names }      (anyone: scoreboard)
//   POST /api/scores                    -> save a player's card    (anyone: automatic from the game)
//   GET  /api/host/check                -> verify host PIN
//   GET  /api/state                     -> { round2Open }
//   POST /api/host/entry | delete | reset | names | round2         (host PIN required)

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS scores (
     board TEXT NOT NULL, id TEXT NOT NULL, team INTEGER NOT NULL, name TEXT NOT NULL,
     score INTEGER NOT NULL, gems INTEGER NOT NULL DEFAULT 0, grid TEXT, run INTEGER NOT NULL DEFAULT 0,
     manual INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
     PRIMARY KEY (board, id))`,
  `CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];
let ready = null;
function ensureSchema(db) {
  if (!ready) ready = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => { ready = null; throw e; });
  return ready;
}

const BOARDS = ["live", "test"];
const TEAMS = 6;
const MAX_SCORE = 700; // 7 prompts x 100
const json = (d, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const cleanName = (n, max = 18) => String(n || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const validScore = (s) => Number.isInteger(s) && s >= 0 && s <= MAX_SCORE;
const validTeam = (t) => Number.isInteger(t) && t >= 0 && t < TEAMS;

async function handleApi(request, env, path) {
  const db = env.DB;
  if (!db) return json({ error: "Database not connected. Check the d1_databases section of wrangler.toml." }, 500);
  await ensureSchema(db);

  const url = new URL(request.url);
  const method = request.method;
  let body = {};
  if (method === "POST") {
    try { body = (await request.json()) || {}; } catch { return json({ error: "Bad request" }, 400); }
  }
  const boardIn = body.board || url.searchParams.get("board");
  const board = BOARDS.includes(boardIn) ? boardIn : null;

  // ----- Public: game state (is Round 2 open?) -----
  if (path === "state" && method === "GET") {
    const s = await db.prepare("SELECT v FROM settings WHERE k = 'round2open'").first();
    return json({ round2Open: !!(s && s.v === "1") });
  }

  // ----- Public: read a board -----
  if (path === "scores" && method === "GET") {
    if (!board) return json({ error: "Unknown board" }, 400);
    const { results } = await db
      .prepare("SELECT id, team, name, score, gems, grid, run, manual, updated_at FROM scores WHERE board = ? ORDER BY updated_at")
      .bind(board).all();
    const s = await db.prepare("SELECT v FROM settings WHERE k = ?").bind("names:" + board).first();
    return json({ entries: results, names: s ? JSON.parse(s.v) : null });
  }

  // ----- Public: a player's game submits their card automatically -----
  if (path === "scores" && method === "POST") {
    const id = String(body.id || "");
    const name = cleanName(body.name);
    if (!board || !/^[a-z0-9:_-]{4,80}$/.test(id) || !name || !validTeam(body.team) || !validScore(body.score))
      return json({ error: "Invalid score card" }, 400);
    await db.prepare(
      `INSERT INTO scores (board, id, team, name, score, gems, grid, run, manual, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT (board, id) DO UPDATE SET team = excluded.team, name = excluded.name, score = excluded.score,
         gems = excluded.gems, grid = excluded.grid, run = excluded.run, updated_at = excluded.updated_at`
    ).bind(board, id, body.team, name, body.score, Math.min(7, Math.max(0, body.gems | 0)),
           String(body.grid || "").slice(0, 64), Math.max(0, body.run | 0), Date.now()).run();
    return json({ ok: true });
  }

  // ----- Host only -----
  if (path.startsWith("host/")) {
    const pin = request.headers.get("x-host-pin") || "";
    if (!env.HOST_PIN || pin !== String(env.HOST_PIN)) return json({ error: "Wrong host PIN" }, 401);
    const action = path.slice(5);

    if (action === "check") return json({ ok: true });
    if (method !== "POST") return json({ error: "Bad request" }, 400);

    if (action === "round2") {
      const open = !!body.open;
      await db.prepare("INSERT INTO settings (k, v) VALUES ('round2open', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v")
        .bind(open ? "1" : "0").run();
      return json({ ok: true, round2Open: open });
    }
    if (!board) return json({ error: "Bad request" }, 400);

    if (action === "entry") {
      const name = cleanName(body.name);
      if (!name || !validTeam(body.team) || !validScore(body.score)) return json({ error: "Invalid entry" }, 400);
      const id = "manual:" + crypto.randomUUID().slice(0, 8);
      const run = Math.max(0, Math.min(9, body.run | 0));
      await db.prepare(
        "INSERT INTO scores (board, id, team, name, score, gems, grid, run, manual, updated_at) VALUES (?, ?, ?, ?, ?, 0, '', ?, 1, ?)"
      ).bind(board, id, body.team, name, body.score, run, Date.now()).run();
      return json({ ok: true, id });
    }
    if (action === "delete") {
      await db.prepare("DELETE FROM scores WHERE board = ? AND id = ?").bind(board, String(body.id || "")).run();
      return json({ ok: true });
    }
    if (action === "reset") {
      await db.prepare("DELETE FROM scores WHERE board = ?").bind(board).run();
      return json({ ok: true });
    }
    if (action === "names") {
      if (!Array.isArray(body.names) || body.names.length !== TEAMS) return json({ error: "Need 6 names" }, 400);
      const names = body.names.map((n, i) => cleanName(n, 20) || `Team ${i + 1}`);
      await db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v")
        .bind("names:" + board, JSON.stringify(names)).run();
      return json({ ok: true, names });
    }
  }
  return json({ error: "Not found" }, 404);
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url.pathname.slice(5).replace(/\/+$/, "")); }
      catch (e) { return json({ error: "Server error: " + (e && e.message ? e.message : e) }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
