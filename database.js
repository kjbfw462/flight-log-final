// database.js (SSL設定をRender環境に最適化)
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('重大: 環境変数 DATABASE_URL が未設定です。');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // RenderのDB接続のための設定
});

// ... (initializeDB, query, getClient 関数は前回の最終版から変更ありません)
async function initializeDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // (CREATE TABLE文など...)
    await client.query(`CREATE TABLE IF NOT EXISTS pilots (...)`);
    await client.query(`CREATE TABLE IF NOT EXISTS drones (...)`);
    await client.query(`CREATE TABLE IF NOT EXISTS flight_logs (...)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ...`);
    // (開発時のテストユーザー作成ロジックなど...)
    await client.query('COMMIT');
    console.log('DB initialize: OK');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('DB initialize: FAILED', e);
    process.exit(1);
  } finally {
    client.release();
  }
}
function query(text, params) { /* ... */ }
async function getClient() { /* ... */ }
module.exports = { initializeDB, query, getClient };