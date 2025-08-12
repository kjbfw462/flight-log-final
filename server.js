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

        // --- Auth APIs ---
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

        // --- Flight Log APIs ---
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
        app.delete('/api/flight_logs/:id/?', isAuthenticated, async (req, res) => {
            try {
                const result = await db.query('DELETE FROM flight_logs WHERE id = $1 AND pilot_id = $2', [req.params.id, req.session.user.id]);
                if (result.rowCount === 0) return res.status(404).json({ error: '削除対象のデータが見つからないか、権限がありません。' });
                res.status(204).send();
            } catch (err) { console.error('Flight log delete error:', err); res.status(500).json({ error: '削除に失敗しました。'});
            }
        });

        // --- Drone APIs ---
        app.get('/api/drones/?', isAuthenticated, async (req, res) => {
            try {
                const result = await db.query("SELECT * FROM drones WHERE pilot_id = $1 ORDER BY id DESC", [req.session.user.id]);
                res.json({ data: result.rows });
            } catch (err) { res.status(500).json({ error: '機体情報の取得に失敗しました。' }); }
        });
        app.get('/api/drones/:id/?', isAuthenticated, async (req, res) => {
            try {
                const result = await db.query('SELECT * FROM drones WHERE id = $1 AND pilot_id = $2', [req.params.id, req.session.user.id]);
                if (result.rows.length === 0) return res.status(404).json({ error: '機体が見つかりません。' });
                res.json({ data: result.rows[0] });
            } catch (err) { res.status(500).json({ error: '機体情報の取得に失敗しました。' }); }
        });
        app.delete('/api/drones/:id/?', isAuthenticated, async (req, res) => {
            try {
                const logCheck = await db.query('SELECT 1 FROM flight_logs WHERE drone_id = $1 AND pilot_id = $2 LIMIT 1', [req.params.id, req.session.user.id]);
                if (logCheck.rows.length > 0) { return res.status(400).json({ error: 'この機体を使用している飛行日誌が存在するため、削除できません。' }); }
                const result = await db.query('DELETE FROM drones WHERE id = $1 AND pilot_id = $2', [req.params.id, req.session.user.id]);
                if (result.rowCount === 0) return res.status(404).json({ error: '削除対象のデータが見つからないか、権限がありません。' });
                res.status(204).send();
            } catch (err) { console.error('Drone delete error:', err); res.status(500).json({ error: '削除に失敗しました。' }); }
        });

        // --- Pilot APIs ---
        app.get('/api/pilots/?', isAuthenticated, async (req, res) => {
             try {
                const result = await db.query(`SELECT p.id, p.name FROM pilots p ORDER BY p.name ASC`);
                res.json({ data: result.rows });
            } catch (err) { console.error('Pilot list fetch error:', err); res.status(500).json({ error: '操縦者一覧の取得に失敗しました。' }); }
        });
        // ★★★ ここから追加 ★★★
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
        // ★★★ ここまで追加 ★★★
        app.delete('/api/pilots/:id/?', isAuthenticated, async (req, res) => {
            const pilotIdToDelete = parseInt(req.params.id, 10);
            const currentUserId = req.session.user.id;
            if (pilotIdToDelete === currentUserId) { return res.status(403).json({ error: '自分自身のアカウントは削除できません。' }); }
            try {
                const logCheck = await db.query('SELECT 1 FROM flight_logs WHERE pilot_id = $1 LIMIT 1', [pilotIdToDelete]);
                if (logCheck.rows.length > 0) { return res.status(400).json({ error: 'この操縦者に関連する飛行日誌が存在するため、削除できません。' }); }
                const droneCheck = await db.query('SELECT 1 FROM drones WHERE pilot_id = $1 LIMIT 1', [pilotIdToDelete]);
                if (droneCheck.rows.length > 0) { return res.status(400).json({ error: 'この操縦者に関連する機体が存在するため、削除できません。' }); }
                const result = await db.query('DELETE FROM pilots WHERE id = $1', [pilotIdToDelete]);
                if (result.rowCount === 0) return res.status(404).json({ error: '削除対象の操縦者が見つかりません。' });
                res.status(204).send();
            } catch (err) { console.error('Pilot delete error:', err); res.status(500).json({ error: '削除に失敗しました。' }); }
        });
        
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