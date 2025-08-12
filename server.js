const express = require('express');
const path =require('path');
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
                
                // ★★★ ここが修正箇所です ★★★
                // セッションを強制的に保存してからレスポンスを返す
                req.session.save((err) => {
                    if (err) {
                        console.error('Session save error:', err);
                        return res.status(500).json({ error: 'セッションの保存に失敗しました。' });
                    }
                    res.json({ message: 'ログイン成功' });
                });

            } catch (err) { res.status(500).json({ error: 'サーバーエラー' }); }
        });

        // (これ以降のコードは、前回から一切変更ありません)
        app.post('/api/logout', (req, res) => { /* ... */ });
        app.get('/api/current-user', (req, res) => { /* ... */ });
        app.get('/api/flight_logs/pdf', isAuthenticated, async (req, res) => { /* ... */ });
        app.get('/api/flight_logs', isAuthenticated, async (req, res) => { /* ... */ });
        app.get('/api/flight_logs/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.post('/api/flight_logs', isAuthenticated, async (req, res) => { /* ... */ });
        app.put('/api/flight_logs/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.delete('/api/flight_logs/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.get('/api/drones', isAuthenticated, async (req, res) => { /* ... */ });
        app.get('/api/drones/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.post('/api/drones', isAuthenticated, async (req, res) => { /* ... */ });
        app.put('/api/drones/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.delete('/api/drones/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.get('/api/pilots', isAuthenticated, async (req, res) => { /* ... */ });
        app.get('/api/pilots/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.post('/api/pilots', isAuthenticated, async (req, res) => { /* ... */ });
        app.put('/api/pilots/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.delete('/api/pilots/:id', isAuthenticated, async (req, res) => { /* ... */ });
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