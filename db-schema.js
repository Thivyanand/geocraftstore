const { sql } = require('drizzle-orm');
const {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} = require('drizzle-orm/pg-core');

const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  productId: text('product_id').notNull(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull(),
  razorpayOrderId: text('razorpay_order_id').unique(),
  razorpayPaymentId: text('razorpay_payment_id').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  usernameLowerIdx: index('orders_username_lower_idx').on(sql`lower(${table.username})`),
  statusCreatedIdx: index('orders_status_created_idx').on(table.status, table.createdAt),
}));

const deliveries = pgTable('deliveries', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull().unique(),
  username: text('username').notNull(),
  rank: text('rank').notNull(),
  status: text('status').notNull().default('queued'),
  retryCount: integer('retry_count').notNull().default(0),
  lastError: text('last_error'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  queueIdx: index('deliveries_queue_idx').on(table.status, table.nextAttemptAt),
}));

const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  event: text('event').notNull(),
  details: jsonb('details').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

const products = pgTable('products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  price: integer('price').notNull(),
  duration: integer('duration'),
  active: boolean('active').notNull().default(false),
  perks: jsonb('perks').notNull(),
});

module.exports = { orders, deliveries, auditLogs, products };
