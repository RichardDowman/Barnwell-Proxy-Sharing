#!/usr/bin/env node
/**
 * Barnwell Grill Proxy — stable endpoints + Square webhook + Goodcom feed + order history (Firestore or local)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

/* Load ENV */
(function loadEnvFile(){try{const p='/etc/barnwell-proxy.env';if(fs.existsSync(p)){const t=fs.readFileSync(p,'utf8');for(const l of t.split(/\r?\n/)){const m=l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);if(!m)continue;const k=m[1];let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(k in process.env))process.env[k]=v;}}}catch(_){}})();

/* CONFIG */
const PORT=parseInt(process.env.PORT||'8080',10);
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data');
const ORDERS_DIR=path.join(DATA_DIR,'orders');
const PRINTER_DIR=path.join(DATA_DIR,'printer');
const QUEUE_DIR=path.join(PRINTER_DIR,'queue');
const DONE_DIR=path.join(PRINTER_DIR,'done');
const ADMIN_TOKEN=(process.env.ADMIN_TOKEN||'').trim();
const GOOGLE_MAPS_API_KEY=process.env.GOOGLE_MAPS_API_KEY||'';
const CORS_ORIGINS=(process.env.CORS_ORIGINS||process.env.CORS_ALLOW_ORIGINS||'https://barnwellgrill.gbapps.cmslogin.io').split(',').map(s=>s.trim()).filter(Boolean);
const SQUARE_ENV=(process.env.SQUARE_ENV||'production').toLowerCase();
const SQUARE_BASE=SQUARE_ENV==='sandbox'?'https://connect.squareupsandbox.com':'https://connect.squareup.com';
const SQUARE_ACCESS_TOKEN=process.env.SQUARE_ACCESS_TOKEN||'';
const SQUARE_LOCATION_ID=process.env.SQUARE_LOCATION_ID||'';
const CHECKOUT_RETURN_URL=process.env.CHECKOUT_RETURN_URL||process.env.ORDERING_RETURN_URL||'https://barnwellgrill.gbapps.cmslogin.io/ordering?paid=1';
const SQUARE_WEBHOOK_SIGNATURE_KEY=process.env.SQUARE_WEBHOOK_SIGNATURE_KEY||'';
const PRINTER_TOKEN=(process.env.PRINTER_TOKEN||'').trim();
const FIREBASE_CREDENTIALS_FILE=process.env.FIREBASE_CREDENTIALS_FILE||'';

for(const d of [DATA_DIR,ORDERS_DIR,PRINTER_DIR,QUEUE_DIR,DONE_DIR]){try{fs.mkdirSync(d,{recursive:true});}catch(_){}}let admin=null,db=null;
try{if(FIREBASE_CREDENTIALS_FILE&&fs.existsSync(FIREBASE_CREDENTIALS_FILE)){admin=require('firebase-admin');admin.initializeApp({credential:admin.credential.cert(require(FIREBASE_CREDENTIALS_FILE))});db=admin.firestore();console.log('[firebase] Firestore initialized');}else{console.log('[firebase] credentials file not set or missing; using local file fallback for order history');}}catch(e){console.warn('[firebase] init failed',e);}

