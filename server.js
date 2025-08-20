// server.js (最終・完全版：セッション統一、フォントキャッシュ、PDF改善を反映)
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./database');
const { PDFDocument } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const app = express();
const PORT = process.env.PORT || 3000;

// --- 定数・キャッシュ ---
const PURPOSES = new Set(['訓練', '業務', 'その他']);
const FORMS = new Set(['目視内飛行', '目視外飛行', '夜間飛行', '25kg以上の機体', '催し場所上空', '危険物輸送', '物件投下']);

const FONT_PATH = path.join(__dirname, 'public', 'fonts', 'NotoSansJP-Regular.ttf');
let fontBytesCache = null;
function getFontBytes() {
  if (!fontBytesCache) fontBytesCache = fs.readFileSync(FONT_PATH);
  return fontBytesCache;
}

// --- ユーティリティ ---
function calcMinutes(startHHMM, endHHMM) {
  if (!startHHMM || !endHHMM) return 0;
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  let s = sh * 60 + sm, e = eh * 60 + em, diff = e - s;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

async function checkDroneOwnership(pilotId, droneId) {
    if (!droneId) throw new Error('機体が選択されていません。');
    const r = await db.query('SELECT 1 FROM drones WHERE id=$1 AND pilot_id=$2', [droneId, pilotId]);
    if (r.rowCount === 0) throw new Error('指定された機体を使用する権限がありません。');
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

  // --- 認証ミドルウェア（セッション参照を統一） ---
  const getUserId = (req) => req.session?.userId ?? req.session?.user?.id ?? null;
  const isAuthenticated = (req, res, next) => {
    const uid = getUserId(req);
    if (!uid) return res.status(401).json({ error: '認証が必要です。' });
    req.userId = uid; // 以降のAPIは req.userId を使う
    next();
  };

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
      
      // セッションに両方の形式で保存
      req.session.userId = user.id;
      req.session.userName = user.name;
      req.session.user = { id: user.id, name: user.name };

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
    const userId = getUserId(req);
    if (userId) return res.json({ user: { id: userId, name: req.session.userName } });
    return res.status(401).json({ user: null });
  });

  // --- 機体API ---
  app.get('/api/drones', isAuthenticated, async (req, res) => {
    try {
      const r = await db.query(`SELECT * FROM drones WHERE pilot_id=$1 ORDER BY id DESC`, [req.userId]);
      res.json({ data: r.rows });
    } catch (e) { console.error(e); res.status(500).json({ error: '機体一覧の取得に失敗しました。' }); }
  });

  app.get('/api/drones/:id', isAuthenticated, async (req, res) => {
    try {
      const r = await db.query(`SELECT * FROM drones WHERE id=$1 AND pilot_id=$2`, [req.params.id, req.userId]);
      if (r.rowCount === 0) return res.status(404).json({ error: '機体が見つからないか、権限がありません。' });
      res.json({ data: r.rows[0] });
    } catch (e) { console.error(e); res.status(500).json({ error: '機体の取得に失敗しました。' }); }
  });

  app.post('/api/drones', isAuthenticated, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await db.query(
        `INSERT INTO drones (manufacturer, model, type, serial_number, registration_symbol, valid_period_start, valid_period_end, nickname, pilot_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [b.manufacturer||null, b.model, b.type||null, b.serial_number||null, b.registration_symbol||null, b.valid_period_start||null, b.valid_period_end||null, b.nickname||null, req.userId]
      );
      res.status(201).json({ data: { id: r.rows[0].id } });
    } catch (e) { console.error(e); res.status(500).json({ error: '機体の作成に失敗しました。' }); }
  });

  app.put('/api/drones/:id', isAuthenticated, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await db.query(
        `UPDATE drones SET manufacturer=$1, model=$2, type=$3, serial_number=$4, registration_symbol=$5,
         valid_period_start=$6, valid_period_end=$7, nickname=$8 WHERE id=$9 AND pilot_id=$10 RETURNING id`,
        [b.manufacturer||null, b.model, b.type||null, b.serial_number||null, b.registration_symbol||null, b.valid_period_start||null, b.valid_period_end||null, b.nickname||null, req.params.id, req.userId]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: '機体が見つからないか、権限がありません。' });
      res.json({ data: { id: r.rows[0].id } });
    } catch (e) { console.error(e); res.status(500).json({ error: '機体の更新に失敗しました。' }); }
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
      const r = await client.query(`DELETE FROM drones WHERE id=$1 AND pilot_id=$2`, [req.params.id, req.userId]);
      await client.query('COMMIT');
      if (r.rowCount === 0) return res.status(404).json({ error: '機体が見つからないか、権限がありません。' });
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e); res.status(500).json({ error: '機体の削除に失敗しました。' });
    } finally { client.release(); }
  });
  
  // --- 飛行日誌API ---
  app.get('/api/flight_logs/pdf', isAuthenticated, async (req, res) => {
    try {
      const { start, end } = req.query;
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      if (!DATE_RE.test(start || '') || !DATE_RE.test(end || '')) {
        return res.status(400).json({ error: '開始日と終了日は YYYY-MM-DD 形式で指定してください。' });
      }
      if (start > end) return res.status(400).json({ error: '開始日は終了日以前である必要があります。' });

      const sql = `
        SELECT TO_CHAR(l.fly_date, 'YYYY-MM-DD') AS fly_date_s, l.start_time, l.end_time, l.actual_time_minutes,
        l.start_location, l.end_location, l.purpose, l.flight_form, d.model, d.nickname
        FROM flight_logs l JOIN drones d ON l.drone_id = d.id
        WHERE l.pilot_id = $1 AND l.fly_date BETWEEN $2 AND $3
        ORDER BY l.fly_date, l.start_time NULLS LAST, l.id
      `;
      const { rows } = await db.query(sql, [req.userId, start, end]);

      const pdfDoc = await PDFDocument.create();
      pdfDoc.registerFontkit(fontkit);
      const fontBytes = getFontBytes();
      const jpFont = await pdfDoc.embedFont(fontBytes);

      const margin = 50, lineH = 18;
      let page = pdfDoc.addPage();
      let { width, height } = page.getSize();
      let y = height - margin;

      page.drawText('飛行日誌', { x: margin, y, font: jpFont, size: 22 });
      y -= 32;
      page.drawText(`対象期間: ${start} 〜 ${end}（${rows.length}件）`, { x: margin, y, font: jpFont, size: 12 });
      y -= 24;

      const drawLine = (txt) => {
        if (y < margin + 40) {
          page = pdfDoc.addPage();
          ({ width, height } = page.getSize());
          y = height - margin;
        }
        page.drawText(txt, { x: margin, y, font: jpFont, size: 11 });
        y -= lineH;
      };

      for (const r of rows) {
        const droneName = r.nickname || r.model || '';
        const time = (r.start_time && r.end_time) ? `${r.start_time}〜${r.end_time}` : '';
        const mins = (r.actual_time_minutes != null) ? `${r.actual_time_minutes}分` : '';
        drawLine(`${r.fly_date_s}  ${droneName}  ${time}  ${mins}`);
        if (r.start_location || r.end_location) drawLine(`  ${r.start_location || ''} → ${r.end_location || ''}`);
        if (r.purpose || r.flight_form) drawLine(`  目的: ${r.purpose || '-'}／形態: ${r.flight_form || '-'}`);
      }

      const pdfBytes = await pdfDoc.save();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="flight-log-${start}_to_${end}.pdf"`);
      res.send(Buffer.from(pdfBytes));
    } catch (e) {
      console.error('PDF生成エラー:', e);
      res.status(500).json({ error: 'PDFの生成に失敗しました。' });
    }
  });

  app.get('/api/flight_logs/:id', isAuthenticated, async (req, res) => {
    try {
      const r = await db.query(`SELECT * FROM flight_logs WHERE id=$1 AND pilot_id=$2`, [req.params.id, req.userId]);
      if (r.rowCount === 0) return res.status(404).json({ error: '対象の日誌が見つからないか、権限がありません。' });
      res.json({ data: r.rows[0] });
    } catch (e) { console.error(e); res.status(500).json({ error: '日誌の取得に失敗しました。' }); }
  });

  app.post('/api/flight_logs', isAuthenticated, async (req, res) => {
    try {
      const b = req.body || {};
      await checkDroneOwnership(req.userId, b.drone_id);
      const minutes = calcMinutes(b.start_time, b.end_time);
      if (minutes <= 0 || minutes > 720) return res.status(422).json({ error: '飛行時間が不正です。0分を超え12時間以内で設定してください。' });
      if (b.purpose && !PURPOSES.has(b.purpose)) return res.status(422).json({ error: '指定された飛行目的は許可されていません。' });
      if (b.flight_form && !FORMS.has(b.flight_form)) return res.status(422).json({ error: '指定された飛行形態は許可されていません。' });
      const fields = ['precheck_date','inspector','place','body','propeller','frame','comm','engine','power','autocontrol','controller','battery','fly_date','drone_id','start_location','end_location','start_time','end_time','flight_abnormal','aftercheck','purpose','flight_form'];
      const values = fields.map(f => (b[f] ?? null));
      const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
      const r = await db.query(
        `INSERT INTO flight_logs (${fields.join(',')}, actual_time_minutes, pilot_id) VALUES (${placeholders}, $${fields.length + 1}, $${fields.length + 2}) RETURNING *`,
        [...values, minutes, req.userId]
      );
      res.status(201).json({ data: r.rows[0] });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message || '日誌の作成に失敗しました。' }); }
  });

  app.put('/api/flight_logs/:id', isAuthenticated, async (req, res) => {
    try {
      const b = req.body || {};
      await checkDroneOwnership(req.userId, b.drone_id);
      const minutes = calcMinutes(b.start_time, b.end_time);
      if (minutes <= 0 || minutes > 720) return res.status(422).json({ error: '飛行時間が不正です。0分を超え12時間以内で設定してください。' });
      if (b.purpose && !PURPOSES.has(b.purpose)) return res.status(422).json({ error: '指定された飛行目的は許可されていません。' });
      if (b.flight_form && !FORMS.has(b.flight_form)) return res.status(422).json({ error: '指定された飛行形態は許可されていません。' });
      const fields = ['precheck_date','inspector','place','body','propeller','frame','comm','engine','power','autocontrol','controller','battery','fly_date','drone_id','start_location','end_location','start_time','end_time','flight_abnormal','aftercheck','purpose','flight_form'];
      const set = fields.map((f, i) => `${f}=$${i + 1}`).join(', ');
      const params = fields.map(f => (b[f] ?? null));
      const r = await db.query(
        `UPDATE flight_logs SET ${set}, actual_time_minutes=$${fields.length + 1} WHERE id=$${fields.length + 2} AND pilot_id=$${fields.length + 3} RETURNING *`,
        [...params, minutes, req.params.id, req.userId]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: '対象の日誌が見つからないか、権限がありません。' });
      res.json({ data: r.rows[0] });
    } catch (e) { console.error(e); res.status(400).json({ error: e.message || '日誌の更新に失敗しました。' }); }
  });
  
  app.delete('/api/flight_logs/:id', isAuthenticated, async (req, res) => {
    try {
      const r = await db.query(`DELETE FROM flight_logs WHERE id=$1 AND pilot_id=$2`, [req.params.id, req.userId]);
      if (r.rowCount === 0) return res.status(404).json({ error: '対象の日誌が見つからないか、権限がありません。' });
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: '日誌の削除に失敗しました。' }); }
  });

  // --- 操縦者削除API ---
  app.delete('/api/pilots/:id', isAuthenticated, async (req, res) => {
    const targetId = Number(req.params.id);
    if (targetId === req.userId) return res.status(400).json({ error: '自分自身のアカウントは削除できません。' });
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const used = await client.query(`SELECT 1 FROM flight_logs fl JOIN drones d ON d.id = fl.drone_id WHERE d.pilot_id = $1 LIMIT 1`, [targetId]);
      if (used.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'この操縦者は、飛行日誌で使用されている機体を所有しているため削除できません。' });
      }
      await client.query('DELETE FROM pilots WHERE id=$1', [targetId]);
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e); res.status(500).json({ error: '削除処理中にエラーが発生しました。' });
    } finally { client.release(); }
  });
  
  // --- ダッシュボードAPI ---
  app.get('/api/dashboard-stats', isAuthenticated, async (req, res) => {
    try {
        const pilotId = req.userId;
        const totalLogsQuery = db.query('SELECT COUNT(*) FROM flight_logs WHERE pilot_id = $1', [pilotId]);
        const monthlyLogsQuery = db.query("SELECT COUNT(*) FROM flight_logs WHERE pilot_id = $1 AND fly_date >= date_trunc('month', CURRENT_DATE)", [pilotId]);
        const totalMinutesQuery = db.query('SELECT SUM(actual_time_minutes) FROM flight_logs WHERE pilot_id = $1', [pilotId]);
        const flightAreasQuery = db.query('SELECT COUNT(DISTINCT start_location) FROM flight_logs WHERE pilot_id = $1', [pilotId]);

        const [totalLogs, monthlyLogs, totalMinutes, flightAreas] = await Promise.all([totalLogsQuery, monthlyLogsQuery, totalMinutesQuery, flightAreasQuery]);

        res.json({
            total_log_count: parseInt(totalLogs.rows[0].count, 10),
            monthly_log_count: parseInt(monthlyLogs.rows[0].count, 10),
            total_flight_minutes: parseInt(totalMinutes.rows[0].sum, 10) || 0,
            flight_areas: parseInt(flightAreas.rows[0].count, 10)
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'ダッシュボード統計の取得に失敗しました。' });
    }
  });

  app.listen(PORT, () => console.log(`サーバーがポート ${PORT} で起動しました。`));
})();