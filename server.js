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
    res.status(401).json({ error: '認証されていません。' });
};

// ★★★ ここにRenderのヘルスチェック用コードを追加しました ★★★
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

const startServer = async () => {
    try {
        await db.initializeDB();

        // --- Auth & Dashboard APIs ---
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

        // --- PDF Export API ---
        app.get('/api/flight_logs/pdf', isAuthenticated, async (req, res) => {
            const { start, end } = req.query;
            if (!start || !end) return res.status(400).send('開始日と終了日を指定してください。');
            try {
                const logsRes = await db.query(`SELECT fl.*, d.nickname as drone_name, p.name as pilot_name FROM flight_logs fl LEFT JOIN drones d ON fl.drone_id = d.id LEFT JOIN pilots p ON fl.pilot_id = p.id WHERE fl.pilot_id = $1 AND fl.fly_date BETWEEN $2 AND $3 ORDER BY fl.fly_date ASC, fl.start_time ASC`, [req.session.user.id, start, end]);
                
                const pdfDoc = await PDFDocument.create();
                const fontBytes = fs.readFileSync(path.join(__dirname, 'public', 'fonts', 'NotoSansJP-Regular.ttf'));
                pdfDoc.registerFontkit(fontkit);
                const customFont = await pdfDoc.embedFont(fontBytes);
                
                let page = pdfDoc.addPage();
                // ... (PDF generation logic remains the same)
                
                const pdfBytes = await pdfDoc.save();
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `inline; filename="flight_log.pdf"`);
                res.send(Buffer.from(pdfBytes));
            } catch (err) { console.error(err); res.status(500).send('PDFの生成に失敗しました。'); }
        });

        // --- Flight Log CRUD APIs ---
        app.get('/api/flight_logs', isAuthenticated, async (req, res) => {
            try {
                const result = await db.query(`SELECT fl.*, d.nickname as drone_nickname FROM flight_logs fl LEFT JOIN drones d ON fl.drone_id = d.id WHERE fl.pilot_id = $1 ORDER BY fl.fly_date DESC, fl.id DESC`, [req.session.user.id]);
                res.json({ data: result.rows });
            } catch (err) { res.status(500).json({ error: '飛行履歴の取得に失敗しました。' }); }
        });
        // ... (All other Flight Log, Drone, and Pilot CRUD APIs remain the same as your backup)

        // --- HTML Page Serving ---
        const pages = ['/', '/index.html', '/login.html', '/logs.html', '/menu.html', '/form.html', '/drones.html', '/drone-form.html', '/pilots.html', '/pilot-form.html'];
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