/* Helpers */
const fetch=global.fetch||((...a)=>Promise.reject(new Error('fetch not available')));
const readJSON=(f,fb=null)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return fb;}};
const writeJSON=(f,o)=>fs.writeFileSync(f,JSON.stringify(o,null,2));
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const money=p=>'£'+(Number(p||0)/100).toFixed(2);
const nowISO=()=>new Date().toISOString();
function setCors(req,res){const origin=req.headers.origin||'';if(!origin){res.setHeader('Access-Control-Allow-Origin','*');return;}if(CORS_ORIGINS.includes(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}else{res.setHeader('Access-Control-Allow-Origin',CORS_ORIGINS[0]||'*');res.setHeader('Vary','Origin');}}
function cors(req,res,next){setCors(req,res);res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Admin-Token, ngrok-skip-browser-warning, x-square-signature, x-square-hmacsha256-signature');res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, PATCH, DELETE, OPTIONS');if(req.method==='OPTIONS')return res.status(204).end();next();}
function normalizePhoneUK(phone){if(!phone)return'';let s=String(phone).replace(/[().\-\s]/g,'');if(s.startsWith('00'))s='+'+s.slice(2);if(/^0\d{9,10}$/.test(s))s='+44'+s.slice(1);if(/^\d{10,11}$/.test(s))s='+44'+s;if(/^\+\d{7,15}$/.test(s))return s;const d=s.replace(/\D/g,'');if(/^\d{10,11}$/.test(d))return'+44'+d;if(/^\d{7,15}$/.test(d))return'+'+d;return'';}
function splitName(full){if(!full)return{given_name:'',family_name:''};const ps=String(full).trim().split(/\s+/);return ps.length===1?{given_name:ps[0],family_name:''}:{given_name:ps[0],family_name:ps.slice(1).join(' ')};}
function pointInRing(lng,lat,ring){if(!Array.isArray(ring)||ring.length<3)return false;let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const xi=Number(ring[i][0]),yi=Number(ring[i][1]);const xj=Number(ring[j][0]),yj=Number(ring[j][1]);const intersect=((yi>lat)!==(yj>lat))&&(lng<(xj-xi)*(lat-yi)/((yj-yi)||1e-12)+xi);if(intersect)inside=!inside;}return inside;}
async function geocodeWithGoogle(addr){const url='https://maps.googleapis.com/maps/api/geocode/json?address='+encodeURIComponent(addr)+'&key='+encodeURIComponent(GOOGLE_MAPS_API_KEY);const r=await fetch(url);return await r.json().catch(()=>null);}
async function geocodeWithPostcodesIo(pc){try{const r=await fetch('https://api.postcodes.io/postcodes/'+encodeURIComponent(pc));return await r.json().catch(()=>null);}catch(_){return null;}}
function buildReceipt(payload){const width=63,dash='-'.repeat(width);const items=Array.isArray(payload.items)?payload.items:[];const fee=clamp(Number(payload.delivery_fee_pence||0),0,10_000_000);const meta=payload.meta||{},customer=meta.customer||{};const fulfil=(meta.fulfilment||'collection').toLowerCase();const sch=meta.scheduled_at?new Date(meta.scheduled_at):null;let dateStr='ASAP';if(sch&&!isNaN(sch)){const d=sch.getDate(),m=sch.toLocaleString('default',{month:'short'});const hh=String(sch.getHours()).padStart(2,'0'),mm=String(sch.getMinutes()).padStart(2,'0');let ord='th';if(![11,12,13].includes(d%100)){if(d%10===1)ord='st';else if(d%10===2)ord='nd';else if(d%10===3)ord='rd';}dateStr=`${d}${ord} ${m} @ ${hh}:${mm}`;}const lines=[];lines.push('                             ORDER');lines.push(`ORDER TYPE = ${fulfil.toUpperCase()}`);lines.push(`ORDER DATE = ${dateStr}`);lines.push('');lines.push(`Name: ${customer.name||''}`);lines.push(`Phone: ${customer.phone||''}`);if(fulfil==='delivery'&&meta.address)lines.push(`Address: ${meta.address}`);lines.push('');lines.push(dash);for(const it of items){const qty=Number(it.quantity||1)||1;const unit=Number(it.unit_pence||0)||0;const total=qty*unit;const name=String(it.name||'Item');theTitle=qty>1?`${name} (+${qty-1})`:name;const price=money(total);const left=width-price.length;const title=theTitle.length>left?theTitle.slice(0,left):theTitle;lines.push(title.padEnd(left,' ')+price);if(Array.isArray(it.groups)){for(const g of it.groups){if(!g||!g.name)continue;const vals=Array.isArray(g.values)?g.values.filter(Boolean):[];if(!vals.length)continue;lines.push(`${g.name}: ${vals.join(', ')}`);}}lines.push(dash);}const subtotal=items.reduce((s,it)=>s+(Number(it.unit_pence||0)*(Number(it.quantity||1)||1)),0);const total=subtotal+fee;const tot=(label,amt)=>{const lbl=label.toUpperCase()+':';const amtTxt=money(amt);const space=width-lbl.length-amtTxt.length;return lbl+(space>0?' '.repeat(space):' ')+amtTxt;};lines.push(tot('SUBTOTAL',subtotal));lines.push(tot('DELIVERY FEE',fee));lines.push(tot('TOTAL',total));lines.push('');return lines.join('\n');}
function contactKeyFrom(phone,email){const norm=normalizePhoneUK(phone||'');const val=norm||String(email||'').trim().toLowerCase();if(!val)return null;return crypto.createHash('sha256').update(val).digest('hex');}

/* EXPRESS */
const app=express();app.use(cors);

/* Webhook */
app.post('/api/square-webhook',express.raw({type:'application/json'}),async (req,res)=>{try{
  if(SQUARE_WEBHOOK_SIGNATURE_KEY){
    const hA=String(req.headers['x-square-signature']||'');
    const hB=String(req.headers['x-square-hmacsha256-signature']||'');
    const calc=crypto.createHmac('sha256',SQUARE_WEBHOOK_SIGNATURE_KEY).update(req.body).digest('base64');
    if((hA&&hA!==calc)&&(hB&&hB!==calc))return res.status(401).send('signature_mismatch');
    if(!hA&&!hB)return res.status(401).send('signature_required');
  }
  const evt=JSON.parse(req.body.toString('utf8'));
  const type=evt?.type||evt?.event_type||'';
  const payment=evt?.data?.object?.payment||null;

  let order=null;
  if(payment?.payment_link_id){
    const files=fs.readdirSync(ORDERS_DIR).filter(f=>f.endsWith('.json'));
    for(const f of files){const o=readJSON(path.join(ORDERS_DIR,f),null);if(o&&o.payment_link_id===payment.payment_link_id){order=o;break;}}
  }
  if(!order){
    const ref=payment?.reference_id||payment?.order_id||payment?.note||null;
    if(ref&&fs.existsSync(path.join(ORDERS_DIR,ref+'.json')))order=readJSON(path.join(ORDERS_DIR,ref+'.json'),null);
  }
  if(!order){
    try{fs.writeFileSync(path.join(ORDERS_DIR,'unmatched-'+Date.now()+'.json'),JSON.stringify(evt,null,2));}catch(_){}
    return res.json({ok:true,matched:false});
  }

  const status=payment?.status||'';
  const completed=/COMPLETED|PAID|CAPTURED/i.test(status)||/payment\.created/i.test(type);

  const payload=order.payload||{};const customer=(payload.meta&&payload.meta.customer)||{};const ck=contactKeyFrom(customer.phone,customer.email);
  order.payment={id:payment?.id||null,status,raw:payment}; if(ck) order.contactKey=ck; writeJSON(path.join(ORDERS_DIR,order.order_ref+'.json'),order);

  if(completed&&!order.sentToPrinter){
    enqueueTicket(order.printable_receipt||'ORDER\n(no receipt text)\n',{order_ref:order.order_ref,payment_id:payment?.id||null});
    order.sentToPrinter=true; writeJSON(path.join(ORDERS_DIR,order.order_ref+'.json'),order);
    if(db){try{
      const doc={order_ref:order.order_ref,created_at:order.created_at||nowISO(),total_pence:order.total_pence||0,items:payload.items||[],delivery_fee_pence:payload.delivery_fee_pence||0,meta:payload.meta||{},payment:{id:payment?.id||null,status}};
      if(ck)doc.contactKey=ck; if(customer)doc.customer={name:customer.name||'',phone:customer.phone||'',email:customer.email||''};
      await db.collection('orders').doc(order.order_ref).set(doc,{merge:true});
    }catch(e){console.warn('[firebase] write order failed',e);}}
    return res.json({ok:true,printedQueued:true});
  }
  return res.json({ok:true,matched:true,completed,status,alreadyQueued:!!order.sentToPrinter});
}catch(e){return res.status(500).json({ok:false,error:String(e&&e.message||e)});}});

