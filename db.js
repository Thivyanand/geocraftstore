const { attachDatabasePool } = require('@vercel/functions');
const { drizzle: neonDrizzle } = require('drizzle-orm/neon-serverless');
const { drizzle: postgresDrizzle } = require('drizzle-orm/node-postgres');
const { Pool: NeonPool } = require('@neondatabase/serverless');
const { Pool: PostgresPool } = require('pg');
const schema = require('./db-schema');

const testSchemaStatements = [
  `CREATE TABLE orders (
    id text PRIMARY KEY,
    username text NOT NULL,
    product_id text NOT NULL,
    amount integer NOT NULL,
    currency text NOT NULL,
    status text NOT NULL,
    razorpay_order_id text UNIQUE,
    razorpay_payment_id text UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE deliveries (
    id text PRIMARY KEY,
    order_id text NOT NULL UNIQUE,
    username text NOT NULL,
    rank text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    retry_count integer NOT NULL DEFAULT 0,
    last_error text,
    delivered_at timestamptz,
    next_attempt_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE audit_logs (
    id bigserial PRIMARY KEY,
    event text NOT NULL,
    details jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE products (
    id text PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL,
    price integer NOT NULL,
    duration integer,
    active boolean NOT NULL DEFAULT false,
    perks jsonb NOT NULL
  )`,
];

let pool;
let testSchemaReady = Promise.resolve();

if (process.env.NODE_ENV === 'test') {
  const { newDb } = require('pg-mem');
  const memoryDatabase = newDb();
  const { Pool } = memoryDatabase.adapters.createPg();
  pool = new Pool();
  const query = pool.query.bind(pool);
  pool.query = (statement, ...args) => {
    if (!statement || typeof statement !== 'object') return query(statement, ...args);
    const arrayMode = statement.rowMode === 'array';
    const result = query({ ...statement, types: undefined, rowMode: undefined }, ...args);
    if (!arrayMode) return result;
    return result.then((response) => ({
      ...response,
      rows: response.rows.map((row) => (Array.isArray(row) ? row : Object.values(row))),
    }));
  };
  testSchemaReady = testSchemaStatements.reduce(
    (ready, statement) => ready.then(() => pool.query(statement)),
    Promise.resolve(),
  );
} else {
  pool = new NeonPool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  attachDatabasePool(pool);
  pool.on('error', (error) => {
    console.error('Neon database pool error:', error.message);
  });
}

const db = process.env.NODE_ENV === 'test'
  ? postgresDrizzle(pool, { schema })
  : neonDrizzle(pool, { schema });

module.exports = { db, pool, schema, testSchemaReady };
