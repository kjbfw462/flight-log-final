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

        // --- Flight Log APIs ---
        app.post('/api/flight_logs', isAuthenticated, async (req, res) => {
            const data = { ...req.body, pilot_id: req.session.user.id };
            delete data.id;
            try {
                const fields = Object.keys(data).filter(k => data[k]);
                const values = fields.map(k => data[k]);
                const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
                const result = await db.query(`INSERT INTO flight_logs (${fields.join(',')}) VALUES (${placeholders}) RETURNING id`, values);
                res.status(201).json({ id: result.rows[0].id });
            } catch (err) { res.status(400).json({ error: '保存失敗' }); }
        });
        app.put('/api/flight_logs/:id', isAuthenticated, async (req, res) => {
            const data = req.body;
            const { id } = req.params;
            delete data.id;
            try {
                const fields = Object.keys(data).map((k, i) => `"${k}" = $${i + 1}`).join(', ');
                const values = Object.values(data);
                await db.query(`UPDATE flight_logs SET ${fields} WHERE id = $${values.length + 1} AND pilot_id = $${values.length + 2}`, [...values, id, req.session.user.id]);
                res.json({ id });
            } catch (err) { res.status(400).json({ error: '更新失敗' }); }
        });

        // --- Drone APIs ---
        app.post('/api/drones', isAuthenticated, async (req, res) => {
            const data = { ...req.body, pilot_id: req.session.user.id };
            delete data.id;
            try {
                const fields = Object.keys(data).filter(k => data[k]);
                const values = fields.map(k => data[k]);
                const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
                const result = await db.query(`INSERT INTO drones (${fields.join(',')}) VALUES (${placeholders}) RETURNING id`, values);
                res.status(201).json({ id: result.rows[0].id });
            } catch (err) { res.status(400).json({ error: '保存失敗' }); }
        });
        app.put('/api/drones/:id', isAuthenticated, async (req, res) => {
            const data = req.body;
            const { id } = req.params;
            delete data.id;
            try {
                const fields = Object.keys(data).map((k, i) => `"${k}" = $${i + 1}`).join(', ');
                const values = Object.values(data);
                await db.query(`UPDATE drones SET ${fields} WHERE id = $${values.length + 1} AND pilot_id = $${values.length + 2}`, [...values, id, req.session.user.id]);
                res.json({ id });
            } catch (err) { res.status(400).json({ error: '更新失敗' }); }
        });

        // --- Pilot APIs ---
        app.post('/api/pilots', isAuthenticated, async (req, res) => {
            const p = req.body;
            if (!p.password) return res.status(400).json({ error: 'パスワードは必須です。'});
            try {
                const hash = await bcrypt.hash(p.password, 10);
                const result = await db.query(`INSERT INTO pilots (name, email, password, name_kana, postal_code, prefecture, address1, address2, phone, has_license, initial_flight_minutes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`, [p.name, p.email, hash, p.name_kana, p.postal_code, p.prefecture, p.address1, p.address2, p.phone, p.has_license, p.initial_flight_minutes || 0]);
                res.status(201).json({ id: result.rows[0].id });
            } catch (err) { res.status(400).json({ error: '登録失敗' }); }
        });
        app.put('/api/pilots/:id', isAuthenticated, async (req, res) => {
            const p = req.body;
            const { id } = req.params;
            try {
                if (p.password) {
                    const hash = await bcrypt.hash(p.password, 10);
                    await db.query(`UPDATE pilots SET name=$1, name_kana=$2, email=$3, phone=$4, postal_code=$5, prefecture=$6, address1=$7, address2=$8, has_license=$9, initial_flight_minutes=$10, password=$11 WHERE id=$12`, [p.name, p.name_kana, p.email, p.phone, p.postal_code, p.prefecture, p.address1, p.address2, p.has_license, p.initial_flight_minutes, hash, id]);
                } else {
                    await db.query(`UPDATE pilots SET name=$1, name_kana=$2, email=$3, phone=$4, postal_code=$5, prefecture=$6, address1=$7, address2=$8, has_license=$9, initial_flight_minutes=$10 WHERE id=$11`, [p.name, p.name_kana, p.email, p.phone, p.postal_code, p.prefecture, p.address1, p.address2, p.has_license, p.initial_flight_minutes, id]);
                }
                res.json({ id });
            } catch (err) { res.status(400).json({ error: '更新失敗' }); }
        });
        
        // --- GET and DELETE APIs from previous fixes ---
        app.get('/api/flight_logs/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.delete('/api/flight_logs/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.get('/api/drones/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.delete('/api/drones/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.get('/api/pilots/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.delete('/api/pilots/:id', isAuthenticated, async (req, res) => { /* ... */ });

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