/* JSON for rest */
app.use(express.json({limit:'2mb'}));

const settingsFile=path.join(DATA_DIR,'settings.json');
const zonesFile=path.join(DATA_DIR,'zones.json');
if(!fs.existsSync(settingsFile))writeJSON(settingsFile,{});
if(!fs.existsSync(zonesFile))writeJSON(zonesFile,{zones:[]});

/* Core endpoints */
app.get('/api/health',(req,res)=>{setCors(req,res);res.json({ok:true,env:SQUARE_ENV});});
function checkAdmin(req,res){if(!ADMIN_TOKEN){res.status(500).json({error:'admin_token_not_configured'});return false;}if((req.headers['x-admin-token']||'').trim()!==ADMIN_TOKEN){res.status(401).json({error:'unauthorized'});return false;}return true;}
app.get('/api/settings',(req,res)=>{setCors(req,res);const j=readJSON(settingsFile,{});res.json({businessHours:j.businessHours||{},slotConfig:j.slotConfig||{},manualClose:j.manualClose||{closed:false,reopenAt:null},manualClosed:!!(j.manualClose&&j.manualClose.closed),reopenAt:j.manualClose?j.manualClose.reopenAt:null,weekly:j.weekly||undefined});});
app.get('/api/admin/settings',(req,res)=>{setCors(req,res);if(!checkAdmin(req,res))return;res.json(readJSON(settingsFile,{}));});
app.put('/api/admin/settings',(req,res)=>{setCors(req,res);if(!checkAdmin(req,res))return;const cur=readJSON(settingsFile,{});const merged=Object.assign({},cur,req.body||{});writeJSON(settingsFile,merged);res.json({ok:true,saved:true});});
app.get('/api/zonesPublic',(req,res)=>{setCors(req,res);res.json({zones:(readJSON(zonesFile,{zones:[]})).zones||[]});});
app.get('/api/zones',(req,res)=>{setCors(req,res);res.json({zones:(readJSON(zonesFile,{zones:[]})).zones||[]});});

/* Geocode */
app.get('/api/geocode',async (req,res)=>{try{setCors(req,res);const pc=(req.query.postcode||req.query.address||'').toString().trim();if(!pc)return res.status(400).json({results:[],status:'ZERO_RESULTS',error:'no_postcode'});if(GOOGLE_MAPS_API_KEY){const j=await geocodeWithGoogle(pc+', UK');return res.json(j||{results:[],status:'ZERO_RESULTS'});}const pj=await geocodeWithPostcodesIo(pc);if(!pj||!pj.result)return res.json({results:[],status:'ZERO_RESULTS'});const p=pj.result;const formatted=[p.admin_ward||'',p.parliamentary_constituency||'',p.postcode||'',p.region||'',p.country||''].filter(Boolean).join(', ')||p.postcode||pc;return res.json({results:[{formatted_address:formatted,geometry:{location:{lat:p.latitude,lng:p.longitude}},postcode:p.postcode}],status:'OK'});}catch(e){return res.status(500).json({results:[],status:'ERROR',error:String(e&&e.message||e)});}});

