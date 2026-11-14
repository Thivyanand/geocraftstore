const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Rcon } = require('rcon-client');
const catalog = require('./config/products');

const app = express();
const port = Number(process.env.PORT || 3000);
const dbPath = process.env.DATABASE_PATH || './data/geocraft.sqlite';
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY, username TEXT NOT NULL, product_id TEXT NOT NULL, amount INTEGER NOT NULL,
 currency TEXT NOT NULL, status TEXT NOT NULL, razorpay_order_id TEXT UNIQUE, razorpay_payment_id TEXT UNIQUE,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS deliveries (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), username TEXT NOT NULL, rank TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', retry_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
 delivered_at TEXT, next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, price INTEGER NOT NULL, duration INTEGER, active INTEGER NOT NULL, perks TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_username ON orders(username COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_delivery_queue ON deliveries(status,next_attempt_at);`);
let products = catalog.products.map(p => ({...p}));
const savedProducts=db.prepare('SELECT * FROM products').all();
if(savedProducts.length) products=savedProducts.map(p=>({...p,active:Boolean(p.active),perks:JSON.parse(p.perks)}));
else {const seed=db.prepare('INSERT INTO products(id,name,description,price,duration,active,perks) VALUES (?,?,?,?,?,?,?)'); for(const p of products) seed.run(p.id,p.name,p.description,p.price,p.duration,p.active?1:0,JSON.stringify(p.perks));}
const sessions = new Set();
const log = db.prepare('INSERT INTO audit_logs(event,details) VALUES (?,?)');
const audited = (event, details) => log.run(event, JSON.stringify(details));
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], scriptSrc: ["'self'", 'https://checkout.razorpay.com'], connectSrc: ["'self'", 'https://api.razorpay.com'], imgSrc: ["'self'", 'data:'] }}}));
app.use('/api/payments/webhook', express.raw({type:'application/json', limit:'64kb'}));
app.use(express.json({limit:'32kb'}));
app.use(express.static(path.join(__dirname,'public')));
app.use('/api/', rateLimit({windowMs:60_000, limit:60, standardHeaders:true, legacyHeaders:false}));
const usernameOK = u => typeof u === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(u);
const razorReady = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const safeEqual = (a,b) => { const aa=Buffer.from(String(a)), bb=Buffer.from(String(b)); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); };
function admin(req,res,next) { const token=(req.headers.cookie||'').match(/(?:^|; )gc_admin=([^;]+)/)?.[1]; if(token && sessions.has(token)){ next(); return; } res.status(401).json({error:'Administrator sign-in required'}); }
function orderForPayment(row) { return {id:row.id,username:row.username,productId:row.product_id,amount:row.amount,currency:row.currency,status:row.status,createdAt:row.created_at,razorpayOrderId:row.razorpay_order_id,razorpayPaymentId:row.razorpay_payment_id}; }
async function createRazorpayOrder(amount,receipt) {
 const auth=Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
 const resp=await fetch('https://api.razorpay.com/v1/orders',{method:'POST',headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/json'},body:JSON.stringify({amount,currency:'INR',receipt,notes:{store:'GeoCraft SMP'}})});
 const data=await resp.json(); if(!resp.ok) throw new Error(data.error?.description||'Payment provider could not create an order.'); return data;
}
const tx=(orderId,paymentId) => {
 db.exec('BEGIN IMMEDIATE');
 try {
 const order=db.prepare("SELECT * FROM orders WHERE id=?").get(orderId); if(!order) throw new Error('Order not found');
 if(order.status==='paid') { db.exec('COMMIT'); return false; }
 db.prepare("UPDATE orders SET status='paid',razorpay_payment_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(paymentId,orderId);
 db.prepare("INSERT OR IGNORE INTO deliveries(id,order_id,username,rank) VALUES (?,?,?,?)").run(crypto.randomUUID(),order.id,order.username,order.product_id);
 audited('payment_verified',{orderId,paymentId}); db.exec('COMMIT'); return true;
 } catch(e) { db.exec('ROLLBACK'); throw e; }
};
app.get('/api/health',(req,res)=>res.json({status:'ok',database:'ok',payments:razorReady()?'configured':'not_configured',delivery:process.env.RCON_HOST&&process.env.RCON_PASSWORD?'configured':'not_configured'}));
app.get('/api/products',(req,res)=>res.json({currency:catalog.currency,products:products.filter(p=>p.active)}));
app.post('/api/orders',async(req,res)=>{
 const {username,productId}=req.body||{}; if(!usernameOK(username)) return res.status(400).json({error:'Enter a valid Minecraft Java username (3–16 letters, numbers or underscores).'});
 const product=products.find(p=>p.id===productId&&p.active); if(!product) return res.status(400).json({error:'That rank is not currently available.'});
 if(!Number.isInteger(product.price)||product.price<=0) return res.status(503).json({error:'Pricing is being finalized. Please check back soon.'});
 if(!razorReady()) return res.status(503).json({error:'Checkout is not available yet. Please contact support.'});
 const id=crypto.randomUUID();
 try { const rp=await createRazorpayOrder(product.price,id.slice(0,40)); db.prepare('INSERT INTO orders(id,username,product_id,amount,currency,status,razorpay_order_id) VALUES (?,?,?,?,?,?,?)').run(id,username,product.id,product.price,'INR','created',rp.id); audited('order_created',{id,username,productId}); res.status(201).json({orderId:id,razorpayOrderId:rp.id,amount:product.price,currency:'INR',keyId:process.env.RAZORPAY_KEY_ID,product:{name:product.name,description:product.description}}); }
 catch(e){ audited('order_create_failed',{id,error:e.message}); res.status(502).json({error:'Could not start checkout. Please try again.'}); }
});
app.post('/api/payments/verify',(req,res)=>{
 const {orderId,razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};
 const row=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId); if(!row||row.razorpay_order_id!==razorpay_order_id) return res.status(400).json({error:'Payment could not be matched to this order.'});
 const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET||'').update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
 if(!razorpay_signature||!safeEqual(expected,razorpay_signature)){audited('payment_signature_invalid',{orderId});return res.status(400).json({error:'Payment verification failed. Contact support if you were charged.'});}
 try{tx(orderId,razorpay_payment_id);res.json({status:'paid',delivery:'queued'});}catch(e){res.status(400).json({error:'Payment could not be recorded.'});}
});
app.post('/api/payments/webhook',(req,res)=>{
 const secret=process.env.RAZORPAY_WEBHOOK_SECRET, sig=req.headers['x-razorpay-signature'];
 if(!secret||!sig)return res.status(401).end(); const expected=crypto.createHmac('sha256',secret).update(req.body).digest('hex'); if(!safeEqual(expected,sig)){audited('webhook_signature_invalid',{});return res.status(401).end();}
 try{const event=JSON.parse(req.body.toString());if(event.event==='payment.captured'){const p=event.payload.payment.entity, row=db.prepare('SELECT id FROM orders WHERE razorpay_order_id=?').get(p.order_id);if(row)tx(row.id,p.id);} else if(event.event==='payment.failed'){const p=event.payload.payment.entity;db.prepare("UPDATE orders SET status='failed',updated_at=CURRENT_TIMESTAMP WHERE razorpay_order_id=? AND status!='paid'").run(p.order_id);audited('payment_failed',{providerOrderId:p.order_id});} res.json({received:true});}catch(e){res.status(400).json({error:'Invalid webhook payload'});}
});
app.get('/api/orders/:id/status',(req,res)=>{const o=db.prepare('SELECT id,status FROM orders WHERE id=?').get(req.params.id);if(!o)return res.status(404).json({error:'Order not found'});const d=db.prepare('SELECT status,last_error FROM deliveries WHERE order_id=?').get(o.id);res.json({...o,delivery:d?.status||'not_started'});});
app.post('/api/admin/login',(req,res)=>{const {password}=req.body||{};if(!process.env.ADMIN_PASSWORD||!safeEqual(password||'',process.env.ADMIN_PASSWORD))return res.status(401).json({error:'Incorrect password'});const token=crypto.randomBytes(32).toString('hex');sessions.add(token);res.cookie('gc_admin',token,{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',maxAge:8*60*60*1000,path:'/'});res.json({ok:true});});
app.post('/api/admin/logout',admin,(req,res)=>{const t=req.cookies?.gc_admin||(req.headers.cookie||'').match(/(?:^|; )gc_admin=([^;]+)/)?.[1];sessions.delete(t);res.clearCookie('gc_admin',{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production'});res.json({ok:true});});
app.use((req,res,next)=>{if(req.path.startsWith('/api/admin'))return admin(req,res,next);next();});
app.get('/api/admin/summary',(req,res)=>res.json({revenue:db.prepare("SELECT COALESCE(SUM(amount),0) n FROM orders WHERE status='paid'").get().n,orders:db.prepare('SELECT COUNT(*) n FROM orders').get().n,paid:db.prepare("SELECT COUNT(*) n FROM orders WHERE status='paid'").get().n,pending:db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('created','pending')").get().n,failedDeliveries:db.prepare("SELECT COUNT(*) n FROM deliveries WHERE status='failed'").get().n}));
app.get('/api/admin/orders',(req,res)=>{const query=String(req.query.username||'').slice(0,16);const rows=query?db.prepare("SELECT o.*,d.id delivery_id,d.status delivery_status,d.retry_count,d.last_error FROM orders o LEFT JOIN deliveries d ON d.order_id=o.id WHERE o.username LIKE ? ORDER BY o.created_at DESC LIMIT 100").all(`%${query}%`):db.prepare('SELECT o.*,d.id delivery_id,d.status delivery_status,d.retry_count,d.last_error FROM orders o LEFT JOIN deliveries d ON d.order_id=o.id ORDER BY o.created_at DESC LIMIT 100').all();res.json(rows)});
app.get('/api/admin/products',(req,res)=>res.json(products));
app.put('/api/admin/products/:id',(req,res)=>{const p=products.find(x=>x.id===req.params.id);if(!p)return res.status(404).json({error:'Product not found'});const {price,description,perks,active,duration}=req.body||{};if(!Number.isInteger(price)||price<0||typeof description!=='string'||description.length>500||!Array.isArray(perks)||perks.length>30||perks.some(x=>typeof x!=='string'||x.length>200)||typeof active!=='boolean')return res.status(400).json({error:'Invalid product configuration'});Object.assign(p,{price,description,perks,active,duration:duration===null?null:Math.max(1,Math.floor(Number(duration)||1))});db.prepare('UPDATE products SET description=?,price=?,duration=?,active=?,perks=? WHERE id=?').run(p.description,p.price,p.duration,p.active?1:0,JSON.stringify(p.perks),p.id);audited('product_updated',{id:p.id});res.json(p)});
app.post('/api/admin/deliveries/:id/retry',(req,res)=>{const d=db.prepare("SELECT * FROM deliveries WHERE id=? AND status='failed'").get(req.params.id);if(!d)return res.status(404).json({error:'Failed delivery not found'});db.prepare("UPDATE deliveries SET status='queued',next_attempt_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=?").run(d.id);audited('delivery_retry_requested',{deliveryId:d.id});res.json({status:'queued'});});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

async function deliver(d){
 if(!process.env.RCON_HOST||!process.env.RCON_PASSWORD)throw new Error('Rank delivery is not configured. Contact the server administrator.');
 const rcon=await Rcon.connect({host:process.env.RCON_HOST,port:Number(process.env.RCON_PORT||25575),password:process.env.RCON_PASSWORD});
 try {
   // VIP+ supersedes VIP. Commands are sent only by this private backend worker after verified payment.
   const prior=db.prepare("SELECT 1 FROM orders o JOIN deliveries d ON d.order_id=o.id WHERE o.username=? AND o.product_id='vip_plus' AND o.status='paid' AND d.status='delivered' LIMIT 1").get(d.username);
   const commands=d.rank==='vip_plus'? (prior?['lp user '+d.username+' parent set vipplus']:['lp user '+d.username+' parent set vipplus']):['lp user '+d.username+' parent add vip'];
   for(const command of commands) await rcon.send(command);
 } finally {rcon.end();}
}
let workerRunning=false;
async function processQueue(){if(workerRunning)return;workerRunning=true;try{const batch=db.prepare("SELECT * FROM deliveries WHERE status IN ('queued','retrying') AND next_attempt_at<=CURRENT_TIMESTAMP ORDER BY next_attempt_at LIMIT 5").all();for(const d of batch){db.prepare("UPDATE deliveries SET status='processing' WHERE id=?").run(d.id);try{await deliver(d);db.prepare("UPDATE deliveries SET status='delivered',delivered_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=?").run(d.id);audited('delivery_succeeded',{deliveryId:d.id,username:d.username,rank:d.rank});}catch(e){const tries=d.retry_count+1,status=tries>=6?'failed':'retrying',delay=Math.min(3600,30*2**(tries-1));db.prepare('UPDATE deliveries SET status=?,retry_count=?,last_error=?,next_attempt_at=datetime(\'now\',?) WHERE id=?').run(status,tries,e.message,`+${delay} seconds`,d.id);audited('delivery_attempt_failed',{deliveryId:d.id,tries,error:e.message});}}}finally{workerRunning=false;}}
if(require.main===module){setInterval(processQueue,10_000).unref();app.listen(port,()=>console.log(`GeoCraft Store listening on ${port}`));}
module.exports={app,db,processQueue,tx,usernameOK};
