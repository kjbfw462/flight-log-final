const { Client } = require('pg');
const bcrypt = require('bcrypt');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('重大なエラー: 環境変数 DATABASE_URL が設定されていません。');
  process.exit(1);
}

let dbClient;

const initializeDB = async () => {
  if (dbClient) return;
  const client = new Client({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
  });
  try {
    await client.connect();
    console.log('データベースに正常に接続しました。');
    await client.query(`CREATE TABLE IF NOT EXISTS pilots (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, name_kana VARCHAR(100), postal_code VARCHAR(20), prefecture VARCHAR(50), address1 VARCHAR(255), address2 VARCHAR(255), email VARCHAR(100) UNIQUE NOT NULL, phone VARCHAR(30), has_license BOOLEAN DEFAULT false, initial_flight_minutes INTEGER DEFAULT 0, password TEXT NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS drones (id SERIAL PRIMARY KEY, manufacturer TEXT, model TEXT NOT NULL, type TEXT, serial_number TEXT, registration_symbol TEXT, valid_period_start DATE, valid_period_end DATE, nickname TEXT, pilot_id INTEGER NOT NULL REFERENCES pilots(id) ON DELETE CASCADE)`);
    await client.query(`CREATE TABLE IF NOT EXISTS flight_logs (id SERIAL PRIMARY KEY, precheck_date DATE, inspector TEXT, place TEXT, body TEXT, propeller TEXT, frame TEXT, comm TEXT, engine TEXT, power TEXT, autocontrol TEXT, controller TEXT, battery TEXT, fly_date DATE, goal TEXT, form TEXT, start_location TEXT, end_location TEXT, start_time TIME, end_time TIME, actual_time_minutes INTEGER, flight_abnormal TEXT, aftercheck TEXT, copilot_name TEXT, drone_id INTEGER NOT NULL REFERENCES drones(id) ON DELETE RESTRICT, pilot_id INTEGER NOT NULL REFERENCES pilots(id) ON DELETE CASCADE)`);
    
    const res = await client.query("SELECT 1 FROM pilots WHERE email = $1", ['test@example.com']);
    if (res.rowCount === 0) {
      const hash = await bcrypt.hash('password123', 10);
      await client.query(`INSERT INTO pilots (name, email, password, initial_flight_minutes) VALUES ($1, $2, $3, $4)`, ['テスト操縦士', 'test@example.com', hash, 480]);
    }
    dbClient = client;
    console.log('データベースの初期化が完了しました。');
  } catch (err) {
    console.error('データベースの初期化中に致命的なエラーが発生しました:', err);
    process.exit(1);
  }
};

module.exports = {
  initializeDB,
  query: (text, params) => {
    if (!dbClient) {
      console.error('データベースが初期化されていません。');
      throw new Error('Database client is not available.');
    }
    return dbClient.query(text, params);
  },
};