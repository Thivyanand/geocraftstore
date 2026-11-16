const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { count, eq } = require('drizzle-orm');

process.env.NODE_ENV = 'test';
process.env.RAZORPAY_KEY_ID = 'test_key';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'hook_secret';
process.env.ADMIN_PASSWORD = 'admin_test_password';

const appModule = require('../server');
const { app, db, pool, storeReady, tx, usernameOK } = appModule;
const { deliveries, orders } = require('../db-schema');
const nativeFetch = global.fetch;

after(async () => {
  await pool.end();
});

test('username validation covers accepted and rejected input', () => {
  assert.equal(usernameOK('Geo_Craft9'), true);
  for (const name of ['ab', 'thisusernameistoolong', 'name with space', 'hello!']) {
    assert.equal(usernameOK(name), false, name);
  }
});

test('checkout, payment verification, webhook idempotency, and admin authorization', async (t) => {
  await storeReady;
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));

  const base = `http://127.0.0.1:${server.address().port}`;
  const providerOrderId = `order_${crypto.randomUUID()}`;
  const realGlobalFetch = global.fetch;
  global.fetch = async (url, options) => String(url).startsWith('https://api.razorpay.com')
    ? new Response(JSON.stringify({ id: providerOrderId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    : realGlobalFetch(url, options);
  t.after(() => {
    global.fetch = nativeFetch;
  });

  let response = await realGlobalFetch(`${base}/api/health`, {
    headers: { 'X-Forwarded-For': '203.0.113.17' },
  });
  assert.equal(response.status, 200);

  response = await realGlobalFetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin_test_password' }),
  });
  assert.equal(response.status, 200);
  const adminCookie = response.headers.get('set-cookie').split(';')[0];

  response = await realGlobalFetch(`${base}/api/admin/products/vip`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ price: 12500, description: 'Test VIP', perks: ['Test perk'], active: true, duration: null }),
  });
  assert.equal(response.status, 200);

  response = await realGlobalFetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Player_1', productId: 'vip' }),
  });
  assert.equal(response.status, 201);
  const order = await response.json();
  assert.equal(order.amount, 12500);
  assert.equal(order.keyId, 'test_key');

  response = await realGlobalFetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'bad username', productId: 'vip' }),
  });
  assert.equal(response.status, 400);

  response = await realGlobalFetch(`${base}/api/payments/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: order.orderId, razorpay_order_id: providerOrderId, razorpay_payment_id: 'pay_bad', razorpay_signature: 'invalid' }),
  });
  assert.equal(response.status, 400);

  const paymentId = `pay_${crypto.randomUUID()}`;
  const signature = crypto.createHmac('sha256', 'test_secret')
    .update(`${providerOrderId}|${paymentId}`)
    .digest('hex');
  response = await realGlobalFetch(`${base}/api/payments/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: order.orderId, razorpay_order_id: providerOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature }),
  });
  assert.equal(response.status, 200);

  response = await realGlobalFetch(`${base}/api/payments/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: order.orderId, razorpay_order_id: providerOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature }),
  });
  assert.equal(response.status, 200);
  const [deliveryCount] = await db.select({ total: count() }).from(deliveries)
    .where(eq(deliveries.orderId, order.orderId));
  assert.equal(deliveryCount.total, 1);

  const raw = Buffer.from(JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: providerOrderId } } },
  }));
  const webhookSignature = crypto.createHmac('sha256', 'hook_secret').update(raw).digest('hex');
  response = await realGlobalFetch(`${base}/api/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': webhookSignature },
    body: raw,
  });
  assert.equal(response.status, 200);

  const badRaw = Buffer.from(JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'x', order_id: providerOrderId } } },
  }));
  response = await realGlobalFetch(`${base}/api/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'bad' },
    body: badRaw,
  });
  assert.equal(response.status, 401);

  response = await realGlobalFetch(`${base}/api/admin/summary`);
  assert.equal(response.status, 401);
  response = await realGlobalFetch(`${base}/api/admin/summary`, { headers: { Cookie: adminCookie } });
  assert.equal(response.status, 200);

  const failedOrderId = `failed-${crypto.randomUUID()}`;
  const failedProviderId = `rp-${crypto.randomUUID()}`;
  await db.insert(orders).values({
    id: failedOrderId,
    username: 'Player_2',
    productId: 'vip',
    amount: 12500,
    currency: 'INR',
    status: 'created',
    razorpayOrderId: failedProviderId,
  });
  const failedPayload = Buffer.from(JSON.stringify({
    event: 'payment.failed',
    payload: { payment: { entity: { order_id: failedProviderId } } },
  }));
  const failedSignature = crypto.createHmac('sha256', 'hook_secret').update(failedPayload).digest('hex');
  response = await realGlobalFetch(`${base}/api/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': failedSignature },
    body: failedPayload,
  });
  assert.equal(response.status, 200);
  const [failedOrder] = await db.select({ status: orders.status }).from(orders)
    .where(eq(orders.id, failedOrderId));
  assert.equal(failedOrder.status, 'failed');
});

test('verified payment transition is idempotent and creates one delivery row', async () => {
  await storeReady;
  const id = `test-${crypto.randomUUID()}`;
  await db.insert(orders).values({
    id,
    username: 'TestUser',
    productId: 'vip_plus',
    amount: 12345,
    currency: 'INR',
    status: 'created',
    razorpayOrderId: `rp-${id}`,
  });

  assert.equal(await tx(id, `pay-${id}`), true);
  assert.equal(await tx(id, `pay-${id}`), false);
  const [order] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, id));
  const [deliveryCount] = await db.select({ total: count() }).from(deliveries)
    .where(eq(deliveries.orderId, id));
  assert.equal(order.status, 'paid');
  assert.equal(deliveryCount.total, 1);
});
