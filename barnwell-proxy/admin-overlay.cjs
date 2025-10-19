/**
 * Barnwell admin overlay (127.0.0.1:8082)
 *  - GET  /health
 *  - GET  /api/settings                 (public)
 *  - GET  /api/admin/settings           (X-Admin-Token)
 *  - PUT  /api/admin/settings           (X-Admin-Token)
 *  - GET  /api/geocode?postcode=...     (public; stub unless GOOGLE_MAPS_API_KEY set)
 *  - GET  /api/zonesAdminV2             (public; proxies zonesPublic from :8080)
 */
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PORT = 8082;
const DATA_DIR = process.env.DATA_DIR || '/var/www/barnwell-proxy/data';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

function jsonError(res, code, error, detail) {
  res.status(code).json({ ok: false, error, detail: detail ?? null });
}

async function readJSONSafe(file, fallback = {}) {
  try {
    const txt = (await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}
async function writeJSONSafe(file, obj) {
  const tmp = file + '.tmp';
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
}

/* -------- health -------- */
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'admin-overlay', time: new Date().toISOString() });
});

/* -------- public settings -------- */
app.get('/api/settings', async (_req, res) => {
  res.json(await readJSONSafe(SETTINGS_FILE, {}));
});

/* -------- admin guard -------- */
function requireAdmin(req, res, next) {
  const tok = req.header('X-Admin-Token') || '';
  if (!ADMIN_TOKEN || tok !== ADMIN_TOKEN) {
    return jsonError(res, 401, 'unauthorized', 'missing or invalid X-Admin-Token');
  }
  next();
}

/* -------- admin settings -------- */
app.get('/api/admin/settings', requireAdmin, async (_req, res) => {
  res.json(await readJSONSafe(SETTINGS_FILE, {}));
});
app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const incoming = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!incoming) return jsonError(res, 400, 'bad_request', 'JSON body required');
  if (!incoming.businessHours || !incoming.slotConfig) {
    return jsonError(res, 400, 'invalid_settings', { need: ['businessHours', 'slotConfig'] });
  }
  await writeJSONSafe(SETTINGS_FILE, incoming);
  res.json({ ok: true, saved: true });
});

/* -------- geocode (minimal stub) -------- */
app.get('/api/geocode', async (req, res) => {
  const postcode = (req.query.postcode || '').toString().trim();
  if (!postcode) return res.json({ results: [] });
  // Stub: return empty unless you wire GOOGLE_MAPS_API_KEY + fetch to Maps Geocoding here.
  return res.json({ results: [] });
});

/* -------- zonesAdminV2 (compat) --------
   Delegates to main app zonesPublic on :8080 and optionally filters by ?activeOnly=true
------------------------------------------------- */
app.get('/api/zonesAdminV2', async (req, res) => {
  try {
    const r = await fetch('http://127.0.0.1:8080/api/zonesPublic', { headers: { 'Host': 'api.barnwellpizzandgrill.co.uk' }});
    if (!r.ok) return jsonError(res, r.status, 'upstream_error', `zonesPublic ${r.status}`);
    const data = await r.json(); // expect an array
    const activeOnly = String(req.query.activeOnly || '').toLowerCase() === 'true';
    const out = Array.isArray(data) ? (activeOnly ? data.filter(z => z && z.active) : data) : data;
    res.json(out);
  } catch (e) {
    return jsonError(res, 502, 'bad_gateway', String(e && e.message || e));
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`admin-overlay listening on 127.0.0.1:${PORT} (DATA_DIR=${DATA_DIR})`);
});
