// /var/www/barnwell-proxy/cloudprnt.mjs
import express from "express";
import fs from "fs/promises";
import path from "path";
import { nanoid } from "nanoid";
import iconv from "iconv-lite";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "256kb" }));

// ---- config ----
const PORT = parseInt(process.env.PORT || "8091", 10);
const DATA_DIR = process.env.DATA_DIR || "/var/www/barnwell-proxy/data";
const JOBS_DIR = path.join(DATA_DIR, "cloudprnt", "jobs");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.CLOUDPRNT_SECRET || "";

// ---- helpers ----
async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }
function money(pence) { return `£${(pence / 100).toFixed(2)}`; }
function todayHHMM() { const d=new Date(); const pad=n=>String(n).padStart(2,"0"); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function stripBOM(s) { return s && s.charCodeAt(0)===0xFEFF ? s.slice(1) : s; }
function lf(text){ return text.replace(/\r\n/g,"\n").replace(/\r/g,"\n"); }

// helper: accept key from ?key= or from X-CloudPRNT-Key header (nginx may set this)
function getRequestKey(req){
  try{
    const q = req && req.query && req.query.key ? String(req.query.key) : "";
    if(q) return q;
    // look for header (case-insensitive) and decode if percent-encoded
    const h = (req && req.get) ? (req.get('X-CloudPRNT-Key') || req.get('x-cloudprnt-key')) : (req && req.headers && (req.headers.get ? req.headers.get('x-cloudprnt-key') : (req.headers['x-cloudprnt-key'] || req.headers['x-cloudprnt_key'] || "")));
    if(h){
      try{ return decodeURIComponent(String(h)); }catch(e){ return String(h); }
    }
    return "";
  }catch(e){ return ""; }
}


// Format a full ticket with variants/modifiers
function render(job){
  const lines=[];
  const when = job.meta?.scheduled_at
    ? new Date(job.meta.scheduled_at).toLocaleString("en-GB",{hour:"2-digit",minute:"2-digit",weekday:"short",day:"2-digit",month:"short"})
    : `Today ${todayHHMM()}`;

  lines.push(`${job.meta?.fulfilment==="delivery"?"New Delivery Order":"New Collection Order"}`);
  lines.push(when); lines.push("");

  const cust=job.meta?.customer||{};
  if(cust.name)  lines.push(`Customer: ${cust.name}`);
  if(cust.phone) lines.push(`Phone:    ${cust.phone}`);
  if(job.meta?.address){
    for(const a of String(job.meta.address).split(/\n|,\s*/).filter(Boolean)){ lines.push(a); }
  }
  if(job.meta?.order_number) lines.push(`Order #:  ${job.meta.order_number}`);
  if(job.meta?.notes)        lines.push(`Notes:    ${job.meta.notes}`);
  lines.push("".padEnd(66,"-"));

  let subtotal=0;
  for(const it of (job.items||[])){
    const qty=it.quantity||1;
    const price=(it.unit_pence||0)*qty; subtotal+=price;
    const title=`${it.name||"Item"}${qty>1?` x${qty}`:""}`;
    const right=money(price);
    const width=42; const pad=width-Math.max(0,title.length);
    lines.push(`${title}${" ".repeat(pad>0?pad:1)}${right}`);

    const groups = Array.isArray(it.groups)?it.groups : (it.modifiers||[]);
    for(const g of groups){
      const gname=(g.name||g.group||"").toUpperCase();
      const values=Array.isArray(g.values)?g.values.join(", ")
                   : Array.isArray(g.selections)?g.selections.join(", ")
                   : (g.value||g.choice||"");
      if(gname || values) lines.push(`  ${gname||"OPTION"}: ${values}`);
    }
    if(it.note) lines.push(`  NOTES: ${it.note}`);
    lines.push("");
  }

  lines.push("".padEnd(66,"-"));
  const delivery=job.delivery_fee_pence||0; const total=subtotal+delivery;
  const right2=(label,val)=>{ const left=`${label}:`; const pad=42-left.length; return `${left}${" ".repeat(pad>0?pad:1)}${money(val)}`; };
  lines.push(right2("SUBTOTAL",subtotal));
  lines.push(right2("DELIVERY FEE",delivery));
  lines.push(right2("TOTAL",total));
  lines.push(""); lines.push("");
  return lf(lines.join("\n"));
}

// Prolog helper
const STAR_CP858_PROLOG = Buffer.from([0x1B,0x52,0x02, 0x1B,0x1D,0x74,0x04]); // ESC R 02 (UK) + ESC GS t 04 (CP858)

// Convert a JS string to CP858 bytes (used when creating files from Unicode)
function stringToCp858Bytes(text){
  const body = iconv.encode(stripBOM(text||""), "cp858");
  return Buffer.concat([STAR_CP858_PROLOG, body]);
}

// When the job file already contains CP858 bytes (created by scripts), send them as-is:
function bufferToStarBytes(buffer){
  const hasProlog = buffer.length >= 7 &&
    buffer[0] === 0x1B && buffer[1] === 0x52 && buffer[2] === 0x02 &&
    buffer[3] === 0x1B && buffer[4] === 0x1D && buffer[5] === 0x74 && buffer[6] === 0x04;
  if(hasProlog) return buffer;
  return Buffer.concat([STAR_CP858_PROLOG, buffer]);
}

// FS queue helpers
async function listJobs(){ await ensureDir(JOBS_DIR); const names=(await fs.readdir(JOBS_DIR)).filter(f=>f.endsWith(".txt")); names.sort(); return names.map(n=>path.join(JOBS_DIR,n)); }
async function takeNextJob(){ const files=await listJobs(); if(!files.length) return null; const f=files[0]; const s=path.join(JOBS_DIR,"_sending_"+path.basename(f)); try{await fs.rename(f,s);}catch{} return s; }
async function deleteJobFile(p){ try{await fs.unlink(p);}catch{} }
async function readJobBuffer(p){ return await fs.readFile(p); } // return Buffer
async function currentSending(){
  try{const n=(await fs.readdir(JOBS_DIR)).find(x=>x.startsWith("_sending_")&&x.endsWith(".txt"));
      return n?path.join(JOBS_DIR,n):null;}catch{return null;}
}

// CloudPRNT: poll
async function handlePoll(req,res,next){
  if("type" in req.query) return next();
  const key=getRequestKey(req);
  if(!ADMIN_TOKEN || key!==ADMIN_TOKEN) return res.status(401).json({ok:false,error:"unauthorized"});

  let locked=null;
  const cur=(await fs.readdir(JOBS_DIR).catch(()=>[])).find(n=>n.startsWith("_sending_")&&n.endsWith(".txt"));
  locked = cur ? path.join(JOBS_DIR,cur) : await takeNextJob();

  if(!locked) return res.status(204).end();

  const id=path.basename(locked).replace(/^_sending_/,"").replace(/\.txt$/,"");
  const host=(req.headers["x-forwarded-host"]||req.headers["host"]||"127.0.0.1").toString();
  const base=`${req.protocol}://${host}`;

  res.json({
    jobReady:true,
    mediaTypes:["application/octet-stream"],
    contentType:"application/octet-stream",
    jobFetchUrl:`${base}/cloudprnt/job/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}&type=application/octet-stream`,
    deleteMethod:"DELETE",
    jobDeleteUrl:`${base}/cloudprnt/job/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`,
    jobId:id
  });
}
app.get("/cloudprnt/poll",handlePoll);
app.get("/cloudprnt/poll", async (req,res,next)=>{
  if(!("type" in req.query)) return next();
  const key=getRequestKey(req);
  if(!(process.env.ADMIN_TOKEN||process.env.CLOUDPRNT_SECRET)||key!==(process.env.ADMIN_TOKEN||process.env.CLOUDPRNT_SECRET)) return res.status(401).end();
  const sending = await currentSending();
  if(!sending){ return res.status(204).end(); }

  // Read raw bytes and serve them without re-decoding as UTF-8
  const buf = await readJobBuffer(sending); // Buffer
  const bytes = bufferToStarBytes(buf);
  res.set("Content-Type", String(req.query.type||"application/octet-stream"));
  res.set("Content-Length", String(bytes.length));
  res.send(bytes);
  await fs.unlink(sending).catch(()=>{});
  return;
});
app.post("/cloudprnt/poll",handlePoll);

// CloudPRNT: fetch raw bytes
app.get("/cloudprnt/job/:id", async (req,res)=>{
  const key=getRequestKey(req);
  if(!ADMIN_TOKEN || key!==ADMIN_TOKEN) return res.status(401).end();

  const id=req.params.id;
  const sending=path.join(JOBS_DIR,`_sending_${id}.txt`);
  const ok=await fs.access(sending).then(()=>true).catch(()=>false);
  if(!ok) return res.status(404).end();

  // Serve raw bytes (don't read as UTF-8)
  const buf = await readJobBuffer(sending);
  const bytes = bufferToStarBytes(buf);
  res.set("Content-Type","application/octet-stream");
  res.set("Content-Length",String(bytes.length));
  res.send(bytes);
});

// CloudPRNT: delete after success
app.delete("/cloudprnt/poll", async (req,res)=>{
  const key=getRequestKey(req);
  if(!((process.env.ADMIN_TOKEN||process.env.CLOUDPRNT_SECRET))||key!==(process.env.ADMIN_TOKEN||process.env.CLOUDPRNT_SECRET)) return res.status(401).end();
  const sending=await currentSending();
  if(!sending) return res.json({ok:false,deleted:0});
  try{ await fs.unlink(sending); }catch{}
  try{ await fs.writeFile(path.join(JOBS_DIR,"._sent.flag"), new Date().toISOString()); }catch{}
  return res.json({ok:true,deleted:1});
});
app.delete("/cloudprnt/job/:id", async (req,res)=>{
  const key=getRequestKey(req);
  if(!ADMIN_TOKEN || key!==ADMIN_TOKEN) return res.status(401).end();

  const id=req.params.id;
  const sending=path.join(JOBS_DIR,`_sending_${id}.txt`);
  const ok=await fs.access(sending).then(()=>true).catch(()=>false);
  if(!ok) return res.json({ok:false,deleted:0});

  await deleteJobFile(sending);
  await fs.writeFile(path.join(JOBS_DIR,`._sent_${id}.flag`), new Date().toISOString());
  res.json({ok:true,deleted:1});
});

// Admin: enqueue locally
app.post("/cloudprnt/enqueue-local", async (req,res)=>{
  if((req.get("X-Admin-Token")||"")!==ADMIN_TOKEN) return res.status(401).json({ok:false,error:"unauthorized"});
  await ensureDir(JOBS_DIR);
  const id=nanoid();
  const text=render(req.body||{});
  const ts=new Date().toISOString().replace(/[-:TZ.]/g,"").slice(0,14);
  const file=path.join(JOBS_DIR,`${ts}-${id}.txt`);

  // Write CP858 bytes to disk so files on disk are single-byte CP858 (no BOM)
  const body = iconv.encode(stripBOM(text), "cp858");
  await fs.writeFile(file, body); // write Buffer (CP858)
  res.json({ok:true,jobId:id,bytes:body.length});
});

// boot
await ensureDir(JOBS_DIR);
app.listen(PORT,()=>console.log(`cloudprnt listening on :${PORT} jobs=${JOBS_DIR}`));

