const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./database.js');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('fontkit');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');

// --- アプリケーションの定義 ---
const app = express();
const port = process.env.PORT || 3000;

// --- ファイルアップロードの設定 ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)){ fs.mkdirSync(uploadDir); }
const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, uploadDir); },
    filename: (req, file, cb) => { cb(null, `${Date.now()}-${file.originalname}`); }
});
const upload = multer({ storage: storage });
app.use('/uploads', express.static(uploadDir));

// --- ミドルウェアの設定 ---
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sess = {
    secret: process.env.SESSION_SECRET || 'a-very-secret-key-that-should-be-changed',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24, sameSite: 'lax' }
};
if (app.get('env') === 'production') {
    app.set('trust proxy', 1);
    sess.cookie.secure = true;
}
app.use(session(sess));

// --- 認証チェック ---
const isAuthenticated = (req, res, next) => {
    if (req.session.user && req.session.user.id) return next();
    res.status(401).json({ error: '認証されていません。' });
};

// --- サーバー起動プロセス ---
const startServer = async () => {
    try {
        await db.initializeDB();

        // --- Auth & Dashboard & PDF APIs ---
        app.post('/api/login', async (req, res) => {
            const { email, password } = req.body;
            try {
                const result = await db.query("SELECT * FROM pilots WHERE email = $1", [email]);
                const pilot = result.rows[0];
                if (!pilot || !(await bcrypt.compare(password, pilot.password))) {
                    return res.status(401).json({ error: 'メールアドレスまたはパスワードが違います。' });
                }
                req.session.user = { id: pilot.id, name: pilot.name };
                req.session.save((err) => {
                    if (err) { return res.status(500).json({ error: 'セッションの保存に失敗しました。' }); }
                    res.json({ message: 'ログイン成功' });
                });
            } catch (err) { res.status(500).json({ error: 'サーバーエラー' }); }
        });
        app.post('/api/logout', (req, res) => {
            req.session.destroy(err => {
                if (err) return res.status(500).json({ error: 'ログアウト失敗' });
                res.clearCookie('connect.sid').json({ message: 'ログアウト成功' });
            });
        });
        app.get('/api/current-user', (req, res) => res.json({ user: req.session.user || null }));
        app.get('/api/dashboard-stats', isAuthenticated, async (req, res) => {
            const pilotId = req.session.user.id;
            try {
                const today = new Date();
                const year = today.getFullYear();
                const month = today.getMonth() + 1;
                const firstDayOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
                const queries = [
                    db.query(`SELECT COUNT(id)::int as count FROM flight_logs WHERE pilot_id = $1 AND fly_date >= $2`, [pilotId, firstDayOfMonth]),
                    db.query(`SELECT COUNT(id)::int as count FROM flight_logs WHERE pilot_id = $1`, [pilotId]),
                    db.query(`SELECT COALESCE(p.initial_flight_minutes, 0) + COALESCE(SUM(fl.actual_time_minutes), 0)::int as total_minutes FROM pilots p LEFT JOIN flight_logs fl ON p.id = fl.pilot_id WHERE p.id = $1 GROUP BY p.id`, [pilotId]),
                    db.query(`SELECT COUNT(DISTINCT start_location)::int as count FROM flight_logs WHERE pilot_id = $1`, [pilotId])
                ];
                const [monthly, total, time, areas] = await Promise.all(queries);
                res.json({
                    monthly_log_count: monthly.rows[0]?.count || 0,
                    total_log_count: total.rows[0]?.count || 0,
                    total_flight_minutes: time.rows[0]?.total_minutes || 0,
                    flight_areas: areas.rows[0]?.count || 0
                });
            } catch (err) { res.status(500).json({ error: 'ダッシュボードデータの取得に失敗しました。' }); }
        });
        app.get('/api/flight_logs/pdf', isAuthenticated, async (req, res) => { /* (PDF logic as approved) */ });

        // --- Flight Log CRUD APIs ---
        app.get('/api/flight_logs', isAuthenticated, async (req, res) => {
            try {
                const { drone_id } = req.query;
                let query = `SELECT fl.*, d.nickname as drone_nickname FROM flight_logs fl LEFT JOIN drones d ON fl.drone_id = d.id WHERE fl.pilot_id = $1`;
                const params = [req.session.user.id];
                if (drone_id) {
                    query += ` AND fl.drone_id = $2`;
                    params.push(drone_id);
                }
                query += ` ORDER BY fl.fly_date DESC, fl.id DESC`;
                const result = await db.query(query, params);
                res.json({ data: result.rows });
            } catch (err) { res.status(500).json({ error: '飛行履歴の取得に失敗しました。' }); }
        });
        app.get('/api/flight_logs/:id', isAuthenticated, async (req, res) => {
            try {
                const result = await db.query('SELECT * FROM flight_logs WHERE id = $1 AND pilot_id = $2', [req.params.id, req.session.user.id]);
                if (result.rows.length === 0) return res.status(404).json({ error: '記録が見つかりません。' });
                res.json({ data: result.rows[0] });
            } catch (err) { res.status(500).json({ error: '日誌の取得に失敗しました。' }); }
        });
        app.post('/api/flight_logs', isAuthenticated, async (req, res) => {
            const data = { ...req.body, pilot_id: req.session.user.id };
            delete data.id;
            for (const key in data) { if (data[key] === '') data[key] = null; }
            try {
                const fields = Object.keys(data).filter(k => data[k] !== null);
                const values = fields.map(k => data[k]);
                const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
                const result = await db.query(`INSERT INTO flight_logs (${fields.join(',')}) VALUES (${placeholders}) RETURNING id`, values);
                res.status(201).json({ id: result.rows[0].id });
            } catch (err) { res.status(400).json({ error: '保存に失敗しました。' }); }
        });
        app.put('/api/flight_logs/:id', isAuthenticated, async (req, res) => {
            const data = req.body;
            const { id } = req.params;
            delete data.id;
            for (const key in data) { if (data[key] === '') data[key] = null; }
            try {
                const fields = Object.keys(data).map((k, i) => `"${k}" = $${i + 1}`).join(', ');
                const values = Object.values(data);
                await db.query(`UPDATE flight_logs SET ${fields} WHERE id = $${values.length + 1} AND pilot_id = $${values.length + 2}`, [...values, id, req.session.user.id]);
                res.json({ id });
            } catch (err) { res.status(400).json({ error: '更新に失敗しました。' }); }
        });
        app.delete('/api/flight_logs/:id', isAuthenticated, async (req, res) => {
            try {
                const result = await db.query('DELETE FROM flight_logs WHERE id = $1 AND pilot_id = $2', [req.params.id, req.session.user.id]);
                if (result.rowCount === 0) return res.status(404).json({ error: '削除対象のデータが見つかりません。' });
                res.status(204).send();
            } catch (err) { res.status(500).json({ error: '削除に失敗しました。'}); }
        });

        // --- Drone CRUD APIs ---
        app.get('/api/drones', isAuthenticated, async (req, res) => {
            try {
                const result = await db.query("SELECT * FROM drones WHERE pilot_id = $1 ORDER BY nickname ASC", [req.session.user.id]);
                res.json({ data: result.rows });
            } catch (err) { res.status(500).json({ error: '機体情報の取得に失敗しました。' }); }
        });
        app.get('/api/drones/:id', isAuthenticated, async (req, res) => {
            try {
                const result = await db.query('SELECT * FROM drones WHERE id = $1 AND pilot_id = $2', [req.params.id, req.session.user.id]);
                if (result.rows.length === 0) return res.status(404).json({ error: '機体が見つかりません。' });
                res.json({ data: result.rows[0] });
            } catch (err) { res.status(500).json({ error: '機体情報の取得に失敗しました。' }); }
        });
        app.post('/api/drones', isAuthenticated, async (req, res) => {
            const data = { ...req.body, pilot_id: req.session.user.id };
            delete data.id;
            for (const key in data) { if (data[key] === '') data[key] = null; }
            try {
                const fields = Object.keys(data).filter(k => data[k] !== null);
                const values = fields.map(k => data[k]);
                const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
                const result = await db.query(`INSERT INTO drones (${fields.join(',')}) VALUES (${placeholders}) RETURNING id`, values);
                res.status(201).json({ id: result.rows[0].id });
            } catch (err) { res.status(400).json({ error: '保存に失敗しました。' }); }
        });
        app.put('/api/drones/:id', isAuthenticated, async (req, res) => {
            const data = req.body;
            const { id } = req.params;
            delete data.id;
            for (const key in data) { if (data[key] === '') data[key] = null; }
            try {
                const fields = Object.keys(data).map((k, i) => `"${k}" = $${i + 1}`).join(', ');
                const values = Object.values(data);
                await db.query(`UPDATE drones SET ${fields} WHERE id = $${values.length + 1} AND pilot_id = $${values.length + 2}`, [...values, id, req.session.user.id]);
                res.json({ id });
            } catch (err) { res.status(400).json({ error: '更新に失敗しました。' }); }
        });
        app.delete('/api/drones/:id', isAuthenticated, async (req, res) => {
            try {
                const logCheck = await db.query('SELECT 1 FROM flight_logs WHERE drone_id = $1 AND pilot_id = $2 LIMIT 1', [req.params.id, req.session.user.id]);
                if (logCheck.rows.length > 0) { return res.status(400).json({ error: 'この機体を使用している飛行日誌が存在するため、削除できません。' }); }
                const result = await db.query('DELETE FROM drones WHERE id = $1 AND pilot_id = $2', [req.params.id, req.session.user.id]);
                if (result.rowCount === 0) return res.status(404).json({ error: '削除対象のデータが見つかりません。' });
                res.status(204).send();
            } catch (err) { res.status(500).json({ error: '削除に失敗しました。' }); }
        });
        
        // --- Pilot CRUD APIs (With Security Fix) ---
        app.get('/api/pilots', isAuthenticated, async (req, res) => {
            res.status(403).json({ error: 'この機能は使用できません。' });
        });
        app.get('/api/pilots/:id', isAuthenticated, async (req, res) => {
            try {
                if (parseInt(req.params.id, 10) !== req.session.user.id) {
                    return res.status(403).json({ error: '権限がありません。' });
                }
                const pilotRes = await db.query("SELECT id, name, name_kana, email, phone, postal_code, prefecture, address1, address2, has_license, initial_flight_minutes FROM pilots WHERE id = $1", [req.params.id]);
                if (pilotRes.rows.length === 0) return res.status(404).json({ error: '操縦者が見つかりません。' });
                const pilot = pilotRes.rows[0];
                const timeRes = await db.query('SELECT SUM(actual_time_minutes) as app_flight_minutes FROM flight_logs WHERE pilot_id = $1', [req.params.id]);
                pilot.app_flight_minutes = parseInt(timeRes.rows[0].app_flight_minutes || 0, 10);
                res.json({ data: pilot });
            } catch (err) { res.status(500).json({ error: '操縦者情報の取得に失敗しました。' }); }
        });
        app.post('/api/pilots', isAuthenticated, async (req, res) => { /* ... */ });
        app.put('/api/pilots/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.delete('/api/pilots/:id', isAuthenticated, async (req, res) => { /* ... */ });

        // --- Maintenance Record APIs (With Security Fix) ---
        app.get('/api/maintenance_records', isAuthenticated, async (req, res) => {
            const { drone_id } = req.query;
            if (!drone_id) return res.status(400).json({ error: '機体IDが必要です。' });
            try {
                const droneCheck = await db.query('SELECT id FROM drones WHERE id = $1 AND pilot_id = $2', [drone_id, req.session.user.id]);
                if (droneCheck.rows.length === 0) return res.status(403).json({ error: '権限がありません。' });
                const result = await db.query('SELECT * FROM maintenance_records WHERE drone_id = $1 ORDER BY maintenance_date DESC', [drone_id]);
                res.json({ data: result.rows });
            } catch (err) { res.status(500).json({ error: '点検整備記録の取得に失敗しました。' }); }
        });
        app.get('/api/maintenance_records/:id', isAuthenticated, async (req, res) => {
            try {
                const result = await db.query(`SELECT mr.* FROM maintenance_records mr JOIN drones d ON mr.drone_id = d.id WHERE mr.id = $1 AND d.pilot_id = $2`, [req.params.id, req.session.user.id]);
                if (result.rows.length === 0) return res.status(404).json({ error: '記録が見つからないか、権限がありません。' });
                res.json({ data: result.rows[0] });
            } catch (err) { res.status(500).json({ error: '記録の取得に失敗しました。' }); }
        });
        app.post('/api/maintenance_records', isAuthenticated, upload.single('attachment'), async (req, res) => { /* ... */ });
        app.put('/api/maintenance_records/:id', isAuthenticated, upload.single('attachment'), async (req, res) => { /* ... */ });
        app.delete('/api/maintenance_records/:id', isAuthenticated, async (req, res) => { /* ... */ });

        // --- HTML Page Serving ---
        const pages = [
            '/', '/index.html', '/login.html', '/logs.html',
            '/menu.html', '/drones.html', '/drone-form.html',
            '/my-profile.html', '/pilot-form.html',
            '/drone-detail.html', '/maintenance-form.html'
        ];
        pages.forEach(page => {
            const filePath = page === '/' ? 'index.html' : page.substring(1);
            app.get(page, (req, res) => {
                res.sendFile(path.join(__dirname, filePath), (err) => {
                    if (err) res.status(404).send('ファイルが見つかりません');
                });
            });
        });
        
        app.listen(port, () => {
            console.log(`✅ アプリケーションサーバーがポート ${port} で正常に起動しました。`);
        });
    } catch (err) {
        console.error('サーバー起動に失敗しました:', err);
        process.exit(1);
    }
};

startServer();