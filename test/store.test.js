const {test}=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
process.env.DATABASE_PATH=path.join(os.tmpdir(),`geocraft-test-${process.pid}.sqlite`);
process.env.RAZORPAY_KEY_ID='test_key';process.env.RAZORPAY_KEY_SECRET='test_secret';process.env.RAZORPAY_WEBHOOK_SECRET='hook_secret';process.env.ADMIN_PASSWORD='admin_test_password';
const {app,db,tx,usernameOK}=require('../server');
const nativeFetch=global.fetch;

test('username validation covers accepted and rejected input',()=>{
 assert.equal(usernameOK('Geo_Craft9'),true);
 for(const name of ['ab','thisusernameistoolong','name with space','hello!'])assert.equal(usernameOK(name),false,name);
});

test('order, signature verification, webhook idempotency, failure, and admin authorization',async t=>{
 const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
 t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
 const providerOrderId=`order_${crypto.randomUUID()}`;
 const realGlobalFetch=global.fetch;
 global.fetch=async(url,options)=>String(url).startsWith('https://api.razorpay.com')?new Response(JSON.stringify({id:providerOrderId}),{status:200,headers:{'Content-Type':'application/json'}}):realGlobalFetch(url,options);
 t.after(()=>{global.fetch=nativeFetch});
 let adminLogin=await realGlobalFetch(base+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'admin_test_password'})});assert.equal(adminLogin.status,200);const adminCookie=adminLogin.headers.get('set-cookie').split(';')[0];
 let productResponse=await realGlobalFetch(base+'/api/admin/products/vip',{method:'PUT',headers:{'Content-Type':'application/json',Cookie:adminCookie},body:JSON.stringify({price:12500,description:'Test VIP',perks:['Test perk'],active:true,duration:null})});assert.equal(productResponse.status,200);
 let response=await realGlobalFetch(base+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'Player_1',productId:'vip'})});
 assert.equal(response.status,201);let order=await response.json();assert.equal(order.amount,12500);assert.equal(order.keyId,'test_key');
 response=await realGlobalFetch(base+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'bad username',productId:'vip'})});assert.equal(response.status,400);
 response=await realGlobalFetch(base+'/api/payments/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:order.orderId,razorpay_order_id:providerOrderId,razorpay_payment_id:'pay_bad',razorpay_signature:'invalid'})});assert.equal(response.status,400);
 const paymentId=`pay_${crypto.randomUUID()}`,signature=crypto.createHmac('sha256','test_secret').update(`${providerOrderId}|${paymentId}`).digest('hex');
 response=await realGlobalFetch(base+'/api/payments/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:order.orderId,razorpay_order_id:providerOrderId,razorpay_payment_id:paymentId,razorpay_signature:signature})});assert.equal(response.status,200);
 response=await realGlobalFetch(base+'/api/payments/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:order.orderId,razorpay_order_id:providerOrderId,razorpay_payment_id:paymentId,razorpay_signature:signature})});assert.equal(response.status,200);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM deliveries WHERE order_id=?').get(order.orderId).n,1);
 const raw=Buffer.from(JSON.stringify({event:'payment.captured',payload:{payment:{entity:{id:paymentId,order_id:providerOrderId}}}}));const hookSig=crypto.createHmac('sha256','hook_secret').update(raw).digest('hex');
 response=await realGlobalFetch(base+'/api/payments/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-razorpay-signature':hookSig},body:raw});assert.equal(response.status,200);assert.equal(db.prepare('SELECT COUNT(*) n FROM deliveries WHERE order_id=?').get(order.orderId).n,1);
 const badRaw=Buffer.from(JSON.stringify({event:'payment.captured',payload:{payment:{entity:{id:'x',order_id:providerOrderId}}}}));response=await realGlobalFetch(base+'/api/payments/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-razorpay-signature':'bad'},body:badRaw});assert.equal(response.status,401);
 global.fetch=realGlobalFetch;
 response=await realGlobalFetch(base+'/api/admin/summary');assert.equal(response.status,401);
 response=await realGlobalFetch(base+'/api/admin/summary',{headers:{Cookie:adminCookie}});assert.equal(response.status,200);
 const failedOrderId=`failed-${crypto.randomUUID()}`,failedProviderId=`rp-${crypto.randomUUID()}`;db.prepare("INSERT INTO orders(id,username,product_id,amount,currency,status,razorpay_order_id) VALUES (?,?, 'vip',12500,'INR','created',?)").run(failedOrderId,'Player_2',failedProviderId);
 const failedPayload=Buffer.from(JSON.stringify({event:'payment.failed',payload:{payment:{entity:{order_id:failedProviderId}}}}));const failedSig=crypto.createHmac('sha256','hook_secret').update(failedPayload).digest('hex');
 response=await realGlobalFetch(base+'/api/payments/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-razorpay-signature':failedSig},body:failedPayload});assert.equal(response.status,200);assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(failedOrderId).status,'failed');
});

test('verified payment transaction is idempotent and creates one queue record',()=>{
 const id=`test-${crypto.randomUUID()}`;
 db.prepare("INSERT INTO orders(id,username,product_id,amount,currency,status,razorpay_order_id) VALUES (?,?,?,?,'INR','created',?)").run(id,'TestUser','vip_plus',12345,`rp-${id}`);
 assert.equal(tx(id,`pay-${id}`),true);assert.equal(tx(id,`pay-${id}`),false);
 assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(id).status,'paid');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM deliveries WHERE order_id=?').get(id).n,1);
});
