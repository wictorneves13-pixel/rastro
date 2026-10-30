// Acesso ao Postgres. Usa o driver HTTP da Neon (ideal para funções serverless)
// e cai para o driver "pg" quando a URL não é da Neon (Supabase, Postgres local etc.).
const SCHEMA = require('./schema');

let driver; // { query(text, params) => rows }

function getDriver() {
  if (driver) return driver;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL não configurada');
  const useNeon = /neon\.tech|neon\.build/.test(url) && process.env.DB_DRIVER !== 'pg';
  if (useNeon) {
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(url);
    driver = { query: (text, params) => sql.query(text, params) };
  } else {
    const { Pool } = require('pg');
    const ssl = /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    const pool = new Pool({ connectionString: url, max: 1, ssl });
    driver = { query: async (text, params) => (await pool.query(text, params)).rows };
  }
  return driver;
}

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  const d = getDriver();
  for (const stmt of SCHEMA) await d.query(stmt, []);
  schemaReady = true;
}

// Executa uma query. Se as tabelas ainda não existem, cria e tenta de novo.
async function q(text, params = []) {
  try {
    return await getDriver().query(text, params);
  } catch (e) {
    if (e && (e.code === '42P01' || /relation ".*" does not exist/.test(String(e.message)))) {
      await ensureSchema();
      return getDriver().query(text, params);
    }
    throw e;
  }
}

module.exports = { q, ensureSchema };
