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

const startServer = async () => {
    try {
        await db.initializeDB();

        // --- Auth & Dashboard APIs (No change) ---
        app.post('/api/login', async (req, res) => { /* ... */ });
        app.post('/api/logout', (req, res) => { /* ... */ });
        app.get('/api/current-user', (req, res) => { /* ... */ });
        app.get('/api/dashboard-stats', isAuthenticated, async (req, res) => { /* ... */ });

        // --- PDF Export API (The only change is here) ---
        app.get('/api/flight_logs/pdf', isAuthenticated, async (req, res) => {
            const { start, end } = req.query;
            if (!start || !end) return res.status(400).send('開始日と終了日を指定してください。');
            try {
                const logsRes = await db.query(`SELECT fl.*, d.nickname as drone_name, p.name as pilot_name FROM flight_logs fl LEFT JOIN drones d ON fl.drone_id = d.id LEFT JOIN pilots p ON fl.pilot_id = p.id WHERE fl.pilot_id = $1 AND fl.fly_date BETWEEN $2 AND $3 ORDER BY fl.fly_date ASC, fl.start_time ASC`, [req.session.user.id, start, end]);
                
                const pdfDoc = await PDFDocument.create();
                const fontBytes = fs.readFileSync(path.join(__dirname, 'fonts', 'NotoSansJP-Regular.ttf'));
                pdfDoc.registerFontkit(fontkit);
                const customFont = await pdfDoc.embedFont(fontBytes);

                // --- ▼▼▼ ここからがPDFに内容を書き込む処理 ▼▼▼ ---
                let page = pdfDoc.addPage();
                const { width, height } = page.getSize();
                const fontSize = 10;
                const titleFontSize = 16;
                const margin = 50;
                let y = height - margin;

                const title = '飛行記録';
                const titleWidth = customFont.widthOfTextAtSize(title, titleFontSize);
                page.drawText(title, {
                    x: (width - titleWidth) / 2,
                    y: y,
                    font: customFont,
                    size: titleFontSize,
                    color: rgb(0, 0, 0),
                });
                y -= 40;

                for (const log of logsRes.rows) {
                    if (y < margin + 50) { 
                        page = pdfDoc.addPage();
                        y = height - margin;
                    }

                    const date = log.fly_date ? new Date(log.fly_date).toLocaleDateString() : '日付未設定';
                    const location = log.start_location || '場所未設定';
                    page.drawText(`${date} | ${location}`, {
                        x: margin, y: y, font: customFont, size: fontSize + 2, color: rgb(0.1, 0.1, 0.1),
                    });
                    y -= 20;

                    page.drawLine({
                        start: { x: margin, y: y + 5 }, end: { x: width - margin, y: y + 5 },
                        thickness: 0.5, color: rgb(0.8, 0.8, 0.8),
                    });
                    y -= 15;

                    const flightTime = log.actual_time_minutes ? `${log.actual_time_minutes}分` : '時間未設定';
                    const droneName = log.drone_name || '機体未設定';
                    page.drawText(`機体: ${droneName}`, { x: margin + 10, y: y, font: customFont, size: fontSize });
                    page.drawText(`飛行時間: ${flightTime}`, { x: margin + 200, y: y, font: customFont, size: fontSize });
                    y -= 25; 
                }
                // --- ▲▲▲ ここまで ▲▲▲ ---

                const pdfBytes = await pdfDoc.save();
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `inline; filename="flight_log.pdf"`);
                res.send(Buffer.from(pdfBytes));
            } catch (err) { console.error(err); res.status(500).send('PDFの生成に失敗しました。'); }
        });

        // --- All other CRUD APIs (No change) ---
        // (Includes full implementations for flight_logs, drones, and pilots)

        // --- HTML Page Serving (No change) ---
        const pages = ['/', '/index.html', '/login.html', '/logs.html', '/menu.html', '/form.html', '/drones.html', '/drone-form.html', '/pilots.html', '/pilot-form.html'];
        pages.forEach(page => { /* ... */ });
        
        app.listen(port, () => {
            console.log(`✅ アプリケーションサーバーがポート ${port} で正常に起動しました。`);
        });
    } catch (err) {
        console.error('サーバー起動に失敗しました:', err);
        process.exit(1);
    }
};

startServer();