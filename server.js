require('dotenv').config({ path: '.env.development.local' });
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('node:crypto');
const path = require('node:path');
const { Rcon } = require('rcon-client');
const {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  lte,
  ne,
  sql,
} = require('drizzle-orm');
const catalog = require('./config/products');
const { db, pool, testSchemaReady } = require('./db');
const { auditLogs, deliveries, orders, products: productsTable } = require('./db-schema');

const app = express();
const port = Number(process.env.PORT || 3000);
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

async function initializeStore() {
  await testSchemaReady;
  if (process.env.NODE_ENV !== 'test' && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required; connect the Neon integration.');
  }
  await db.insert(productsTable).values(catalog.products).onConflictDoNothing();
}

const storeReady = initializeStore();
storeReady.catch((error) => {
  console.error('Store initialization failed:', error.message);
});

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};
const usernameOK = (username) => typeof username === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(username);
const razorReady = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const audited = (event, details) => db.insert(auditLogs).values({ event, details });

function createAdminToken() {
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  const nonce = crypto.randomBytes(18).toString('hex');
  const payload = `${expiresAt}.${nonce}`;
  const signature = crypto.createHmac('sha256', process.env.ADMIN_PASSWORD).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function isValidAdminToken(token) {
  if (!process.env.ADMIN_PASSWORD || typeof token !== 'string') return false;
  const [expiresAt, nonce, signature, ...extra] = token.split('.');
  if (extra.length || !/^\d+$/.test(expiresAt || '') || !nonce || !signature || Number(expiresAt) <= Date.now()) {
    return false;
  }
  const payload = `${expiresAt}.${nonce}`;
  const expected = crypto.createHmac('sha256', process.env.ADMIN_PASSWORD).update(payload).digest('hex');
  return safeEqual(signature, expected);
}

function admin(req, res, next) {
  const token = (req.headers.cookie || '').match(/(?:^|; )gc_admin=([^;]+)/)?.[1];
  if (isValidAdminToken(token)) return next();
  return res.status(401).json({ error: 'Administrator sign-in required' });
}

async function createRazorpayOrder(amount, receipt) {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, currency: 'INR', receipt, notes: { store: 'GeoCraft SMP' } }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.description || 'Payment provider could not create an order.');
  return data;
}

async function tx(orderId, paymentId) {
  return db.transaction(async (transaction) => {
    const [order] = await transaction.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new Error('Order not found');
    if (order.status === 'paid') return false;

    const [updatedOrder] = await transaction.update(orders)
      .set({ status: 'paid', razorpayPaymentId: paymentId, updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), ne(orders.status, 'paid')))
      .returning({ id: orders.id, username: orders.username, productId: orders.productId });
    if (!updatedOrder) return false;

    await transaction.insert(deliveries).values({
      id: crypto.randomUUID(),
      orderId: updatedOrder.id,
      username: updatedOrder.username,
      rank: updatedOrder.productId,
    }).onConflictDoNothing({ target: deliveries.orderId });
    await transaction.insert(auditLogs).values({ event: 'payment_verified', details: { orderId, paymentId } });
    return true;
  });
}

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
      connectSrc: ["'self'", 'https://api.razorpay.com'],
      imgSrc: ["'self'", 'data:'],
    },
  },
}));
app.use('/api/payments/webhook', express.raw({ type: 'application/json', limit: '64kb' }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
app.use('/api', asyncHandler(async (req, res, next) => {
  await storeReady;
  next();
}));

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  database: 'ok',
  payments: razorReady() ? 'configured' : 'not_configured',
  delivery: process.env.RCON_HOST && process.env.RCON_PASSWORD ? 'configured' : 'not_configured',
}));

app.get('/api/products', asyncHandler(async (req, res) => {
  const products = await db.select().from(productsTable)
    .where(eq(productsTable.active, true))
    .orderBy(asc(productsTable.id));
  res.json({ currency: catalog.currency, products });
}));

