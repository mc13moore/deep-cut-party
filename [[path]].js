// Deep Cut party API — runs as a Cloudflare Pages Function, stores scores in D1.
//
//   GET  /api/scores?board=live|test   -> { entries, names }      (anyone: scoreboard)
//   POST /api/scores                    -> save a player's card    (anyone: automatic from the game)
//   GET  /api/host/check                -> verify host PIN
//   POST /api/host/entry | delete | reset | names                  (host PIN required)

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
const cleanName = (n) => String(n || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 18);
const validScore = (s) => Number.isInteger(s) && s >= 0 && s <= MAX_SCORE;
const validTeam = (t) => Number.isInteger(t) && t >= 0 && t < TEAMS;

export async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) return json({ error: "Database not connected. Check the d1_databases section of wrangler.toml." }, 500);
  await ensureSchema(db);

  const path = [].concat(params.path || []).join("/");
  const url = new URL(request.url);
  const method = request.method;
  let body = {};
  if (method === "POST") {
    try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  }
  const boardIn = body.board || url.searchParams.get("board");
  const board = BOARDS.includes(boardIn) ? boardIn : null;

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
    if (method !== "POST" || !board) return json({ error: "Bad request" }, 400);

    if (action === "entry") {
      const name = cleanName(body.name);
      if (!name || !validTeam(body.team) || !validScore(body.score)) return json({ error: "Invalid entry" }, 400);
      const id = "manual:" + crypto.randomUUID().slice(0, 8);
      await db.prepare(
        "INSERT INTO scores (board, id, team, name, score, gems, grid, run, manual, updated_at) VALUES (?, ?, ?, ?, ?, 0, '', 0, 1, ?)"
      ).bind(board, id, body.team, name, body.score, Date.now()).run();
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
      const names = body.names.map((n, i) => cleanName(n).slice(0, 20) || `Team ${i + 1}`);
      await db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v")
        .bind("names:" + board, JSON.stringify(names)).run();
      return json({ ok: true, names });
    }
  }
  return json({ error: "Not found" }, 404);
}
