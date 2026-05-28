// functions/tributos.js
// Backend del extractor DeLaval — gestiona la base de tributos en D1.
//
// Endpoints disponibles:
//   GET  /tributos?materials=A,B,C       → tributos guardados para esos materiales
//   GET  /tributos?all=1&page=N&size=50  → listado paginado de toda la tabla
//   GET  /tributos?history=MATERIAL      → historial de cambios de un material
//   POST /tributos                       → guarda/actualiza (requiere frase de confirmación)
//
// Bindings esperados en Pages:
//   env.DB              → la D1 database "extractor-tributos"
//   env.WRITE_PASSWORD  → la frase de confirmación (secret)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Write-Password',
};

const json = (status, data) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', ...corsHeaders }
});

// ── Preflight CORS ──────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// ── GET: 3 modos según query params ────────────────────
export async function onRequestGet({ request, env }) {
  if (!env.DB) return json(500, { error: 'D1 binding "DB" no configurado en Cloudflare Pages' });

  const url = new URL(request.url);

  // Modo 1: por lista de materials (consulta puntual)
  if (url.searchParams.has('materials')) {
    return await modeByMaterials(url, env);
  }

  // Modo 2: paginado all
  if (url.searchParams.has('all')) {
    return await modePaginated(url, env);
  }

  // Modo 3: historial de un material
  if (url.searchParams.has('history')) {
    return await modeHistory(url, env);
  }

  // Default: respuesta vacía con instrucciones
  return json(200, {
    data: [],
    hint: 'Use ?materials=A,B,C  |  ?all=1&page=N&size=50  |  ?history=MATERIAL'
  });
}

// ── Modo 1: consulta por lista de materials ────────────
async function modeByMaterials(url, env) {
  const param = url.searchParams.get('materials') || '';
  const materials = param.split(',').map(s => s.trim()).filter(Boolean);

  if (materials.length === 0) return json(200, { data: [] });

  const BLOCK = 90;
  const allRows = [];
  for (let i = 0; i < materials.length; i += BLOCK) {
    const chunk = materials.slice(i, i + BLOCK);
    const placeholders = chunk.map(() => '?').join(',');
    const stmt = env.DB.prepare(
      `SELECT * FROM tributos WHERE material IN (${placeholders})`
    ).bind(...chunk);
    const result = await stmt.all();
    if (result.results) allRows.push(...result.results);
  }
  return json(200, { data: allRows });
}

// ── Modo 2: paginado completo (con búsqueda opcional) ──
// Query params: page (1-indexed), size (default 50, max 200), search (opcional)
async function modePaginated(url, env) {
  const page   = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const size   = Math.min(200, Math.max(1, parseInt(url.searchParams.get('size'), 10) || 50));
  const search = (url.searchParams.get('search') || '').trim();
  const offset = (page - 1) * size;

  // WHERE clause y bindings según haya o no búsqueda
  let where = '';
  const bindings = [];
  if (search) {
    where = 'WHERE material LIKE ?';
    bindings.push('%' + search + '%');
  }

  // Total de filas (para el conteo de páginas)
  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM tributos ${where}`
  ).bind(...bindings).first();
  const total = countResult?.total || 0;

  // Filas de la página actual
  const rowsResult = await env.DB.prepare(
    `SELECT * FROM tributos ${where} ORDER BY material ASC LIMIT ? OFFSET ?`
  ).bind(...bindings, size, offset).all();

  return json(200, {
    data: rowsResult.results || [],
    page,
    size,
    total,
    totalPages: Math.ceil(total / size)
  });
}

// ── Modo 3: historial de un material específico ────────
async function modeHistory(url, env) {
  const material = (url.searchParams.get('history') || '').trim();
  const limit    = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 50));

  if (!material) return json(400, { error: 'Falta material en ?history=' });

  const result = await env.DB.prepare(
    `SELECT * FROM tributos_history
     WHERE material = ?
     ORDER BY changed_at DESC
     LIMIT ?`
  ).bind(material, limit).all();

  return json(200, { material, data: result.results || [] });
}

// ── POST: guarda/actualiza tributos ────────────────────
// Body JSON:
//   { password, changedBy?, updates: [ {material, imaduni, rec_min, rec_adi, tasa_con, ...}, ... ] }
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json(500, { error: 'D1 binding "DB" no configurado' });
  if (!env.WRITE_PASSWORD) return json(500, { error: 'Secret "WRITE_PASSWORD" no configurado' });

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { error: 'Body inválido (no es JSON)' });
  }

  const password = request.headers.get('X-Write-Password') || body.password;
  if (!password || password !== env.WRITE_PASSWORD) {
    return json(401, { error: 'Frase de confirmación incorrecta o faltante' });
  }

  const { updates, changedBy } = body;
  if (!Array.isArray(updates) || updates.length === 0) {
    return json(400, { error: 'No hay updates en el body' });
  }

  const now = new Date().toISOString();
  const by  = (changedBy || '').toString().slice(0, 100) || null;

  const matsArr = updates.map(u => u.material).filter(Boolean);
  if (matsArr.length === 0) return json(400, { error: 'Updates sin material code' });

  const BLOCK = 90;
  const existingSet = new Set();
  for (let i = 0; i < matsArr.length; i += BLOCK) {
    const chunk = matsArr.slice(i, i + BLOCK);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await env.DB.prepare(
      `SELECT material FROM tributos WHERE material IN (${placeholders})`
    ).bind(...chunk).all();
    for (const r of (result.results || [])) existingSet.add(r.material);
  }

  const stmtUpsert = env.DB.prepare(`
    INSERT INTO tributos (material, imaduni, rec_min, rec_adi, tasa_con, ultima_factura, ultima_pos_dua, ultimo_dua, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(material) DO UPDATE SET
      imaduni        = excluded.imaduni,
      rec_min        = excluded.rec_min,
      rec_adi        = excluded.rec_adi,
      tasa_con       = excluded.tasa_con,
      ultima_factura = excluded.ultima_factura,
      ultima_pos_dua = excluded.ultima_pos_dua,
      ultimo_dua     = excluded.ultimo_dua,
      updated_at     = excluded.updated_at,
      updated_by     = excluded.updated_by
  `);

  const stmtHistory = env.DB.prepare(`
    INSERT INTO tributos_history (material, imaduni, rec_min, rec_adi, tasa_con, ultima_factura, ultima_pos_dua, changed_at, changed_by, action)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const queries = [];
  for (const u of updates) {
    if (!u.material) continue;
    const action = existingSet.has(u.material) ? 'update' : 'create';
    const im = Number(u.imaduni)  || 0;
    const rm = Number(u.rec_min)  || 0;
    const ra = Number(u.rec_adi)  || 0;
    const tc = Number(u.tasa_con) || 0;
    const fac = u.ultima_factura || null;
    const pos = u.ultima_pos_dua != null ? Number(u.ultima_pos_dua) : null;
    const dua = u.ultimo_dua || null;

    queries.push(stmtUpsert.bind(u.material, im, rm, ra, tc, fac, pos, dua, now, by));
    queries.push(stmtHistory.bind(u.material, im, rm, ra, tc, fac, pos, now, by, action));
  }

  try {
    await env.DB.batch(queries);
    return json(200, { ok: true, count: updates.length });
  } catch (e) {
    return json(500, { error: 'Error guardando en la D1: ' + e.message });
  }
}

// ── Otros métodos → 405 ────────────────────────────────
export async function onRequest({ request }) {
  return json(405, { error: `Método ${request.method} no soportado` });
}