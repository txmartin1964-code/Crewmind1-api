/**
 * db/index.js
 * Owns: Single Pool constructor — all db modules import from here.
 * Does NOT own: query logic (that lives in db/<entity>.js files).
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

module.exports = pool;
