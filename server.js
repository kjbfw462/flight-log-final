// server.js (最終確定版：機体所有者チェック入り・プレースホルダ排除)
const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// 許可値リスト
const PURPOSES = new Set(['訓練', '業務', 'その他']);
const FORMS = new Set(['目視内飛行', '目視外飛行', '夜間飛行', '25kg以上の機体', '催し場所上空', '危険物輸送', '物件投下']);

// --- ユーティリティ ---
function calcMinutes(startHHMM, endHHMM) {
  if (!startHHMM || !endHHMM) return 0;
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  let s = sh * 60 + sm;
  let e = eh * 60 + em;
  let diff = e - s;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

// ログイン中ユーザーがその drone_id を所有しているかチェック
async function assertOwnsDroneOrThrow(droneId, pilotId) {
  const did = Number(droneId);
  if (!Number.isInteger(did) || did <= 0) {
    const err = new Error('機体が選択されていません。');
    err.status = 400;
    throw err;
  }
  const r = await db.query('SELECT 1 FROM drones WHERE id=$1 AND pilot_id=$2', [did, pilotId]);
  if (r.rowCount === 0) {
    const err = new Error('指定された機体を使用する権限がありません。');
    err.status = 403;
    throw err;
  }
}

(async () => {
  await db.initializeDB();

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static('public'));

  app.use(session({
    secret: process.env.SESSION_SECRET || 'please-change-this-secret-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000*60*60*24 }
  }));

  function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) return next();
    return res.status(401).json({ error: '認証が必要です。' });
  }

  // --- ページ配信 ---
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
  app.get('/menu.html', (req, res) => res.sendFile(path.join(__dirname, 'menu.html')));
  app.get('/drones.html', (req, res) => res.sendFile(path.join(__dirname, 'drones.html')));
  app.get('/drone-form.html', (req, res) => res.sendFile(path.join(__dirname, 'drone-form.html')));
  app.get('/logs.html', (req, res) => res.sendFile(path.join(__dirname, 'logs.html')));
  app.get('/form.html', (req, res) => res.sendFile(path.join(__dirname, 'form.html')));
  app.get('/pilots.html', (req, res) => res.sendFile(path.join(__dirname, 'pilots.html')));
  app.get('/pilot-form.html', (req, res) => res.sendFile(path.join(__dirname, 'pilot-form.html')));

  // --- 認証API ---
  app.post('/api/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'メールアドレスとパスワードを入力してください。' });
      const q = await db.query('SELECT id, name, password FROM pilots WHERE email=$1', [String(email).trim()]);
      if (q.rowCount === 0) return res.status(401).json({ error: 'メールアドレスまたはパスワードが正しくありません。' });
      const user = q.rows[0];
      const ok = await bcrypt.compare(password, user.password);
      if (!ok) return res.status(401).json({ error: 'メールアドレスまたはパスワードが正しくありません。' });
      req.session.userId = user.id;
      req.session.userName = user.name;
      req.session.save(() => res.json({ ok: true, user: { id: user.id, name: user.name } }));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'ログイン処理でエラーが発生しました。' });
    }
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get('/api/current-user', (req, res) => {
    if (req.session.userId) return res.json({ user: { id: req.session.userId, name: req.session.userName } });
    return res.status(401).json({ user: null });
  });

  // ===== 機体API（drones）=====
  app.get('/api/drones', isAuthenticated, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT id, manufacturer, model, type, serial_number, registration_symbol,
                valid_period_start, valid_period_end, nickname
           FROM drones
          WHERE pilot_id=$1
          ORDER BY id DESC`,
        [req.session.userId]
      );
      res.json({ data: r.rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: '機体一覧の取得に失敗しました。' });
    }
  });

  app.get('/api/drones/:id', isAuthenticated, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT id, manufacturer, model, type, serial_number, registration_symbol,
                valid_period_start, valid_period_end, nickname
           FROM drones
          WHERE id=$1 AND pilot_id=$2`,
        [req.params.id, req.session.userId]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: '機体が見つからないか、権限がありません。' });
      res.json({ data: r.rows[0] });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: '機体の取得に失敗しました。' });
    }
  });

  app.post('/api/drones', isAuthenticated, async (req, res) => {
    try {
      const b = req.body || {};
      // 軽いユニークチェック（同一シリアル/登録記号）
      if (b.serial_number || b.registration_symbol) {
        const dup = await db.query(
          `SELECT 1 FROM drones
            WHERE pilot_id=$1 AND (serial_number=$2 OR registration_symbol=$3) LIMIT 1`,
          [req.session.userId, b.serial_number || null, b.registration_symbol || null]
        );
        if (dup.rowCount > 0) return res.status(409).json({ error: '同一の製造番号または登録記号が既に登録されています。' });
      }
      const r = await db.query(
        `INSERT INTO drones (manufacturer, model, type, serial_number, registration_symbol,
                             valid_period_start, valid_period_end, nickname, pilot_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [b.manufacturer||null, b.model, b.type||null, b.serial_number||null, b.registration_symbol||null,
         b.valid_period_start||null, b.valid_period_end||null, b.nickname||null, req.session.userId]
      );
      res.status(201).json({ data: { id: r.rows[0].id } });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: '機体の作成に失敗しました。' });
    }
  });

  app.put('/api/drones/:id', isAuthenticated, async (req, res) => {
    try {
      const b = req.body || {};
      // 自分以外との重複を軽チェック
      if (b.serial_number || b.registration_symbol) {
        const dup = await db.query(
          `SELECT 1 FROM drones
            WHERE pilot_id=$1 AND id<>$2 AND (serial_number=$3 OR registration_symbol=$4) LIMIT 1`,
          [req.session.userId, req.params.id, b.serial_number||null, b.registration_symbol||null]
        );
        if (dup.rowCount > 0) return res.status(409).json({ error: '同一の製造番号または登録記号が既に登録されています。' });
      }
      const r = await db.query(
        `UPDATE drones
            SET manufacturer=$1, model=$2, type=$3, serial_number=$4, registration_symbol=$5,
                valid_period_start=$6, valid_period_end=$7, nickname=$8
          WHERE id=$9 AND pilot_id=$10
          RETURNING id`,
        [b.manufacturer||null, b.model, b.type||null, b.serial_number||null, b.registration_symbol||null,
         b.valid_period_start||null, b.valid_period_end||null, b.nickname||null, req.params.id, req.session.userId]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: '機体が見つからないか、権限がありません。' });
      res.json({ data: { id: r.rows[0].id } });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: '機体の更新に失敗しました。' });
    }
  });

  app.delete('/api/drones/:id', isAuthenticated, async (req, res) => {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const used = await client.query(`SELECT 1 FROM flight_logs WHERE drone_id=$1 LIMIT 1`, [req.params.id]);
      if (used.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'この機体は飛行日誌で使用されているため削除できません。' });
      }
      const r = await client.query(`DELETE FROM drones WHERE id=$1 AND pilot_id=$2`, [req.params.id, req.session.userId]);
      await client.query('COMMIT');
      if (r.rowCount === 0) return res.status(404).json({ error: '機体が見つからないか、権限がありません。' });
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      res.status(500).json({ error: '機体の削除に失敗しました。' });
    } finally {
      client.release();
    }
  });

  // ===== 飛行日誌API（flight_logs）=====
  app.get('/api/flight_logs/:id', isAuthenticated, async (req, res) => {
    try {
      const r = await db.query(`SELECT * FROM flight_logs WHERE id=$1 AND pilot_id=$2`, [req.params.id, req.session.userId]);
      if (r.rowCount === 0) return res.status(404).json({ error: '対象の日誌が見つからないか、権限がありません。' });
      res.json({ data: r.rows[0] });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: '日誌の取得に失敗しました。' });
    }
  });

  app.post('/api/flight_logs', isAuthenticated, async (req, res) => {
    const b = req.body || {};
    try {
      await assertOwnsDroneOrThrow(b.drone_id, req.session.userId);

      const minutes = calcMinutes(b.start_time, b.end_time);
      if (minutes <= 0 || minutes > 720) return res.status(422).json({ error: '飛行時間が不正です。0分を超え12時間以内で設定してください。' });
      if (b.purpose && !PURPOSES.has(b.purpose)) return res.status(422).json({ error: '指定された飛行目的は許可されていません。' });
      if (b.flight_form && !FORMS.has(b.flight_form)) return res.status(422).json({ error: '指定された飛行形態は許可されていません。' });

      const fields = [
        'precheck_date','inspector','place','body','propeller','frame','comm',
        'engine','power','autocontrol','controller','battery','fly_date','drone_id',
        'start_location','end_location','start_time','end_time','flight_abnormal',
        'aftercheck','purpose','flight_form'
      ];
      const values = fields.map(f => (b[f] ?? null));
      const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');

      const r = await db.query(
        `INSERT INTO flight_logs (${fields.join(',')}, actual_time_minutes, pilot_id)
         VALUES (${placeholders}, $${fields.length + 1}, $${fields.length + 2})
         RETURNING *`,
        [...values, minutes, req.session.userId]
      );
      res.status(201).json({ data: r.rows[0] });
    } catch (e) {
      console.error(e);
      const code = e.status || 500;
      res.status(code).json({ error: e.message || '日誌の作成に失敗しました。' });
    }
  });

  app.put('/api/flight_logs/:id', isAuthenticated, async (req, res) => {
    const b = req.body || {};
    try {
      await assertOwnsDroneOrThrow(b.drone_id, req.session.userId);

      const minutes = calcMinutes(b.start_time, b.end_time);
      if (minutes <= 0 || minutes > 720) return res.status(422).json({ error: '飛行時間が不正です。0分を超え12時間以内で設定してください。' });
      if (b.purpose && !PURPOSES.has(b.purpose)) return res.status(422).json({ error: '指定された飛行目的は許可されていません。' });
      if (b.flight_form && !FORMS.has(b.flight_form)) return res.status(422).json({ error: '指定された飛行形態は許可されていません。' });

      const fields = [
        'precheck_date','inspector','place','body','propeller','frame','comm',
        'engine','power','autocontrol','controller','battery','fly_date','drone_id',
        'start_location','end_location','start_time','end_time','flight_abnormal',
        'aftercheck','purpose','flight_form'
      ];
      const set = fields.map((f, i) => `${f}=$${i + 1}`).join(', ');
      const params = fields.map(f => (b[f] ?? null));

      const r = await db.query(
        `UPDATE flight_logs
           SET ${set}, actual_time_minutes=$${fields.length + 1}
         WHERE id=$${fields.length + 2} AND pilot_id=$${fields.length + 3}
         RETURNING *`,
        [...params, minutes, req.params.id, req.session.userId]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: '対象の日誌が見つからないか、権限がありません。' });
      res.json({ data: r.rows[0] });
    } catch (e) {
      console.error(e);
      const code = e.status || 500;
      res.status(code).json({ error: e.message || '日誌の更新に失敗しました。' });
    }
  });

  app.delete('/api/flight_logs/:id', isAuthenticated, async (req, res) => {
    try {
      const r = await db.query(`DELETE FROM flight_logs WHERE id=$1 AND pilot_id=$2`, [req.params.id, req.session.userId]);
      if (r.rowCount === 0) return res.status(404).json({ error: '対象の日誌が見つからないか、権限がありません。' });
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: '日誌の削除に失敗しました。' });
    }
  });

  // ===== 操縦者削除API =====
  app.delete('/api/pilots/:id', isAuthenticated, async (req, res) => {
    const targetId = Number(req.params.id);
    const currentId = req.session.userId;
    if (targetId === currentId) return res.status(400).json({ error: '自分自身のアカウントは削除できません。' });

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const used = await client.query(`
        SELECT 1
          FROM flight_logs fl
          JOIN drones d ON d.id = fl.drone_id
         WHERE d.pilot_id = $1
         LIMIT 1
      `, [targetId]);

      if (used.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'この操縦者は、飛行日誌で使用されている機体を所有しているため削除できません。' });
      }

      await client.query('DELETE FROM pilots WHERE id=$1', [targetId]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      res.status(500).json({ error: '削除処理中にエラーが発生しました。' });
    } finally {
      client.release();
    }
  });

  app.listen(PORT, () => console.log(`サーバーがポート ${PORT} で起動しました。`));
})();