app.post('/api/orders', asyncHandler(async (req, res) => {
  const { username, productId } = req.body || {};
  if (!usernameOK(username)) {
    return res.status(400).json({ error: 'Enter a valid Minecraft Java username (3–16 letters, numbers or underscores).' });
  }

  const [product] = await db.select().from(productsTable).where(and(
    eq(productsTable.id, productId),
    eq(productsTable.active, true),
  )).limit(1);
  if (!product) return res.status(400).json({ error: 'That rank is not currently available.' });
  if (!Number.isInteger(product.price) || product.price <= 0) {
    return res.status(503).json({ error: 'Pricing is being finalized. Please check back soon.' });
  }
  if (!razorReady()) return res.status(503).json({ error: 'Checkout is not available yet. Please contact support.' });

  const id = crypto.randomUUID();
  try {
    const razorpayOrder = await createRazorpayOrder(product.price, id.slice(0, 40));
    await db.insert(orders).values({
      id,
      username,
      productId: product.id,
      amount: product.price,
      currency: catalog.currency,
      status: 'created',
      razorpayOrderId: razorpayOrder.id,
    });
    await audited('order_created', { id, username, productId });
    return res.status(201).json({
      orderId: id,
      razorpayOrderId: razorpayOrder.id,
      amount: product.price,
      currency: catalog.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      product: { name: product.name, description: product.description },
    });
  } catch (error) {
    await audited('order_create_failed', { id, error: error.message });
    return res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
}));

app.post('/api/payments/verify', asyncHandler(async (req, res) => {
  const { orderId, razorpay_order_id: razorpayOrderId, razorpay_payment_id: razorpayPaymentId, razorpay_signature: signature } = req.body || {};
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || order.razorpayOrderId !== razorpayOrderId) {
    return res.status(400).json({ error: 'Payment could not be matched to this order.' });
  }

  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  if (!signature || !safeEqual(expected, signature)) {
    await audited('payment_signature_invalid', { orderId });
    return res.status(400).json({ error: 'Payment verification failed. Contact support if you were charged.' });
  }

  try {
    await tx(orderId, razorpayPaymentId);
    return res.json({ status: 'paid', delivery: 'queued' });
  } catch (error) {
    return res.status(400).json({ error: 'Payment could not be recorded.' });
  }
}));

app.post('/api/payments/webhook', asyncHandler(async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];
  if (!secret || !signature) return res.status(401).end();

  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (!safeEqual(expected, signature)) {
    await audited('webhook_signature_invalid', {});
    return res.status(401).end();
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  try {
    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const [order] = await db.select({ id: orders.id }).from(orders)
        .where(eq(orders.razorpayOrderId, payment.order_id)).limit(1);
      if (order) await tx(order.id, payment.id);
    } else if (event.event === 'payment.failed') {
      const payment = event.payload.payment.entity;
      await db.update(orders)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(and(eq(orders.razorpayOrderId, payment.order_id), ne(orders.status, 'paid')));
      await audited('payment_failed', { providerOrderId: payment.order_id });
    }
    return res.json({ received: true });
  } catch (error) {
    console.error('Razorpay webhook processing failed:', error.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}));

app.get('/api/orders/:id/status', asyncHandler(async (req, res) => {
  const [order] = await db.select({ id: orders.id, status: orders.status })
    .from(orders).where(eq(orders.id, req.params.id)).limit(1);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const [delivery] = await db.select({ status: deliveries.status, lastError: deliveries.lastError })
    .from(deliveries).where(eq(deliveries.orderId, order.id)).limit(1);
  return res.json({ ...order, delivery: delivery?.status || 'not_started' });
}));

app.post('/api/admin/login', asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD || !safeEqual(password || '', process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  res.cookie('gc_admin', createAdminToken(), {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: ADMIN_SESSION_TTL_MS,
    path: '/',
  });
  return res.json({ ok: true });
}));

