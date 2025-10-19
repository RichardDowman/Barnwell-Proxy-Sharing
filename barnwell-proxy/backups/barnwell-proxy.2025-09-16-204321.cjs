/* barnwell-proxy.cjs v1.2.0
 * Barnwell Grill proxy
 */

const express = require('express');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '2025BARNWELLAPP';

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
const SQUARE_LOCATION_ID  = process.env.SQUARE_LOCATION_ID  || '';
const POST_PAYMENT_REDIRECT_URL = process.env.POST_PAYMENT_REDIRECT_URL
  || process.env.SUCCESS_URL
  || 'https://barnwellgrill.gbapps.cmslogin.io/ordering-success';

const CATALOG_TYPES_DEFAULT = 'ITEM,ITEM_VARIATION,CATEGORY,MODIFIER_LIST,ITEM_OPTION';
const APP_VERSION = '1.2.0';

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  const defaults = [
    ['settings.json', JSON.stringify({
      businessHours: {
        days: [
          {open:'11:00',close:'22:00'},
          {open:'11:00',close:'22:00'},
          {open:'11:00',close:'22:00'},
          {open:'11:00',close:'22:00'},
          {open:'11:00',close:'22:00'},
          {open:'11:00',close:'22:00'},
          {open:'11:00',close:'22:00'}
        ],
        leadTimeMinutes: 30,
        allowPreorderDays: 1
      },
      slotConfig: {
        collection:{ granularity_minutes:60, min_lead_minutes:30, min_order_pence:800 },
        delivery:{   granularity_minutes:60, min_lead_minutes:45, min_order_pence:1200 }
      },
      manualClose: { closed: false, reopenAt: null }
    }, null, 2)],
    ['zones.json', JSON.stringify({ zones: [] }, null, 2)]
  ];
  for (const [name, content] of defaults) {
    const p = path.join(DATA_DIR, name);
    try { await fs.access(p); } catch { await fs.writeFile(p, content); }
  }
}
async function readJSON(name, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(DATA_DIR, name), 'utf8')); }
  catch { return fallback; }
}
async function writeJSON(name, obj) {
  await fs.writeFile(path.join(DATA_DIR, name), JSON.stringify(obj, null, 2));
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Token,ngrok-skip-browser-warning');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get(['/','/health'], (req, res) => {
  res.json({ ok:true, service:'barnwell-proxy', version:APP_VERSION, time:new Date().toISOString() });
});

function isAdmin(req) {
  const hdr = req.headers.authorization || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  const x = req.headers['x-admin-token'] || '';
  return (bearer && bearer === ADMIN_TOKEN) || (x && x === ADMIN_TOKEN);
}
function assertAdmin(req, res) {
  if (!isAdmin(req)) { res.status(401).json({ error:'unauthorised' }); return false; }
  return true;
}

/* Admin settings */
app.get('/api/admin/settings', async (_req, res) => {
  const data = await readJSON('settings.json', {});
  res.json(data);
});
app.post('/api/admin/settings', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const current = await readJSON('settings.json', {});
  const next = Object.assign({}, current, req.body || {});
  await writeJSON('settings.json', next);
  res.json({ ok:true, settings: next });
});

/* Zones (public + admin) */
app.get(['/api/zonesPublic', '/api/zones'], async (req, res) => {
  const j = await readJSON('zones.json', { zones: [] });
  const activeOnly = String(req.query.activeOnly || 'true') === 'true';
  const zones = Array.isArray(j.zones) ? j.zones : [];
  res.json({ zones: activeOnly ? zones.filter(z => z.active !== false) : zones });
});
app.get('/api/zonesAdminV2', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const j = await readJSON('zones.json', { zones: [] });
  const activeOnly = String(req.query.activeOnly || 'false') === 'true';
  const zones = Array.isArray(j.zones) ? j.zones : [];
  res.json({ zones: activeOnly ? zones.filter(z => z.active !== false) : zones });
});
app.post('/api/zonesAdminV2', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const body = req.body || {};
  const polygon = body.polygon || body.ring || body.coordinates;
  if (!polygon) return res.status(400).json({ error:'polygon_required' });

  const j = await readJSON('zones.json', { zones: [] });
  const zones = Array.isArray(j.zones) ? j.zones : [];
  const id = body.id || crypto.randomUUID();
  const now = new Date().toISOString();

  const payload = {
    id,
    name: body.name || `Zone ${zones.length + 1}`,
    price_pence: Number(body.price_pence || Math.round(Number(body.price || 0) * 100)) || 0,
    active: body.active !== false,
    polygon: Array.isArray(polygon?.coordinates) ? polygon : { type:'Polygon', coordinates: [ polygon ] },
    updatedAt: now,
    createdAt: body.createdAt || now
  };

  const idx = zones.findIndex(z => z.id === id);
  if (idx >= 0) zones[idx] = payload; else zones.push(payload);
  await writeJSON('zones.json', { zones });
  res.json({ ok:true, zone: payload });
});
app.delete('/api/zonesAdminV2', async (req, res) => {
  if (!assertAdmin(req, res)) return;
  const id = req.query.id;
  if (!id) return res.status(400).json({ error:'id_required' });
  const j = await readJSON('zones.json', { zones: [] });
  const next = j.zones.filter(z => z.id !== id);
  await writeJSON('zones.json', { zones: next });
  res.json({ ok:true, removed:id });
});

