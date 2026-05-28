// functions/tributos.js
// Backend del extractor DeLaval — gestiona la base de tributos en D1.
//
// Endpoints disponibles:
//   GET  /tributos?materials=A,B,C  → consulta tributos guardados para esos materiales
//   POST /tributos                  → guarda/actualiza tributos (requiere frase de confirmación)
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

// ── GET: consulta tributos guardados ───────────────────
// Query: /tributos?materials=184001343,94158680,...
// Respuesta: { data: [ { material, imaduni, rec_min, rec_adi, tasa_con, ... }, ... ] }
export async function onRequestGet({ request, env }) {
  if (!env.DB) return json(500, { error: 'D1 binding "DB" no configurado en Cloudflare Pages' });

  const url = new URL(request.url);
  const param = url.searchParams.get('materials') || '';
  const materials = param.split(',').map(s => s.trim()).filter(Boolean);

  if (materials.length === 0) {
    return json(200, { data: [] });
  }

  // D1 limita a ~100 parámetros por query, así que dividimos en bloques por las dudas
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

// ── POST: guarda/actualiza tributos ────────────────────
// Body JSON esperado:
//   {
//     password: "CONFIRMAR CAMBIO",
//     changedBy: "Germán" (opcional, máx 100 chars),
//     updates: [
//       { material: "184001343", imaduni: 6.20, rec_min: 6, rec_adi: 4, tasa_con: 5,
//         ultima_factura: "2738060664", ultima_pos_dua: 2, ultimo_dua: "069292" },
//       ...
//     ]
//   }
// Cada update se aplica como UPSERT en `tributos` y queda registrado en `tributos_history`.
export async function onRequestPost({ request, env }) {
  if (!env.DB) return json(500, { error: 'D1 binding "DB" no configurado' });
  if (!env.WRITE_PASSWORD) return json(500, { error: 'Secret "WRITE_PASSWORD" no configurado' });

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { error: 'Body inválido (no es JSON)' });
  }

  // Validar frase de confirmación (puede venir en header o en el body)
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

  // Para distinguir create vs update en el historial, miramos qué materiales ya existen
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

  // Statements preparados para reusar
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