/* Delivery price */
app.post('/api/delivery-price',async (req,res)=>{try{setCors(req,res);const body=req.body||{};let {lat,lng,postcode}=body;let L=(typeof lat==='number')?lat:null;let G=(typeof lng==='number')?lng:null;if((L==null||G==null)&&postcode){if(GOOGLE_MAPS_API_KEY){const j=await geocodeWithGoogle(postcode+', UK').catch(()=>null);const loc=j?.results?.[0]?.geometry?.location;if(loc){L=Number(loc.lat);G=Number(loc.lng);}}else{const pj=await geocodeWithPostcodesIo(postcode).catch(()=>null);if(pj&&pj.result){L=Number(pj.result.latitude);G=Number(pj.result.longitude);}}}
const settings=readJSON(settingsFile,{});const minOrder=settings?.slotConfig?.delivery?.min_order_pence??1200;if(L==null||G==null){return res.json({deliverable:false,reason:'no_location',min_order_pence:minOrder});}
const zones=(readJSON(zonesFile,{zones:[]}).zones||[]);let hit=null;for(const z of zones){if(z.active===false)continue;const ring=(z.polygon?.coordinates?.[0])||z.ring||z.coordinates||null;if(!Array.isArray(ring)||ring.length<3)continue;const ringNum=ring.map(pt=>[Number(pt[0]),Number(pt[1])]);if(pointInRing(G,L,ringNum)){hit=z;break;}}if(!hit)return res.json({deliverable:false,matched:false,min_order_pence:minOrder});const pence=Number(hit.price_pence!=null?hit.price_pence:Math.round((hit.price||0)*100));return res.json({deliverable:true,matched:true,zoneName:hit.name||hit.id||'Zone',price_pence:pence,min_order_pence:minOrder});}catch(e){return res.status(500).json({error:'quote_failed',detail:String(e&&e.message||e)});}});