app.post('/api/admin/logout', admin, (req, res) => {
  res.clearCookie('gc_admin', {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
  res.json({ ok: true });
});

app.use('/api/admin', admin);

app.get('/api/admin/summary', asyncHandler(async (req, res) => {
  const [summary] = await db.select({
    revenue: sql`COALESCE(SUM(CASE WHEN ${orders.status} = 'paid' THEN ${orders.amount} ELSE 0 END), 0)`,
    orders: count(),
    paid: sql`COUNT(CASE WHEN ${orders.status} = 'paid' THEN 1 END)`,
    pending: sql`COUNT(CASE WHEN ${orders.status} IN ('created', 'pending') THEN 1 END)`,
  }).from(orders);
  const [deliverySummary] = await db.select({ failed: count() }).from(deliveries)
    .where(eq(deliveries.status, 'failed'));
  res.json({
    revenue: Number(summary.revenue),
    orders: Number(summary.orders),
    paid: Number(summary.paid),
    pending: Number(summary.pending),
    failedDeliveries: Number(deliverySummary.failed),
  });
}));

app.get('/api/admin/orders', asyncHandler(async (req, res) => {
  const username = String(req.query.username || '').slice(0, 16);
  let query = db.select({
    id: orders.id,
    username: orders.username,
    product_id: orders.productId,
    amount: orders.amount,
    status: orders.status,
    created_at: orders.createdAt,
    razorpay_order_id: orders.razorpayOrderId,
    razorpay_payment_id: orders.razorpayPaymentId,
    delivery_id: deliveries.id,
    delivery_status: deliveries.status,
    retry_count: deliveries.retryCount,
    last_error: deliveries.lastError,
  }).from(orders).leftJoin(deliveries, eq(orders.id, deliveries.orderId));
  if (username) query = query.where(ilike(orders.username, `%${username}%`));
  const rows = await query.orderBy(desc(orders.createdAt)).limit(100);
  res.json(rows);
}));

app.get('/api/admin/products', asyncHandler(async (req, res) => {
  const products = await db.select().from(productsTable).orderBy(asc(productsTable.id));
  res.json(products);
}));

app.put('/api/admin/products/:id', asyncHandler(async (req, res) => {
  const { price, description, perks, active, duration } = req.body || {};
  if (!Number.isInteger(price) || price < 0 || typeof description !== 'string' || description.length > 500
    || !Array.isArray(perks) || perks.length > 30
    || perks.some((perk) => typeof perk !== 'string' || perk.length > 200)
    || typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Invalid product configuration' });
  }

  const normalizedDuration = duration === null ? null : Math.max(1, Math.floor(Number(duration) || 1));
  const [product] = await db.update(productsTable).set({
    price,
    description,
    perks,
    active,
    duration: normalizedDuration,
  }).where(eq(productsTable.id, req.params.id)).returning();
  if (!product) return res.status(404).json({ error: 'Product not found' });
  await audited('product_updated', { id: product.id });
  res.json(product);
}));

app.post('/api/admin/deliveries/:id/retry', asyncHandler(async (req, res) => {
  const [delivery] = await db.update(deliveries).set({
    status: 'queued',
    nextAttemptAt: new Date(),
    lastError: null,
  }).where(and(eq(deliveries.id, req.params.id), eq(deliveries.status, 'failed')))
    .returning({ id: deliveries.id });
  if (!delivery) return res.status(404).json({ error: 'Failed delivery not found' });
  await audited('delivery_retry_requested', { deliveryId: delivery.id });
  res.json({ status: 'queued' });
}));

async function deliver(delivery) {
  if (!process.env.RCON_HOST || !process.env.RCON_PASSWORD) {
    throw new Error('Rank delivery is not configured. Contact the server administrator.');
  }
  const connection = await Rcon.connect({
    host: process.env.RCON_HOST,
    port: Number(process.env.RCON_PORT || 25575),
    password: process.env.RCON_PASSWORD,
  });
  try {
    const command = delivery.rank === 'vip_plus'
      ? `lp user ${delivery.username} parent set vipplus`
      : `lp user ${delivery.username} parent add vip`;
    await connection.send(command);
  } finally {
    connection.end();
  }
}

let workerRunning = false;
async function processQueue() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const batch = await db.select().from(deliveries).where(and(
      inArray(deliveries.status, ['queued', 'retrying']),
      lte(deliveries.nextAttemptAt, new Date()),
    )).orderBy(asc(deliveries.nextAttemptAt)).limit(5);

    for (const delivery of batch) {
      const [claimed] = await db.update(deliveries).set({ status: 'processing' })
        .where(and(
          eq(deliveries.id, delivery.id),
          inArray(deliveries.status, ['queued', 'retrying']),
        )).returning({ id: deliveries.id });
      if (!claimed) continue;

      try {
        await deliver(delivery);
        await db.update(deliveries).set({ status: 'delivered', deliveredAt: new Date(), lastError: null })
          .where(eq(deliveries.id, delivery.id));
        await audited('delivery_succeeded', {
          deliveryId: delivery.id,
          username: delivery.username,
          rank: delivery.rank,
        });
      } catch (error) {
        const retryCount = delivery.retryCount + 1;
        const status = retryCount >= 6 ? 'failed' : 'retrying';
        const delaySeconds = Math.min(3600, 30 * 2 ** (retryCount - 1));
        await db.update(deliveries).set({
          status,
          retryCount,
          lastError: error.message,
          nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
        }).where(eq(deliveries.id, delivery.id));
        await audited('delivery_attempt_failed', { deliveryId: delivery.id, retryCount, error: error.message });
      }
    }
  } finally {
    workerRunning = false;
  }
}

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('Request failed:', error.message);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Internal server error' });
  return next(error);
});

if (require.main === module) {
  const queueTimer = setInterval(() => {
    processQueue().catch((error) => console.error('Delivery queue failed:', error.message));
  }, 10_000);
  queueTimer.unref();
  app.listen(port, () => console.log(`GeoCraft Store listening on ${port}`));
}

module.exports = app;
module.exports.app = app;
module.exports.db = db;
module.exports.pool = pool;
module.exports.processQueue = processQueue;
module.exports.storeReady = storeReady;
module.exports.tx = tx;
module.exports.usernameOK = usernameOK;