/* Delivery price with ring normalization */
app.post('/api/delivery-price', async (req, res) => {
  const body = req.body || {};
  let lat = Number(body.lat), lng = Number(body.lng);
  const postcode = (body.postcode || '').trim();

  try {
    if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && postcode) {
      const gj = await (await fetch('https://api.postcodes.io/postcodes/' + encodeURIComponent(postcode))).json();
      if (gj && gj.status === 200 && gj.result) {
        lat = Number(gj.result.latitude); lng = Number(gj.result.longitude);
      }
    }
  } catch {}

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.json({ deliverable:false, reason:'no_coordinates' });
  }

  const j = await readJSON('zones.json', { zones: [] });
  const zones = Array.isArray(j.zones) ? j.zones : [];

  const normalizeRing = (ring) => {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    const [x0,y0] = ring[0].map(Number);
    const looksLngLat = Math.abs(y0) <= 90 && Math.abs(x0) <= 180;
    return looksLngLat ? ring.map(([x,y]) => [Number(x), Number(y)]) : ring.map(([y,x]) => [Number(x), Number(y)]);
  };
  const pointInRing = (X, Y, ring) => {
    let inside = false;
    for (let i=0, j=ring.length-1; i<ring.length; j=i++) {
      const xi = Number(ring[i][0]), yi = Number(ring[i][1]);
      const xj = Number(ring[j][0]), yj = Number(ring[j][1]);
      const intersect = ((yi > Y) !== (yj > Y)) && (X < (xj - xi) * (Y - yi) / (yj - yi + 0.0) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  };

  for (const z of zones) {
    if (z.active === false) continue;
    const ringRaw = (z.polygon && z.polygon.coordinates && z.polygon.coordinates[0]) || z.ring || z.coordinates;
    const ring = normalizeRing(ringRaw);
    if (ring && pointInRing(lng, lat, ring)) {
      return res.json({
        deliverable: true,
        matched: true,
        zoneName: z.name || z.id,
        price_pence: Number(z.price_pence || 0)
      });
    }
  }
  res.json({ deliverable:false, matched:false });
});

/* Geocode (postcodes.io) */
app.get('/api/geocode', async (req, res) => {
  const postcode = (req.query.postcode || '').trim();
  if (!postcode) return res.json({ results: [] });
  try {
    const r = await fetch('https://api.postcodes.io/postcodes/' + encodeURIComponent(postcode));
    const j = await r.json();
    if (j && j.status === 200 && j.result) {
      const lat = j.result.latitude, lng = j.result.longitude;
      return res.json({
        results: [{
          formatted_address: j.result.postcode,
          geometry: { location: { lat, lng } }
        }]
      });
    }
  } catch {}
  res.json({ results: [] });
});

/* Square catalog with pagination */
async function fetchSquareCatalogAll(typesCsv) {
  const types = (typesCsv || CATALOG_TYPES_DEFAULT)
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).join(',');
  if (!SQUARE_ACCESS_TOKEN) throw new Error('Missing SQUARE_ACCESS_TOKEN');

  const collected = [];
  let cursor = null;
  do {
    const url = new URL('https://connect.squareup.com/v2/catalog/list');
    url.searchParams.set('types', types);
    if (cursor) url.searchParams.set('cursor', cursor);

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}` }
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Square catalog error ${r.status}: ${JSON.stringify(j)}`);
    if (Array.isArray(j.objects)) collected.push(...j.objects);
    cursor = j.cursor || null;
  } while (cursor);

  return { objects: collected };
}

