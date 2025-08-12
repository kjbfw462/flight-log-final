const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./database.js');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('fontkit');
const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();
const port = process.env.PORT || 3000;

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

const isAuthenticated = (req, res, next) => {
    if (req.session.user && req.session.user.id) return next();
    res.status(401).json({ error: '認証されていません。ログインしてください。' });
};

const startServer = async () => {
    try {
        await db.initializeDB();

        app.post('/api/login/?', async (req, res) => {
            const { email, password } = req.body;
            if (!email || !password) return res.status(400).json({ error: 'メールアドレスとパスワードを入力してください。' });
            try {
                const result = await db.query("SELECT * FROM pilots WHERE email = $1", [email]);
                const pilot = result.rows[0];
                if (!pilot || !(await bcrypt.compare(password, pilot.password))) {
                    return res.status(401).json({ error: 'メールアドレスまたはパスワードが違います。' });
                }
                req.session.user = { id: pilot.id, name: pilot.name, email: pilot.email };
                res.json({ message: 'ログイン成功', user: req.session.user });
            } catch (err) { console.error('Login error:', err); res.status(500).json({ error: 'サーバー内部でエラーが発生しました。' }); }
        });

        app.post('/api/logout/?', (req, res) => {
            req.session.destroy(err => {
                if (err) return res.status(500).json({ error: 'ログアウトに失敗しました。' });
                res.clearCookie('connect.sid').json({ message: 'ログアウト成功' });
            });
        });
        app.get('/api/current-user/?', (req, res) => res.json({ user: req.session.user || null }));

        // Flight Log APIs
        app.get('/api/flight_logs/?', isAuthenticated, async (req, res) => {
            try {
                const result = await db.query(`SELECT fl.*, d.model as drone_model, d.nickname as drone_nickname, p.name as pilot_name FROM flight_logs fl LEFT JOIN drones d ON fl.drone_id = d.id LEFT JOIN pilots p ON fl.pilot_id = p.id WHERE fl.pilot_id = $1 ORDER BY fl.fly_date DESC, fl.id DESC`, [req.session.user.id]);
                res.json({ data: result.rows });
            } catch (err) { res.status(500).json({ error: '飛行日誌の取得に失敗しました。' }); }
        });
        app.get('/api/flight_logs/:id/?', isAuthenticated, async (req, res) => {
            try {
                const result = await db.query('SELECT * FROM flight_logs WHERE id = $1 AND pilot_id = $2', [req.params.id, req.session.user.id]);
                if (result.rows.length === 0) return res.status(404).json({ error: '記録が見つかりません。' });
                res.json({ data: result.rows[0] });
            } catch (err) { res.status(500).json({ error: '日誌の取得に失敗しました。' }); }
        });
        app.post('/api/flight_logs/?', isAuthenticated, async (req, res) => {
            const data = { ...req.body, pilot_id: req.session.user.id };
            delete data.id;
            try {
                const fields = Object.keys(data).filter(k => data[k] !== undefined && data[k] !== null);
                const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
                const values = fields.map(k => data[k]);
                const result = await db.query(`INSERT INTO flight_logs (${fields.join(',')}) VALUES (${placeholders}) RETURNING id`, values);
                res.status(201).json({ id: result.rows[0].id, message: '作成しました' });
            } catch (err) { console.error('Flight log save error:', err); res.status(400).json({ error: '日誌の保存に失敗しました。' }); }
        });
        app.put('/api/flight_logs/:id/?', isAuthenticated, async (req, res) => {
            const data = { ...req.body };
            const id = req.params.id;
            delete data.id;
            const fields = Object.keys(data).map((k, i) => `"${k}" = $${i + 1}`).join(', ');
            const values = Object.values(data);
            try {
                await db.query(`UPDATE flight_logs SET ${fields} WHERE id = $${values.length + 1} AND pilot_id = $${values.length + 2}`, [...values, id, req.session.user.id]);
                res.json({ id: id, message: '更新しました' });
            } catch (err) { console.error('Flight log update error:', err); res.status(400).json({ error: '日誌の更新に失敗しました。' }); }
        });

        // Drone APIs
        app.get('/api/drones/?', isAuthenticated, async (req, res) => {
            try {
                const result = await db.query("SELECT * FROM drones WHERE pilot_id = $1 ORDER BY id DESC", [req.session.user.id]);
                res.json({ data: result.rows });
            } catch (err) { res.status(500).json({ error: '機体情報の取得に失敗しました。' }); }
        });
        app.post('/api/drones/?', isAuthenticated, async (req, res) => {
            const data = { ...req.body, pilot_id: req.session.user.id };
            try {
                const fields = Object.keys(data);
                const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
                const result = await db.query(`INSERT INTO drones (${fields.join(',')}) VALUES (${placeholders}) RETURNING id`, Object.values(data));
                res.status(201).json({ id: result.rows[0].id, message: '作成しました' });
            } catch (err) { console.error('Drone save error:', err); res.status(400).json({ error: '機体情報の保存に失敗しました。' }); }
        });
        app.put('/api/drones/:id/?', isAuthenticated, async (req, res) => {
            const data = req.body;
            const { id } = req.params;
            const pilotId = req.session.user.id;
            const fields = Object.keys(data).map((k, i) => `"${k}" = $${i + 1}`).join(', ');
            const values = Object.values(data);
            try {
                const result = await db.query(`UPDATE drones SET ${fields} WHERE id = $${values.length + 1} AND pilot_id = $${values.length + 2}`, [...values, id, pilotId]);
                if (result.rowCount === 0) return res.status(404).json({ error: '更新対象の機体が見つからないか、権限がありません。' });
                res.json({ id, message: '更新しました' });
            } catch (err) { console.error('Drone update error:', err); res.status(400).json({ error: '機体情報の更新に失敗しました。' }); }
        });

        // Pilot APIs
        app.get('/api/pilots/?', isAuthenticated, async (req, res) => {
             try {
                const result = await db.query(`SELECT p.id, p.name, p.initial_flight_minutes + COALESCE(SUM(fl.actual_time_minutes), 0) AS total_flight_minutes FROM pilots p LEFT JOIN flight_logs fl ON p.id = fl.pilot_id GROUP BY p.id ORDER BY p.name ASC`);
                const data = result.rows.map(row => ({ ...row, total_flight_hours: parseFloat(row.total_flight_minutes) / 60 }));
                res.json({ data });
            } catch (err) { console.error('Pilot list fetch error:', err); res.status(500).json({ error: '操縦者一覧の取得に失敗しました。' }); }
        });
        app.get('/api/pilots/:id/?', isAuthenticated, async (req, res) => {
            try {
                const pilotRes = await db.query("SELECT id, name, name_kana, email, phone, postal_code, prefecture, address1, address2, has_license, initial_flight_minutes FROM pilots WHERE id = $1", [req.params.id]);
                if (pilotRes.rows.length === 0) return res.status(404).json({ error: '操縦者が見つかりません。' });
                const pilot = pilotRes.rows[0];
                const timeRes = await db.query('SELECT SUM(actual_time_minutes) as app_flight_minutes FROM flight_logs WHERE pilot_id = $1', [req.params.id]);
                pilot.app_flight_minutes = parseInt(timeRes.rows[0].app_flight_minutes || 0, 10);
                res.json({ data: pilot });
            } catch (err) { console.error('Pilot detail fetch error:', err); res.status(500).json({ error: '操縦者情報の取得に失敗しました。' }); }
        });
         app.put('/api/pilots/:id/?', isAuthenticated, async (req, res) => {
            if (parseInt(req.params.id, 10) !== req.session.user.id) {
              return res.status(403).json({ error: '自分以外の操縦者情報は編集できません。' });
            }
            const p = req.body;
            try {
                if (p.password && p.password.length > 0) {
                    const hash = await bcrypt.hash(p.password, 10);
                    await db.query(`UPDATE pilots SET name=$1, name_kana=$2, postal_code=$3, prefecture=$4, address1=$5, address2=$6, email=$7, phone=$8, has_license=$9, initial_flight_minutes=$10, password=$11 WHERE id=$12`, [p.name, p.name_kana, p.postal_code, p.prefecture, p.address1, p.address2, p.email, p.phone, p.has_license, p.initial_flight_minutes, hash, req.params.id]);
                } else {
                    await db.query(`UPDATE pilots SET name=$1, name_kana=$2, postal_code=$3, prefecture=$4, address1=$5, address2=$6, email=$7, phone=$8, has_license=$9, initial_flight_minutes=$10 WHERE id=$11`, [p.name, p.name_kana, p.postal_code, p.prefecture, p.address1, p.address2, p.email, p.phone, p.has_license, p.initial_flight_minutes, req.params.id]);
                }
                req.session.user.name = p.name;
                res.json({ message: "操縦者情報を更新しました。" });
            } catch (err) { if (err.code === '23505') { return res.status(409).json({ error: 'このメールアドレスは既に使用されています。' }); } res.status(400).json({ error: '更新に失敗しました。' }); }
        });


        // HTML Page Serving
        const pages = ['/', '/login.html', '/logs.html', '/menu.html', '/form.html', '/drones.html', '/drone-form.html', '/pilots.html', '/pilot-form.html'];
        pages.forEach(page => {
            const filePath = page === '/' ? 'index.html' : page.substring(1);
            app.get(page, (req, res) => {
                res.sendFile(path.join(__dirname, filePath), (err) => {
                    if (err) res.status(404).send('File not found');
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