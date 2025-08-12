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

        // --- Auth APIs (No change) ---
        app.post('/api/login', async (req, res) => { /* ... */ });
        app.post('/api/logout', (req, res) => { /* ... */ });
        app.get('/api/current-user', (req, res) => { /* ... */ });

        // --- PDF Export API (The only change is here) ---
        app.get('/api/flight_logs/pdf', isAuthenticated, async (req, res) => {
            const { start, end } = req.query;
            if (!start || !end) {
                return res.status(400).send('開始日と終了日を指定してください。');
            }
            try {
                const logsRes = await db.query(`
                    SELECT fl.*, d.nickname as drone_name, p.name as pilot_name
                    FROM flight_logs fl
                    LEFT JOIN drones d ON fl.drone_id = d.id
                    LEFT JOIN pilots p ON fl.pilot_id = p.id
                    WHERE fl.pilot_id = $1 AND fl.fly_date BETWEEN $2 AND $3
                    ORDER BY fl.fly_date ASC, fl.start_time ASC
                `, [req.session.user.id, start, end]);
                
                const pdfDoc = await PDFDocument.create();
                const fontBytes = fs.readFileSync(path.join(__dirname, 'fonts', 'NotoSansJP-Regular.ttf'));
                pdfDoc.registerFontkit(fontkit);
                const customFont = await pdfDoc.embedFont(fontBytes);
                
                let page = pdfDoc.addPage();
                const { width, height } = page.getSize();
                let y = height - 40;

                const drawText = (text, x, _y, size = 10) => {
                    if (text === null || text === undefined) text = '';
                    page.drawText(text.toString(), { x, y: _y, font: customFont, size, color: rgb(0, 0, 0) });
                };

                drawText('飛行日誌', 40, y, 24);
                y -= 40;

                if (logsRes.rows.length === 0) {
                    drawText('対象期間の飛行記録はありません。', 50, y);
                } else {
                    logsRes.rows.forEach((log, index) => {
                        if (index > 0) {
                            page = pdfDoc.addPage();
                            y = height - 40;
                        }
                        
                        drawText(`Page ${index + 1} of ${logsRes.rows.length}`, width - 100, y + 20, 10);

                        // --- 飛行記録セクション ---
                        drawText('飛行記録', 50, y, 16);
                        y -= 25;
                        drawText(`飛行年月日: ${new Date(log.fly_date).toLocaleDateString()}`, 60, y);
                        drawText(`操縦者: ${log.pilot_name || ''}`, 300, y);
                        y -= 20;
                        drawText(`機体: ${log.drone_name || ''}`, 60, y);
                        y -= 20;
                        drawText(`離陸場所: ${log.start_location || ''}`, 60, y);
                        drawText(`着陸場所: ${log.end_location || ''}`, 300, y);
                        y -= 20;
                        drawText(`離陸時刻: ${log.start_time || ''}`, 60, y);
                        drawText(`着陸時刻: ${log.end_time || ''}`, 300, y);
                        y -= 20;
                        drawText(`実飛行時間: ${log.actual_time_minutes || 0}分`, 300, y);
                        y -= 30;

                        // --- 日常点検（飛行前）セクション ---
                        drawText('日常点検（飛行前）', 50, y, 16);
                        y -= 25;
                        drawText(`点検年月日: ${new Date(log.precheck_date).toLocaleDateString()}`, 60, y);
                        drawText(`点検者: ${log.inspector || ''}`, 300, y);
                        y -= 20;
                        drawText(`実施場所: ${log.place || ''}`, 60, y);
                        y -= 20;
                        drawText(`機体全般: ${log.body || ''}`, 60, y);
                        drawText(`プロペラ: ${log.propeller || ''}`, 160, y);
                        drawText(`フレーム: ${log.frame || ''}`, 260, y);
                        drawText(`通信系統: ${log.comm || ''}`, 360, y);
                        y -= 20;
                        drawText(`推進系統: ${log.engine || ''}`, 60, y);
                        drawText(`電源系統: ${log.power || ''}`, 160, y);
                        drawText(`自動制御系統: ${log.autocontrol || ''}`, 260, y);
                        y -= 20;
                        drawText(`操縦装置: ${log.controller || ''}`, 60, y);
                        drawText(`バッテリー: ${log.battery || ''}`, 160, y);
                        y -= 30;
                        
                        // --- レポートセクション ---
                        drawText('レポート（飛行中の不具合）', 50, y, 16);
                        y -= 25;
                        drawText(`${log.flight_abnormal || ''}`, 60, y);
                        y -= 30;

                        // --- 日常点検（飛行後）セクション ---
                        drawText('日常点検（飛行後）', 50, y, 16);
                        y -= 25;
                        drawText(`${log.aftercheck || ''}`, 60, y);
                    });
                }
                
                const pdfBytes = await pdfDoc.save();
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `inline; filename="flight_log.pdf"`);
                res.send(Buffer.from(pdfBytes));

            } catch (err) {
                console.error('PDF generation error:', err);
                res.status(500).send('PDFの生成に失敗しました。');
            }
        });

        // --- All other CRUD APIs ---
        app.get('/api/flight_logs', isAuthenticated, async (req, res) => { /* ... */ });
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