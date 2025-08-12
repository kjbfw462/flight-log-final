const express = require('express');
const path = require('path');
const fs = require('fs'); // PDF生成に必要
const db = require('./database.js');
const { PDFDocument, rgb } = require('pdf-lib'); // PDF生成に必要
const fontkit = require('fontkit'); // PDF生成に必要
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

        // --- (他のAPIは変更なし) ---
        app.post('/api/login', async (req, res) => { /* ... */ });
        app.post('/api/logout', async (req, res) => { /* ... */ });
        app.get('/api/current-user', async (req, res) => { /* ... */ });
        app.get('/api/flight_logs', isAuthenticated, async (req, res) => { /* ... */ });
        app.post('/api/flight_logs', isAuthenticated, async (req, res) => { /* ... */ });
        app.put('/api/flight_logs/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.delete('/api/flight_logs/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.get('/api/drones', isAuthenticated, async (req, res) => { /* ... */ });
        app.post('/api/drones', isAuthenticated, async (req, res) => { /* ... */ });
        app.put('/api/drones/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.delete('/api/drones/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.get('/api/pilots', isAuthenticated, async (req, res) => { /* ... */ });
        app.get('/api/pilots/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.post('/api/pilots', isAuthenticated, async (req, res) => { /* ... */ });
        app.put('/api/pilots/:id', isAuthenticated, async (req, res) => { /* ... */ });
        app.delete('/api/pilots/:id', isAuthenticated, async (req, res) => { /* ... */ });

        // ★★★ ここからPDF出力APIを追加 ★★★
        app.get('/api/flight_logs/pdf', isAuthenticated, async (req, res) => {
            const { start, end } = req.query;
            if (!start || !end) {
                return res.status(400).send('開始日と終了日を指定してください。');
            }
            try {
                const logsRes = await db.query(`
                    SELECT fl.*, d.nickname as drone_name
                    FROM flight_logs fl
                    LEFT JOIN drones d ON fl.drone_id = d.id
                    WHERE fl.pilot_id = $1 AND fl.fly_date BETWEEN $2 AND $3
                    ORDER BY fl.fly_date ASC
                `, [req.session.user.id, start, end]);
                
                const pdfDoc = await PDFDocument.create();
                const fontBytes = fs.readFileSync(path.join(__dirname, 'fonts', 'NotoSansJP-Regular.ttf'));
                pdfDoc.registerFontkit(fontkit);
                const customFont = await pdfDoc.embedFont(fontBytes);
                
                let page = pdfDoc.addPage();
                const { height } = page.getSize();
                let y = height - 50;

                const drawText = (text, x, _y, size = 10) => {
                    page.drawText(text, { x, y: _y, font: customFont, size, color: rgb(0, 0, 0) });
                };

                drawText('飛行記録', 50, y, 24);
                y -= 40;
                drawText(`期間: ${start} 〜 ${end}`, 50, y, 12);
                y -= 30;

                if (logsRes.rows.length === 0) {
                    drawText('対象期間の飛行記録はありません。', 50, y);
                } else {
                    logsRes.rows.forEach(log => {
                        if (y < 60) {
                            page = pdfDoc.addPage();
                            y = height - 50;
                        }
                        const logDate = new Date(log.fly_date).toLocaleDateString();
                        drawText(`${logDate} - ${log.start_location || ''}`, 50, y, 12);
                        y -= 18;
                        drawText(`  機体: ${log.drone_name || '未設定'}, 飛行時間: ${log.actual_time_minutes || 0}分`, 60, y, 9);
                        y -= 25;
                    });
                }
                
                const pdfBytes = await pdfDoc.save();
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `inline; filename="flight_log_${start}_to_${end}.pdf"`);
                res.send(Buffer.from(pdfBytes));

            } catch (err) {
                console.error('PDF generation error:', err);
                res.status(500).send('PDFの生成に失敗しました。');
            }
        });
        // ★★★ ここまで追加 ★★★

        // HTML Page Serving
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