app.get('/api/catalog', async (req, res) => {
  try {
    const j = await fetchSquareCatalogAll(req.query.types || CATALOG_TYPES_DEFAULT);
    res.json(j);
  } catch (e) {
    console.error('catalog error', e);
    res.status(500).json({ error:'catalog_failed', detail:String(e.message||e) });
  }
});
app.get('/api/catalogEverything', async (req, res) => {
  try {
    const j = await fetchSquareCatalogAll(req.query.types || CATALOG_TYPES_DEFAULT);
    res.json(j);
  } catch (e) {
    console.error('catalogEverything error', e);
    res.status(500).json({ error:'catalog_failed', detail:String(e.message||e) });
  }
});

/* Square Payment Link — Quick Pay ONLY */
app.post('/api/create-checkout-link', async (req, res) => {
  try {
    if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID) {
      return res.status(500).json({ error:'square_env_missing', detail:'SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID are required' });
    }

    const body = req.body || {};
    // accept either {customer,...} or {meta:{customer:{...}}}
    const customer = body.customer || body.meta?.customer || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const delivery = body.delivery || (body.delivery_fee_pence != null ? { delivery_fee_pence: body.delivery_fee_pence } : null);
    const meta = body.meta || {};

    if (!items.length) return res.status(400).json({ error:'no_items' });
    if (!customer.name || !customer.phone) return res.status(400).json({ error:'customer_required' });

    const normalizedItems = items.map(i => ({
      name: i.name,
      qty: Number(i.qty != null ? i.qty : (i.quantity != null ? i.quantity : 1)) || 1,
      unit_pence: Number(i.unit_pence || 0),
      variant: i.variant || null,
      groups: Array.isArray(i.groups) ? i.groups : []
    }));

    const subtotalPence = normalizedItems.reduce((s,i)=> s + (Number(i.unit_pence || 0) * Number(i.qty || 1)), 0);
    const deliveryPence = meta.fulfilment === 'delivery' ? Number(delivery?.delivery_fee_pence || 0) : 0;
    const totalPence = subtotalPence + deliveryPence;
    if (!Number.isFinite(totalPence) || totalPence <= 0) {
      return res.status(400).json({ error:'invalid_total' });
    }

    const lines = normalizedItems.map(i => {
      const groups = (i.groups || [])
        .filter(g => Array.isArray(g.values) && g.values.length)
        .map(g => `${g.name}: ${g.values.join(', ')}`)
        .join(' | ');
      const varPart = i.variant ? ` (${i.variant})` : '';
      const opts = groups ? ` — ${groups}` : '';
      const each = `£${((Number(i.unit_pence||0))/100).toFixed(2)}`;
      return `• ${i.qty || 1} × ${i.name}${varPart}${opts} — ${each} each`;
    });

    const addressLine = meta.fulfilment === 'delivery' && meta.address ? `\nDelivery: ${meta.address}` : '';
    const whenLine = meta.scheduled_at || meta.time ? `\nWhen: ${meta.scheduled_at || meta.time}` : '';
    const summary =
      `Barnwell Grill Order\n` +
      `${lines.join('\n')}\n` +
      (deliveryPence ? `Delivery Fee: £${(deliveryPence/100).toFixed(2)}\n` : '') +
      `Total: £${(totalPence/100).toFixed(2)}\n` +
      `Customer: ${customer.name} (${customer.phone}${customer.email ? ', ' + customer.email : ''})` +
      `${addressLine}${whenLine}`;

    const payload = {
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: 'Barnwell Grill Order',
        price_money: { amount: totalPence, currency: 'GBP' },
        location_id: SQUARE_LOCATION_ID,
        description: 'Online order via Barnwell Grill'
      },
      checkout_options: {
        ask_for_shipping_address: meta.fulfilment === 'delivery',
        redirect_url: POST_PAYMENT_REDIRECT_URL
      },
      description: summary
    };
    if (payload.order) delete payload.order;

    console.log('[create-checkout-link] sending keys:', Object.keys(payload));

    const r = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const j = await r.json();

    if (!r.ok) {
      console.error('Square create link failed', r.status, j);
      return res.status(500).json({ error:'create_checkout_failed', detail:`Square ${r.status} ${r.statusText}: ${JSON.stringify(j)}` });
    }

    return res.json({ ok:true, raw:j, url: j?.payment_link?.url || null });
  } catch (e) {
    console.error('create-checkout-link error', e);
    res.status(500).json({ error:'server_error', detail:String(e.message || e) });
  }
});

app.use((req, res) => res.status(404).json({ error:'not_found', path:req.path }));
app.use((err, _req, res, _next) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error:'server_error', detail:String(err?.message || err) });
});

ensureDataDir().then(() => {
  app.listen(PORT, () => console.log(`barnwell-proxy v${APP_VERSION} listening on :${PORT}`));
});

