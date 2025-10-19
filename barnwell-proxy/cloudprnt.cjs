#!/usr/bin/env node
/**
 * Barnwell CloudPRNT mini-server
 * - Listens on :8091
 * - Stores jobs under ${DATA_DIR}/cloudprnt/jobs
 * - Announces jobs via /cloudprnt/poll?key=SECRET
 * - Delivers bytes for GET /cloudprnt/poll?mac=...&type=text/plain or /cloudprnt/job/:id
 * - Text is encoded as CP437 so £ prints correctly on Star TSP100IV.
 */

import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import iconv from 'iconv-lite';

const PORT = 8091;
const ADMIN_TOKEN     = process.env.ADMIN_TOKEN || 'CHANGE_ME';
const CLOUDPRNT_SECRET= process.env.CLOUDPRNT_SECRET || 'CHANGE_ME';
const DATA_DIR        = process.env.DATA_DIR || '/var/www/barnwell-proxy/data';
const JOB_DIR         = path.join(DATA_DIR, 'cloudprnt', 'jobs');

fs.mkdirSync(JOB_DIR, { recursive: true });

const asciiSep = '-'.repeat(62);  // ASCII-only separator

const fmtMoney = p => {
  const pounds = (p/100).toFixed(2);
  // Use the CP437 pound sign byte when encoding (see below)
  return `£${pounds}`;
};

const pad = (s, n) => (s.length >= n ? s.slice(0,n) : s + ' '.repeat(n - s.length));
const right = (s, n) => (s.length >= n ? s.slice(0,n) : ' '.repeat(n - s.length) + s);

function renderTicket(job) {
  const lines = [];
  const title = `New ${job.fulfilment === 'delivery' ? 'Delivery' : 'Collection'} Order`;
  const when  = job.scheduled_at ? job.scheduled_at : 'ASAP';

  // Center by naive padding to 48 cols
  const center = t => {
    const width = 48;
    const trimmed = t.toString();
    const left = Math.max(0, Math.floor((width - trimmed.length)/2));
    return ' '.repeat(left) + trimmed;
  };

  lines.push(center(title));
  lines.push(center(when));
  lines.push('');
  if (job.customer?.name)   lines.push(`Customer: ${job.customer.name}`);
  if (job.customer?.phone)  lines.push(`Phone:    ${job.customer.phone}`);
  if (job.customer?.address){
    const addr = job.customer.address.replace(/\r\n/g,'\n').split('\n');
    addr.forEach(a => lines.push(a));
  }
  lines.push('');
  lines.push(asciiSep);

  // items
  let subtotal = 0;
  (job.items||[]).forEach(it => {
    const qty = it.quantity || 1;
    const lineTotal = (it.unit_pence||0) * qty;
    subtotal += lineTotal;

    const head = `${qty} x ${it.name}`;
    lines.push(pad(head, 34) + right(fmtMoney(lineTotal), 14));

    // variants
    (it.variants||[]).forEach(v => {
      lines.push(`  ${v.group.toUpperCase()}: ${v.choice}`);
    });
    // modifiers
    (it.modifiers||[]).forEach(m => {
      const choices = Array.isArray(m.choices) ? m.choices.join(', ') : String(m.choices||'');
      lines.push(`  ${m.group.toUpperCase()}: ${choices}`);
    });
  });

  lines.push(asciiSep);

  const delivery = job.delivery_fee_pence||0;
  const total = subtotal + delivery;

  lines.push(pad('SUBTOTAL', 34) + right(fmtMoney(subtotal), 14));
  lines.push(pad('DELIVERY FEE', 34) + right(fmtMoney(delivery), 14));
  lines.push(pad('TOTAL', 34) + right(fmtMoney(total), 14));
  lines.push('\n\n');

  const txt = lines.join('\n');

  // IMPORTANT: encode to CP437 so £ (0x9C) prints on Star.
  // Replace the Unicode £ with the CP437 byte by providing a custom mapping:
  const mapped = txt.replace(/£/g, '\x9C');

  // iconv will pass through 0x00–0xFF; ensure we encode as 'cp437'
  const buf = iconv.encode(mapped, 'cp437', { defaultChar: '?' });
  return buf;
}

function saveJobObject(obj) {
  const id = crypto.randomUUID();
  const f = path.join(JOB_DIR, `${id}.json`);
  fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  return id;
}

function nextJobId() {
  const files = fs.readdirSync(JOB_DIR).filter(f => f.endsWith('.json')).sort();
  return files.length ? path.basename(files[0], '.json') : null;
}