/* Catalog */
app.get('/api/catalogEverything',async (req,res)=>{try{setCors(req,res);if(!SQUARE_ACCESS_TOKEN)return res.status(500).json({error:'no_square_token'});const types=String(req.query.types||'ITEM,ITEM_VARIATION,CATEGORY,MODIFIER_LIST,ITEM_OPTION').split(',').map(s=>s.trim()).filter(Boolean);const body={object_types:types,include_related_objects:true};const r=await fetch(`${SQUARE_BASE}/v2/catalog/search`,{method:'POST',headers:{Authorization:`Bearer ${SQUARE_ACCESS_TOKEN}`,'Square-Version':'2024-08-15','Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json().catch(()=>null);if(!r.ok)return res.status(500).json({error:'square_catalog_error',status:r.status,detail:j});res.json({objects:j.objects||[],related_objects:j.related_objects||[]});}catch(e){res.status(500).json({error:'catalog_failed',detail:String(e)});}});

/* Create checkout link (card) */
app.post('/api/create-checkout-link',async (req,res)=>{try{setCors(req,res);const payload=req.body||{};const items=Array.isArray(payload.items)?payload.items:[];const fee=clamp(Number(payload.delivery_fee_pence||0),0,10_000_000);const subtotal=items.reduce((s,it)=>s+(Number(it.unit_pence||0)*(Number(it.quantity||1)||1)),0);const total=subtotal+fee;if(!SQUARE_ACCESS_TOKEN||!SQUARE_LOCATION_ID)return res.status(500).json({ok:false,error:'square_config_missing'});if(!total||total<=0)return res.status(400).json({ok:false,error:'invalid_total'});const printable_receipt=buildReceipt(Object.assign({},payload,{delivery_fee_pence:fee}));
const pre={};const c=(payload.meta&&payload.meta.customer)||{};if(c.phone){const n=normalizePhoneUK(c.phone);if(/^\+\d{7,15}$/.test(n))pre.buyer_phone_number=n;}if(c.email&&String(c.email).includes('@'))pre.buyer_email=c.email;if(c.name){const n=splitName(c.name);if(n.given_name)pre.buyer_given_name=n.given_name;if(n.family_name)pre.buyer_family_name=n.family_name;}
const orderRef=crypto.randomUUID();let returnUrl=CHECKOUT_RETURN_URL||'';if(returnUrl)returnUrl+=(returnUrl.includes('?')?'&':'?')+'paid=1&ref='+orderRef;
const body={idempotency_key:orderRef,quick_pay:{location_id:SQUARE_LOCATION_ID,name:(payload.title||'Barnwell Grill Order'),price_money:{amount:total,currency:String(payload.currency||'GBP').toUpperCase()}},pre_populated_data:Object.keys(pre).length?pre:undefined,checkout_options:returnUrl?{redirect_url:returnUrl}:undefined};
async function createLink(b){const r=await fetch(`${SQUARE_BASE}/v2/online-checkout/payment-links`,{method:'POST',headers:{Authorization:`Bearer ${SQUARE_ACCESS_TOKEN}`,'Square-Version':'2024-08-15','Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json().catch(()=>null);return{r,j};}
let {r,j}=await createLink(body);if(!r.ok&&body.pre_populated_data){const fb=Object.assign({},body);delete fb.pre_populated_data;({r,j}=await createLink(fb));}
if(!r.ok)return res.status(502).json({ok:false,error:'square_payment_link_failed',status:r.status,detail:j});const url=j?.payment_link?.url||j?.url||null;const paymentLinkId=j?.payment_link?.id||null;res.json({ok:true,method:'square.payment-links',url,printable_receipt,order_ref:orderRef,payment_link_id:paymentLinkId});
try{const ck=contactKeyFrom(c.phone,c.email);const record={order_ref:orderRef,created_at:nowISO(),payload,printable_receipt,payment_link_id:paymentLinkId,payment_link_url:url,total_pence:total,sentToPrinter:false};if(ck)record.contactKey=ck;writeJSON(path.join(ORDERS_DIR,orderRef+'.json'),record);}catch(_){}
}catch(e){res.status(500).json({ok:false,error:'create_checkout_failed',detail:String(e)});}});

/* NEW: Create cash order (no Square, print immediately) */
app.post('/api/create-cash-order',async (req,res)=>{try{
  setCors(req,res);
  const payload=req.body||{};
  const items=Array.isArray(payload.items)?payload.items:[];
  const fee=clamp(Number(payload.delivery_fee_pence||0),0,10_000_000);
  const subtotal=items.reduce((s,it)=>s+(Number(it.unit_pence||0)*(Number(it.quantity||1)||1)),0);
  const total=subtotal+fee;
  if(!items.length||total<=0) return res.status(400).json({ok:false,error:'invalid_order'});

  const printable_receipt=buildReceipt(Object.assign({},payload,{delivery_fee_pence:fee}));
  const orderRef=crypto.randomUUID();
  const c=(payload.meta&&payload.meta.customer)||{};
  const ck=contactKeyFrom(c.phone,c.email);

  // Persist
  const record={order_ref:orderRef,created_at:nowISO(),payload,printable_receipt,total_pence:total,sentToPrinter:true,payment:{method:'cash',status:'UNPAID'}};
  if(ck)record.contactKey=ck;
  writeJSON(path.join(ORDERS_DIR,orderRef+'.json'),record);

  // Print immediately
  enqueueTicket(printable_receipt,{order_ref:orderRef,source:'cash'});

  if(db){try{
    const doc={order_ref:orderRef,created_at:record.created_at,total_pence:total,items:payload.items||[],delivery_fee_pence:payload.delivery_fee_pence||0,meta:payload.meta||{},payment:{method:'cash',status:'UNPAID'}};
    if(ck)doc.contactKey=ck; if(c)doc.customer={name:c.name||'',phone:c.phone||'',email:c.email||''};
    await db.collection('orders').doc(orderRef).set(doc,{merge:true});
  }catch(e){console.warn('[firebase] cash order write failed',e);}}

  return res.json({ok:true,order_ref:orderRef,printable_receipt});
}catch(e){return res.status(500).json({ok:false,error:String(e&&e.message||e)});}});

/* Printer queue */
function listTxt(dir){try{return fs.readdirSync(dir).filter(f=>f.endsWith('.txt')).map(f=>({f,p:path.join(dir,f),m:fs.statSync(path.join(dir,f)).mtimeMs})).sort((a,b)=>a.m-b.m);}catch{return[];}}
function enqueueTicket(text,meta={}){const id=Date.now()+'-'+(meta.order_ref||crypto.randomUUID());const body=(text||'').replace(/\r?\n/g,'\r\n');const txtFile=path.join(QUEUE_DIR,id+'.txt');const jsonFile=path.join(QUEUE_DIR,id+'.json');fs.writeFileSync(txtFile,body);fs.writeFileSync(jsonFile,JSON.stringify({id,meta,enqueued_at:nowISO()},null,2));return id;}
app.get('/api/printer-feed.txt',(req,res)=>{if(PRINTER_TOKEN&&req.query.token!==PRINTER_TOKEN){return res.status(401).type('text').send('unauthorized');}const jobs=listTxt(QUEUE_DIR);if(!jobs.length)return res.status(204).end();const job=jobs[0];const body=fs.readFileSync(job.p,'utf8');const peek=String(req.query.peek||'')==='1';if(!peek){try{fs.renameSync(job.p,path.join(DONE_DIR,path.basename(job.p)));}catch(_){}const twin=job.p.replace(/\.txt$/,'.json');try{if(fs.existsSync(twin))fs.renameSync(twin,path.join(DONE_DIR,path.basename(twin)));}catch{}}res.setHeader('Cache-Control','no-store');res.type('text/plain').send(body);});
app.post('/api/printer-callback',express.text({type:'*/*'}),(req,res)=>{const info={when:nowISO(),ip:(req.headers['x-forwarded-for']||req.ip),body:(req.body||'').slice(0,500)};try{fs.writeFileSync(path.join(PRINTER_DIR,'last-callback.json'),JSON.stringify(info,null,2));}catch(_){}res.json({ok:true});});
app.post('/api/admin/print-test',(req,res)=>{setCors(req,res);if(!checkAdmin(req,res))return;const text=(req.body&&req.body.text)||['TEST PRINT','','This is a test ticket from Barnwell proxy.','-------------------------------','Time: '+nowISO(),''].join('\n');const id=enqueueTicket(text,{source:'admin-test'});res.json({ok:true,enqueued:id});});
/* Admin: force print an order by ref (fallback) */
app.post('/api/admin/print-order',(req,res)=>{setCors(req,res);if(!checkAdmin(req,res))return;const ref=String(req.body?.ref||'').trim();if(!ref)return res.status(400).json({ok:false,error:'missing_ref'});const f=path.join(ORDERS_DIR,ref+'.json');if(!fs.existsSync(f))return res.status(404).json({ok:false,error:'not_found'});const order=readJSON(f,null);const txt=(order?.printable_receipt)||'ORDER\n(no receipt text)\n';enqueueTicket(txt,{order_ref:ref,source:'admin-force-print'});order.sentToPrinter=true;writeJSON(f,order);res.json({ok:true,enqueued:true});});

/* Debug endpoint: printing status and diagnostics */
app.get('/api/debug/print-status',(req,res)=>{setCors(req,res);if(!checkAdmin(req,res))return;try{
  const queueJobs=listTxt(QUEUE_DIR);
  const doneJobs=listTxt(DONE_DIR).slice(-10);
  const lastCallback=fs.existsSync(path.join(PRINTER_DIR,'last-callback.json'))?readJSON(path.join(PRINTER_DIR,'last-callback.json'),null):null;
  const queueList=queueJobs.map(j=>({file:j.f,path:j.p,modified:new Date(j.m).toISOString(),preview:fs.readFileSync(j.p,'utf8').slice(0,200)}));
  const doneList=doneJobs.map(j=>({file:j.f,modified:new Date(j.m).toISOString()}));
  res.json({ok:true,queue:{count:queueJobs.length,jobs:queueList},done:{count:doneJobs.length,recentJobs:doneList},lastCallback,printerToken:PRINTER_TOKEN?'***set***':'not_set',timestamp:nowISO()});
}catch(e){res.status(500).json({ok:false,error:String(e&&e.message||e)});}});

/* Debug endpoint: test print with sample data */
app.post('/api/debug/print-test',(req,res)=>{setCors(req,res);if(!checkAdmin(req,res))return;try{
  const sampleOrder={items:[{name:'Test Burger',quantity:1,unit_pence:950,groups:[{name:'TOPPINGS',values:['Lettuce','Tomato','Cheese']}]},{name:'Chips',quantity:2,unit_pence:250}],delivery_fee_pence:200,meta:{fulfilment:'delivery',customer:{name:'Test Customer',phone:'+447700900000'},address:'123 Test Street, Test Town, TE1 2ST',scheduled_at:null}};
  const customOrder=req.body&&Object.keys(req.body).length>0?req.body:sampleOrder;
  const receipt=buildReceipt(customOrder);
  const id=enqueueTicket(receipt,{source:'debug-test',timestamp:nowISO()});
  res.json({ok:true,jobId:id,receipt,payload:customOrder,message:'Test print job enqueued successfully'});
}catch(e){res.status(500).json({ok:false,error:String(e&&e.message||e)});}});

/* Order history */
app.get('/api/user-orders',async (req,res)=>{try{setCors(req,res);const phone=String(req.query.phone||'').trim();const email=String(req.query.email||'').trim();const limit=Math.min(50,Math.max(1,parseInt(String(req.query.limit||'10'),10)||10));const ck=contactKeyFrom(phone,email);if(!ck)return res.status(400).json({error:'missing_contact'});if(db){const snap=await db.collection('orders').where('contactKey','==',ck).orderBy('created_at','desc').limit(limit).get();const orders=[];snap.forEach(doc=>{const d=doc.data();orders.push({order_ref:d.order_ref,created_at:d.created_at,total_pence:d.total_pence,items:d.items,delivery_fee_pence:d.delivery_fee_pence,meta:d.meta,payment:d.payment||{}});});return res.json({ok:true,orders});}
const files=fs.readdirSync(ORDERS_DIR).filter(f=>f.endsWith('.json'));const rows=[];for(const f of files){const o=readJSON(path.join(ORDERS_DIR,f),null);if(!o)continue;if(o.contactKey&&o.contactKey===ck){rows.push({order_ref:o.order_ref,created_at:o.created_at,total_pence:o.total_pence,items:(o.payload?.items)||[],delivery_fee_pence:o.payload?.delivery_fee_pence||o.delivery_fee_pence||0,meta:o.payload?.meta||o.meta||{},payment:o.payment||{}});}}rows.sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));res.json({ok:true,orders:rows.slice(0,limit)});}catch(e){res.status(500).json({ok:false,error:String(e&&e.message||e)});}});

/* Checkout session */
app.get('/api/checkout-session',(req,res)=>{try{setCors(req,res);const id=String(req.query.id||'').trim();if(!id)return res.status(400).json({ok:false,error:'missing_id'});const refFile=path.join(ORDERS_DIR,id+'.json');let order=fs.existsSync(refFile)?readJSON(refFile,null):null;if(!order){const files=fs.readdirSync(ORDERS_DIR).filter(f=>f.endsWith('.json'));for(const f of files){const o=readJSON(path.join(ORDERS_DIR,f),null);if(o&&(o.payment_link_id===id)){order=o;break;}}}if(!order)return res.json({ok:false,error:'not_found'});const payload=order.payload||{};return res.json({ok:true,payload,printable_receipt:order.printable_receipt||null,created_at:order.created_at||null,total_pence:order.total_pence||null,order_ref:order.order_ref||null,payment:order.payment||{},sentToPrinter:!!order.sentToPrinter});}catch(e){res.status(500).json({ok:false,error:String(e&&e.message||e)});}});

app.listen(PORT,()=>{console.log('barnwell-proxy (stable endpoints + webhook + goodcom + history fallback) listening on :'+PORT);});

app.get('/api/zonesPublic',(req,res)=>{try{if(typeof setCors==='function') setCors(req,res);}catch(_){};try{const fs=require('fs'),path=require('path');const base=(process.env.DATA_DIR&&String(process.env.DATA_DIR).trim())?String(process.env.DATA_DIR).trim():path.join(__dirname,'data');const p=path.join(base,'zones.json');let zones=[];try{const txt=fs.readFileSync(p,'utf8');const j=JSON.parse(txt);zones=Array.isArray(j)?j:(Array.isArray(j.zones)?j.zones:[]);}catch(e){}res.json({zones,updated_at:new Date().toISOString()});}catch(e){res.status(500).json({ok:false,error:String(e&&e.message||e)});}});
// ====== Barnwell: zones admin V2 (appended safely) ======
(function attachZonesAdminV2(){
  try{
    const fs = require('fs');
    const path = require('path');

    function setCorsSafe(req,res){ try{ if (typeof setCors === 'function') setCors(req,res); }catch(_){ } }
    function requireAdmin(req,res){
      try{
        const hdr = String(req.headers['x-admin-token']||'').trim();
        const cfg = String(process.env.ADMIN_TOKEN||'').trim();
        if(!cfg){ try{res.status(500).json({ok:false,error:'admin_token_not_configured'})}catch(_){ } return false; }
        if(hdr !== cfg){ try{res.status(401).json({ok:false,error:'unauthorized'})}catch(_){ } return false; }
        return true;
      }catch(_){
        try{ res.status(500).json({ok:false,error:'admin_check_failed'}) }catch(_){}
        return false;
      }
    }
    function zonesPath(){
      try{
        const base = (process.env.DATA_DIR && String(process.env.DATA_DIR).trim())
          ? String(process.env.DATA_DIR).trim()
          : path.join(__dirname,'data');
        return path.join(base,'zones.json');
      }catch(_){ return path.join(__dirname,'data','zones.json'); }
    }
    function ensureDir(p){ try{ fs.mkdirSync(path.dirname(p), { recursive: true }); }catch(_){ } }
    function loadZones(){
      try{
        const p = zonesPath();
        if (!fs.existsSync(p)) return { zones: [] };
        const txt = fs.readFileSync(p, 'utf8');
        if (!txt || !txt.trim()) return { zones: [] };
        const parsed = JSON.parse(txt);
        if (Array.isArray(parsed)) return { zones: parsed };
        if (parsed && Array.isArray(parsed.zones)) return { zones: parsed.zones };
        return { zones: [] };
      }catch(_){ return { zones: [] }; }
    }
    function saveZones(obj){
      try{
        const p = zonesPath();
        ensureDir(p);
        const payload = (obj && typeof obj === 'object' && Array.isArray(obj.zones)) ? obj : { zones: [] };
        const decorated = Object.assign({ updated_at: new Date().toISOString() }, payload);
        fs.writeFileSync(p, JSON.stringify(decorated, null, 2));
        return true;
      }catch(_){ return false; }
    }

    // GET /api/zonesAdminV2?activeOnly=true|false
    app.get('/api/zonesAdminV2', (req,res)=>{
      try{
        setCorsSafe(req,res);
        if(!requireAdmin(req,res)) return;
        const data = loadZones();
        let zones = Array.isArray(data.zones) ? data.zones : [];
        const activeOnly = String(req.query.activeOnly||'false').toLowerCase()==='true';
        if(activeOnly) zones = zones.filter(z => z && z.active !== false);
        res.json({ ok:true, zones });
      }catch(e){
        res.status(500).json({ ok:false, error:String(e && e.message || e) });
      }
    });

    // POST /api/zonesAdminV2 (create/update)
    app.post('/api/zonesAdminV2', (req,res)=>{
      try{
        setCorsSafe(req,res);
        if(!requireAdmin(req,res)) return;
        const body = req.body || {};
        const name = String(body.name||'').trim();
        const price_pence = Number(body.price_pence||0);
        const active = (body.active === false) ? false : true;
        const ring = body && body.polygon && body.polygon.coordinates && body.polygon.coordinates[0];

        if(!name) return res.status(400).json({ ok:false, error:'name_required' });
        if(!Number.isFinite(price_pence) || price_pence < 0) return res.status(400).json({ ok:false, error:'price_pence_invalid' });
        if(!Array.isArray(ring) || ring.length < 3) return res.status(400).json({ ok:false, error:'polygon_invalid' });

        const data = loadZones();
        const zones = Array.isArray(data.zones) ? data.zones : [];
        let zone = null;

        if(body.id){
          const idx = zones.findIndex(z => z && z.id === body.id);
          if(idx >= 0){
            zones[idx] = Object.assign({}, zones[idx], {
              id: zones[idx].id, name, price_pence, active,
              polygon: { type:'Polygon', coordinates:[ ring ] }
            });
            zone = zones[idx];
          } else {
            zone = { id: String(body.id), name, price_pence, active, polygon:{ type:'Polygon', coordinates:[ ring ] } };
            zones.push(zone);
          }
        } else {
          const id = (global.crypto && crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
          zone = { id, name, price_pence, active, polygon:{ type:'Polygon', coordinates:[ ring ] } };
          zones.push(zone);
        }

        if(!saveZones({ zones })) return res.status(500).json({ ok:false, error:'save_failed' });
        res.json({ ok:true, zone });
      }catch(e){
        res.status(500).json({ ok:false, error:String(e && e.message || e) });
      }
    });

    // DELETE /api/zonesAdminV2?id=<id>
    app.delete('/api/zonesAdminV2', (req,res)=>{
      try{
        setCorsSafe(req,res);
        if(!requireAdmin(req,res)) return;
        const id = String(req.query.id||'').trim();
        if(!id) return res.status(400).json({ ok:false, error:'id_required' });

        const data = loadZones();
        let zones = Array.isArray(data.zones) ? data.zones : [];
        const before = zones.length;
        zones = zones.filter(z => z && z.id !== id);
        if(before === zones.length) return res.status(404).json({ ok:false, error:'not_found' });
        if(!saveZones({ zones })) return res.status(500).json({ ok:false, error:'save_failed' });
        res.json({ ok:true, removed:id });
      }catch(e){
        res.status(500).json({ ok:false, error:String(e && e.message || e) });
      }
    });
  }catch(_){}
})();
// ====== Global CORS preflight handler (appended safely) ======
app.options('*', (req, res) => {
  try {
    const origin = req.headers.origin || '*';
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    const reqHeaders = req.headers['access-control-request-headers'];
    const allowHeaders = (reqHeaders && String(reqHeaders).trim().length)
      ? String(reqHeaders)
      : 'Content-Type, Authorization, X-Admin-Token, ngrok-skip-browser-warning, x-square-signature, x-square-hmacsha256-signature';
    res.set('Access-Control-Allow-Headers', allowHeaders);
    res.set('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  } catch (_e) {
    return res.sendStatus(204);
  }
});
// ====== Health + legacy zones alias (appended safely) ======
app.get('/health', (req, res) => {
  try { if (typeof setCors === 'function') setCors(req, res); } catch(_) {}
  res.json({ ok: true, ts: new Date().toISOString(), uptime_sec: Math.floor(process.uptime()) });
});

app.get('/api/zones', (req, res) => {
  try { if (typeof setCors === 'function') setCors(req, res); } catch(_) {}
  try {
    const fs = require('fs'), path = require('path');
    const base = (process.env.DATA_DIR && String(process.env.DATA_DIR).trim())
      ? String(process.env.DATA_DIR).trim()
      : path.join(__dirname,'data');
    const p = path.join(base,'zones.json');
    let zones = [];
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const j = JSON.parse(txt);
      zones = Array.isArray(j) ? j : (Array.isArray(j.zones) ? j.zones : []);
    } catch(e) {}
    res.json({ zones, updated_at: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ ok:false, error: String((e && e.message) || e) });
  }
});
// ====== Admin Settings (GET/POST) appended safely ======
(function attachAdminSettings(){
  try{
    const fs = require('fs');
    const path = require('path');

    function setCorsSafe(req,res){ try{ if (typeof setCors === 'function') setCors(req,res); }catch(_){ } }
    function requireAdmin(req,res){
      try{
        const hdr = String(req.headers['x-admin-token']||'').trim();
        const cfg = String(process.env.ADMIN_TOKEN||'').trim();
        if(!cfg){ try{res.status(500).json({ok:false,error:'admin_token_not_configured'})}catch(_){ } return false; }
        if(hdr !== cfg){ try{res.status(401).json({ok:false,error:'unauthorized'})}catch(_){ } return false; }
        return true;
      }catch(_){
        try{ res.status(500).json({ok:false,error:'admin_check_failed'}) }catch(_){}
        return false;
      }
    }
    function settingsPath(){
      try{
        const base = (process.env.DATA_DIR && String(process.env.DATA_DIR).trim())
          ? String(process.env.DATA_DIR).trim()
          : path.join(__dirname,'data');
        return path.join(base,'settings.json');
      }catch(_){ return path.join(__dirname,'data','settings.json'); }
    }
    function ensureDir(p){ try{ fs.mkdirSync(path.dirname(p), { recursive: true }); }catch(_){ } }
    function isPlainObject(v){ return v && typeof v === 'object' && !Array.isArray(v); }
    function loadSettings(){
      try{
        const p = settingsPath();
        if (!fs.existsSync(p)) return {};
        const txt = fs.readFileSync(p, 'utf8');
        if (!txt || !txt.trim()) return {};
        const parsed = JSON.parse(txt);
        return isPlainObject(parsed) ? parsed : {};
      }catch(_){ return {}; }
    }
    function saveSettings(obj){
      try{
        const p = settingsPath();
        ensureDir(p);
        const payload = isPlainObject(obj) ? obj : {};
        const decorated = Object.assign({}, payload, { updated_at: new Date().toISOString() });
        fs.writeFileSync(p, JSON.stringify(decorated, null, 2));
        return true;
      }catch(_){ return false; }
    }

    // GET admin settings
    app.get('/api/admin/settings', (req,res)=>{
      try{
        setCorsSafe(req,res);
        if(!requireAdmin(req,res)) return;
        const settings = loadSettings();
        res.json({ ok:true, settings });
      }catch(e){
        res.status(500).json({ ok:false, error:String(e && e.message || e) });
      }
    });

    // POST admin settings (merge + save)
    app.post('/api/admin/settings', (req,res)=>{
      try{
        setCorsSafe(req,res);
        if(!requireAdmin(req,res)) return;

        const incoming = req.body;
        if(!isPlainObject(incoming)){
          return res.status(400).json({ ok:false, error:'invalid_body_expect_object' });
        }

        const current = loadSettings();
        const next = Object.assign({}, current, incoming);
        if(!saveSettings(next)) return res.status(500).json({ ok:false, error:'save_failed' });
        res.json({ ok:true, settings: next });
      }catch(e){
        res.status(500).json({ ok:false, error:String(e && e.message || e) });
      }
    });
  }catch(_){}
})();
