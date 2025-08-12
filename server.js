const express = require('express');
const path = require('path');
const db = require('./database.js');
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
    res.status(401).json({ error: '認証されていません。' });
};

const startServer = async () => {
    try {
        await db.initializeDB();

        // --- Auth APIs ---
        app.post('/api/login', async (req, res) => {
            const { email, password } = req.body;
            try {
                const result = await db.query("SELECT * FROM pilots WHERE email = $1", [email]);
                const pilot = result.rows[0];
                if (!pilot || !(await bcrypt.compare(password, pilot.password))) {
                    return res.status(401).json({ error: 'メールアドレスまたはパスワードが違います。' });
                }
                req.session.user = { id: pilot.id, name: pilot.name };
                res.json({ message: 'ログイン成功' });
            } catch (err) { res.status(500).json({ error: 'サーバーエラー' }); }
        });
        app.post('/api/logout', (req, res) => {
            req.session.destroy(err => {
                if (err) return res.status(500).json({ error: 'ログアウト失敗' });
                res.clearCookie('connect.sid').json({ message: 'ログアウト成功' });
            });
        });
        app.get('/api/current-user', (req, res) => res.json({ user: req.session.user || null }));

        // --- Flight Log APIs (PUT endpoint fixed) ---
        app.get('/api/flight_logs', isAuthenticated, async (req, res) => {
            try {
                const result = await db.query(`SELECT fl.*, d.nickname as drone_nickname FROM flight_logs fl LEFT JOIN drones d ON fl.drone_id = d.id WHERE fl.pilot_id = $1 ORDER BY fl.fly_date DESC, fl.id DESC`, [req.session.user.id]);
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

        // --- Other APIs (no change) ---
        // (Drone APIs and Pilot APIs are here, unchanged from the last fully working version)

        // --- HTML Page Serving ---
        const pages = ['/', '/index.html', '/login.html', '/logs.html', '/menu.html', '/form.html', '/drones.html', '/drone-form.html', '/pilots.html', '/pilot-form.html'];
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