function readJobBytes(id) {
  const f = path.join(JOB_DIR, `${id}.json`);
  if (!fs.existsSync(f)) return null;
  const job = JSON.parse(fs.readFileSync(f, 'utf8'));
  return renderTicket(job);
}

function deleteJob(id) {
  const f = path.join(JOB_DIR, `${id}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  });
  res.end(body);
}

function sendBytes(res, buf) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=cp437',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  try {
    const { pathname, query } = url.parse(req.url, true);

    // Simple hello for nginx health check
    if (pathname === '/printer-hello.txt') {
      const body = Buffer.from('cloudprnt-hello\n');
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'X-Debug-Route': 'cloudprnt-hello',
        'Content-Length': body.length
      });
      return res.end(body);
    }

    // enqueue jobs (admin)
    if (pathname === '/api/cloudprnt/enqueue' && req.method === 'POST') {
      if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return sendJSON(res, 403, { ok:false, error:'forbidden' });
      let body = [];
      req.on('data', c => body.push(c));
      req.on('end', () => {
        try {
          const obj = JSON.parse(Buffer.concat(body).toString('utf8'));
          const id = saveJobObject(obj);
          const bytes = renderTicket(obj);
          fs.writeFileSync(path.join(JOB_DIR, `${id}.txt`), bytes); // debug artifact
          console.log(`[enqueue] ${id} (${bytes.length} bytes)`);
          sendJSON(res, 200, { ok:true, jobId:id, bytes: bytes.length });
        } catch(e) {
          console.error('enqueue parse error', e);
          sendJSON(res, 400, { ok:false, error:'bad_json' });
        }
      });
      return;
    }

    // CloudPRNT: announce jobs
    if (pathname === '/cloudprnt/poll' && req.method === 'GET') {
      if (query.key !== CLOUDPRNT_SECRET) return res.writeHead(401).end();
      const id = nextJobId();
      if (!id) {
        return res.writeHead(204).end();
      }
      const buf = readJobBytes(id);
      const payload = {
        jobReady: true,
        mediaTypes: ['text/plain','text/plain; charset=cp437'],
        contentType: 'text/plain; charset=cp437',
        jobFetchUrl: `${req.headers['x-forwarded-proto']?'https':'http'}://${req.headers.host}/cloudprnt/job/${id}?key=${encodeURIComponent(CLOUDPRNT_SECRET)}`,
        deleteMethod: 'DELETE',
        jobDeleteUrl: `${req.headers['x-forwarded-proto']?'https':'http'}://${req.headers.host}/cloudprnt/job/${id}?key=${encodeURIComponent(CLOUDPRNT_SECRET)}`,
        jobId: id
      };
      console.log(`[announce] ${id} (${buf.length} bytes)`);
      return sendJSON(res, 200, payload);
    }

    // Star can also fetch using GET /cloudprnt/poll?type=text/plain
    if (pathname === '/cloudprnt/poll' && req.method === 'POST' && query.key === CLOUDPRNT_SECRET && query.type) {
      const id = nextJobId();
      if (!id) return res.writeHead(204).end();
      const buf = readJobBytes(id);
      console.log(`[fetch-inline] ${id} (${buf.length} bytes)`);
      // do not delete yet; printer will ack with DELETE below
      return sendBytes(res, buf);
    }

    // Explicit job fetch
    if (pathname.startsWith('/cloudprnt/job/') && req.method === 'GET') {
      if (query.key !== CLOUDPRNT_SECRET) return res.writeHead(401).end();
      const id = pathname.split('/').pop();
      const buf = readJobBytes(id);
      if (!buf) return res.writeHead(404).end();
      console.log(`[fetch] ${id} (${buf.length} bytes)`);
      return sendBytes(res, buf);
    }

    // Printer ACK: delete job after successful print
    if (pathname === '/cloudprnt/poll' && req.method === 'DELETE') {
      if (query.key !== CLOUDPRNT_SECRET) return res.writeHead(401).end();
      const id = nextJobId();
      if (id) {
        deleteJob(id);
        console.log(`[ack] deleted ${id} (${query.code||''})`);
      }
      return sendJSON(res, 200, { ok:true });
    }

    res.writeHead(404).end();
  } catch (e) {
    console.error('server error', e);
    res.writeHead(500).end();
  }
});

server.listen(PORT, () => {
  console.log(`cloudprnt listening on :${PORT} jobs=${JOB_DIR}`);
});
