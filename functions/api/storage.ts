const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

type Env = {
  DB?: D1Database;
};

type StorageData = Record<string, string | null>;

type JsonBody = {
  data?: Record<string, unknown>;
  keys?: unknown;
};

const FAVORITE_KEYS = new Set([
  "favoriteSongs",
  "currentFavoriteIndex",
  "favoritePlayMode",
  "favoritePlaybackTime",
]);

const TABLES = {
  playback: "playback_store",
  favorites: "favorites_store",
} as const;

type TableName = (typeof TABLES)[keyof typeof TABLES];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function hasD1(env: Env): env is Required<Env> {
  return Boolean(env.DB && typeof env.DB.prepare === "function");
}

function getTableForKey(key: string): TableName {
  if (FAVORITE_KEYS.has(key)) {
    return TABLES.favorites;
  }
  return TABLES.playback;
}

function getUserIdFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies: Record<string, string> = {};
  cookieHeader.split(";").forEach((part) => {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) return;
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (key) cookies[key] = value;
  });

  const googleAuth = cookies.google_auth;
  if (googleAuth) {
    try {
      const sessionData = JSON.parse(atob(googleAuth));
      if (sessionData.exp && sessionData.exp > Date.now() && sessionData.userId) {
        return sessionData.userId;
      }
    } catch (error) {
      // Invalid session
    }
  }

  return null;
}

async function ensureTables(env: Env): Promise<void> {
  if (!hasD1(env)) {
    return;
  }
  const createStatements = [
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS playback_store (user_id TEXT, key TEXT, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, key))"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS favorites_store (user_id TEXT, key TEXT, value TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, key))"
    ),
  ];
  await env.DB.batch(createStatements);
}

async function handleGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!hasD1(env)) {
    return jsonResponse({ d1Available: false, data: {} });
  }

  const userId = getUserIdFromRequest(request);
  if (!userId) {
    return jsonResponse({ d1Available: false, data: {}, error: "Not authenticated" });
  }

  const statusOnly = url.searchParams.get("status");
  if (statusOnly) {
    return jsonResponse({ d1Available: true });
  }

  const keysParam = url.searchParams.get("keys") || "";
  const keys = keysParam
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

  await ensureTables(env);

  const data: StorageData = {};
  let rows: Array<{ key: string; value: string | null }> = [];
  if (keys.length > 0) {
    const groupedKeys = keys.reduce(
      (acc, key) => {
        const table = getTableForKey(key);
        acc[table].push(key);
        return acc;
      },
      { [TABLES.playback]: [] as string[], [TABLES.favorites]: [] as string[] }
    );

    const results: Array<{ key: string; value: string | null }> = [];
    for (const [table, tableKeys] of Object.entries(groupedKeys)) {
      if (tableKeys.length === 0) continue;
      const placeholders = tableKeys.map(() => "?").join(",");
      const statement = env.DB.prepare(
        `SELECT key, value FROM ${table} WHERE user_id = ? AND key IN (${placeholders})`
      ).bind(userId, ...tableKeys);
      const result = await statement.all();
      const rowsResult = (result as any).results || result.results || [];
      results.push(...rowsResult);
    }
    rows = results;
    keys.forEach((key) => {
      data[key] = null;
    });
  } else {
    const playbackResult = await env.DB.prepare(
      "SELECT key, value FROM playback_store WHERE user_id = ?"
    ).bind(userId).all();
    const favoriteResult = await env.DB.prepare(
      "SELECT key, value FROM favorites_store WHERE user_id = ?"
    ).bind(userId).all();
    rows = [
      ...(((playbackResult as any).results || playbackResult.results || []) as any[]),
      ...(((favoriteResult as any).results || favoriteResult.results || []) as any[]),
    ];
  }

  rows.forEach((row) => {
    if (!row || typeof row.key !== "string") return;
    data[row.key] = row.value;
  });

  return jsonResponse({ d1Available: true, data });
}

async function handlePost(request: Request, env: Env): Promise<Response> {
  if (!hasD1(env)) {
    return jsonResponse({ d1Available: false, data: {} });
  }

  const userId = getUserIdFromRequest(request);
  if (!userId) {
    return jsonResponse({ d1Available: false, data: {}, error: "Not authenticated" });
  }

  const body = (await request.json().catch(() => ({}))) as JsonBody;
  const payload = body.data && typeof body.data === "object" ? body.data : null;

  if (!payload || Array.isArray(payload)) {
    return jsonResponse({ error: "Invalid payload" }, 400);
  }

  const entries = Object.entries(payload).filter(([key]) => Boolean(key));
  if (entries.length === 0) {
    return jsonResponse({ d1Available: true, updated: 0 });
  }

  await ensureTables(env);

  const groupedStatements: Record<string, D1PreparedStatement[]> = {
    [TABLES.playback]: [],
    [TABLES.favorites]: [],
  };

  entries.forEach(([key, value]) => {
    const storedValue = value == null ? "" : String(value);
    const table = getTableForKey(key);
    groupedStatements[table].push(
      env.DB.prepare(
        `INSERT INTO ${table} (user_id, key, value, updated_at) VALUES (?1, ?2, ?3, datetime('now')) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(userId, key, storedValue)
    );
  });

  const batches: Promise<unknown>[] = [];
  Object.values(groupedStatements).forEach((statements) => {
    if (statements.length > 0) {
      batches.push(env.DB.batch(statements));
    }
  });

  await Promise.all(batches);
  return jsonResponse({ d1Available: true, updated: entries.length });
}

async function handleDelete(request: Request, env: Env): Promise<Response> {
  if (!hasD1(env)) {
    return jsonResponse({ d1Available: false });
  }

  const userId = getUserIdFromRequest(request);
  if (!userId) {
    return jsonResponse({ d1Available: false, error: "Not authenticated" });
  }

  const body = (await request.json().catch(() => ({}))) as JsonBody;
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((key): key is string => typeof key === "string" && Boolean(key))
    : [];

  if (keys.length === 0) {
    return jsonResponse({ d1Available: true, deleted: 0 });
  }

  await ensureTables(env);

  const groupedStatements: Record<string, D1PreparedStatement[]> = {
    [TABLES.playback]: [],
    [TABLES.favorites]: [],
  };

  keys.forEach((key) => {
    const table = getTableForKey(key);
    groupedStatements[table].push(
      env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?1 AND key = ?2`).bind(userId, key)
    );
  });

  const batches: Promise<unknown>[] = [];
  Object.values(groupedStatements).forEach((statements) => {
    if (statements.length > 0) {
      batches.push(env.DB.batch(statements));
    }
  });

  await Promise.all(batches);
  return jsonResponse({ d1Available: true, deleted: keys.length });
}

export async function onRequest(context: any): Promise<Response> {
  const { request, env } = context;
  const method = (request.method || "GET").toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  }

  if (method === "GET") {
    return handleGet(request, env);
  }

  if (method === "POST") {
    return handlePost(request, env);
  }

  if (method === "DELETE") {
    return handleDelete(request, env);
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}
