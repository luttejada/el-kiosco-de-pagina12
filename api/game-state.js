/* /api/game-state — intermediario del kiosco con GET/POST /game-state de la API de Página/12.
   Adaptado de Sumática (mdpgames/p12sumatica: src/server/p12api.ts y src/app/api/game-state/route.ts).
   Corre solo en el servidor de Vercel: el secreto DAILY_PASSWORD_API_JWT_SECRET y el JWT nunca llegan al navegador.
   Respuestas al navegador:
     GET  ?date&userId        200 { found: true, state, savedAt } · 200 { found: false } (solo ante el 404 JSON documentado)
     POST { date, userId, state }  200 { saved: true, savedAt }
     error { error, kind } con kind = config | invalid | auth | network | server | format
   El gameId lo pone este intermediario (runtime-config.json); el navegador no lo manda. */
const { createHmac } = require('node:crypto');
const runtime = require('../runtime-config.json');

const GAME_ID = runtime.gameId;
// P12_API_BASE_URL solo para pruebas locales contra la API simulada; en Vercel no se define.
const API_BASE = (process.env.P12_API_BASE_URL || runtime.apiBaseUrl).replace(/\/+$/, '');
const MAX_BODY = 1024 * 1024 - 2048;   // 1 MiB de la API, con margen para los identificadores

class ProxyError extends Error { constructor(kind, status, msg) { super(msg); this.kind = kind; this.status = status; } }
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const validDate = s => { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + 'T12:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; };
const validUser = s => typeof s === 'string' && s.length >= 1 && s.length <= 191;
function checkIds(date, userId) {
  if (!validDate(date)) throw new ProxyError('invalid', 400, 'Fecha inválida.');
  if (!validUser(userId)) throw new ProxyError('invalid', 400, 'Usuario inválido.');
  return { date, userId };
}

// JWT HS256 de 10 minutos, firmado acá
function signJwt(secret) {
  const b64 = s => Buffer.from(s).toString('base64url'), now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ sub: GAME_ID, iat: now, exp: now + 600 }));
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

async function callApi(path, init = {}) {
  const secret = process.env.DAILY_PASSWORD_API_JWT_SECRET;
  if (!secret) throw new ProxyError('config', 500, 'Falta configurar el servidor del juego.');
  let res;
  try {
    res = await fetch(API_BASE + path, { ...init, cache: 'no-store', headers: { ...(init.headers || {}), Authorization: `Bearer ${signJwt(secret)}` }, signal: AbortSignal.timeout(10000) });
  } catch (e) { throw new ProxyError('network', 502, 'No se pudo conectar con el servidor de Página/12.'); }
  let json = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) { try { json = await res.json(); } catch (e) { json = null; } }
  if (res.status === 401) throw new ProxyError('auth', 502, 'El servidor de Página/12 rechazó la autenticación.');
  return { status: res.status, json };
}

// respuesta 200 válida de /game-state para la misma partida
function parseState(r, date, userId) {
  const j = r.json;
  if (!isObject(j) || j.date !== date || String(j.gameId).toLowerCase() !== GAME_ID.toLowerCase() || j.userId !== userId || !isObject(j.state))
    throw new ProxyError('format', 502, 'Respuesta inesperada del servidor de Página/12.');
  return { state: j.state, savedAt: typeof j.savedAt === 'string' ? j.savedAt : null };
}
// ausencia documentada: 404 con JSON { error } en la ruta correcta
const isAbsence = r => r.status === 404 && isObject(r.json) && typeof r.json.error === 'string';
function upstreamError(r) {
  const msg = isObject(r.json) && typeof r.json.error === 'string' ? r.json.error : `Error ${r.status}`;
  return r.status === 400 || r.status === 413 || r.status === 415 ? new ProxyError('invalid', 400, msg) : new ProxyError('server', 502, msg);
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);   // Vercel ya lo leyó
  let text = '';
  for await (const c of req) { text += c; if (text.length > MAX_BODY) break; }
  return text;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams;
      if (q.getAll('date').length !== 1 || q.getAll('userId').length !== 1) throw new ProxyError('invalid', 400, 'Parámetros inválidos.');
      const { date, userId } = checkIds(q.get('date'), q.get('userId'));
      const r = await callApi('/game-state?' + new URLSearchParams({ date, gameId: GAME_ID, userId }));
      if (r.status === 200) { const { state, savedAt } = parseState(r, date, userId); return send(res, 200, { found: true, state, savedAt }); }
      if (isAbsence(r)) return send(res, 200, { found: false });
      throw upstreamError(r);
    }
    if (req.method === 'POST') {
      if (!(req.headers['content-type'] || '').includes('application/json')) throw new ProxyError('invalid', 415, 'Se esperaba JSON.');
      const text = await readBody(req);
      if (text.length > MAX_BODY) throw new ProxyError('invalid', 413, 'El guardado es demasiado grande.');
      let body; try { body = JSON.parse(text); } catch (e) { throw new ProxyError('invalid', 400, 'JSON inválido.'); }
      const { date, userId } = checkIds(body.date, body.userId);
      const state = body.state;
      if (!isObject(state) || typeof state.partida_finalizada !== 'boolean') throw new ProxyError('invalid', 400, 'Estado inválido.');
      const r = await callApi('/game-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, gameId: GAME_ID, userId, state }) });
      if (r.status !== 200) throw upstreamError(r);
      const { savedAt } = parseState(r, date, userId);
      return send(res, 200, { saved: true, savedAt });
    }
    res.setHeader('Allow', 'GET, POST');
    throw new ProxyError('invalid', 405, 'Método no permitido.');
  } catch (e) {
    const err = e instanceof ProxyError ? e : new ProxyError('server', 500, 'Error inesperado.');
    send(res, err.status, { error: err.message, kind: err.kind });
  }
};
