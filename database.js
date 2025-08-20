// database.js (最終・完全版：一切の省略なし)
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('重大: 環境変数 DATABASE_URL が未設定です。');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // RenderのDB接続のための設定
});

async function initializeDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS pilots (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        name_kana VARCHAR(100),
        postal_code VARCHAR(20),
        prefecture VARCHAR(50),
        address1 VARCHAR(255),
        address2 VARCHAR(255),
        email VARCHAR(100) UNIQUE NOT NULL,
        phone VARCHAR(30),
        has_license BOOLEAN DEFAULT false,
        initial_flight_minutes INTEGER DEFAULT 0,
        password TEXT NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS drones (
        id SERIAL PRIMARY KEY,
        manufacturer TEXT,
        model TEXT NOT NULL,
        type TEXT,
        serial_number TEXT,
        registration_symbol TEXT,
        valid_period_start DATE,
        valid_period_end DATE,
        nickname TEXT,
        pilot_id INTEGER NOT NULL REFERENCES pilots(id) ON DELETE CASCADE
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS flight_logs (
        id SERIAL PRIMARY KEY,
        precheck_date DATE,
        inspector TEXT,
        place TEXT,
        body TEXT,
        propeller TEXT,
        frame TEXT,
        comm TEXT,
        engine TEXT,
        power TEXT,
        autocontrol TEXT,
        controller TEXT,
        battery TEXT,
        fly_date DATE,
        start_location TEXT,
        end_location TEXT,
        start_time TIME,
        end_time TIME,
        actual_time_minutes INTEGER,
        flight_abnormal TEXT,
        aftercheck TEXT,
        copilot_name TEXT,
        drone_id INTEGER NOT NULL REFERENCES drones(id) ON DELETE RESTRICT,
        pilot_id INTEGER NOT NULL REFERENCES pilots(id) ON DELETE CASCADE,
        purpose TEXT,
        flight_form TEXT
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_logs_pilot_date ON flight_logs(pilot_id, fly_date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_logs_drone_date ON flight_logs(drone_id, fly_date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_drones_pilot ON drones(pilot_id)`);

    if (process.env.NODE_ENV !== 'production') {
      const hash = await bcrypt.hash('password123', 10);
      const insertQuery = `
        INSERT INTO pilots (name, email, password, initial_flight_minutes)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (email) DO NOTHING;
      `;
      await client.query(insertQuery, ['テスト操縦士', 'test@example.com', hash, 480]);
    }

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

function query(text, params) {
  return pool.query(text, params);
}

async function getClient() {
  return pool.connect();
}

module.exports = { initializeDB, query, getClient };