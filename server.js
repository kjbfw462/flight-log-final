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
                        
                        drawText(`Page ${index + 1} of ${logsRes.rows.length}`, width - 100, y + 20, 8);

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

                        drawText('日常点検（飛行前）', 50, y, 16);
                        y -= 25;
                        drawText(`点検年月日: ${new Date(log.precheck_date).toLocaleDateString()}`, 60, y);
                        drawText(`点検者: ${log.inspector || ''}`, 300, y);
                        y -= 20;
                        drawText(`実施場所: ${log.place || ''}`, 60, y);
                        y -= 20;
                        drawText(`機体全般: ${log.body || ''}`, 60, y);
                        drawText(`プロペラ: ${log.propeller || ''}`, 180, y);
                        drawText(`フレーム: ${log.frame || ''}`, 300, y);
                        y -= 20;
                        drawText(`通信系統: ${log.comm || ''}`, 60, y);
                        drawText(`推進系統: ${log.engine || ''}`, 180, y);
                        drawText(`電源系統: ${log.power || ''}`, 300, y);
                        y -= 20;
                        drawText(`自動制御系統: ${log.autocontrol || ''}`, 60, y);
                        drawText(`操縦装置: ${log.controller || ''}`, 180, y);
                        drawText(`バッテリー: ${log.battery || ''}`, 300, y);
                        y -= 30;
                        
                        drawText('レポート（飛行中の不具合）', 50, y, 16);
                        y -= 25;
                        drawText(`${log.flight_abnormal || ''}`, 60, y);
                        y -= 30;

                        drawText('日常点検（飛行後）', 50, y, 16);
                        y -= 25;
                        drawText(`${log.aftercheck || ''}`, 60, y);
                    });
                }
                
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

        // --- Pilot CRUD APIs ---
        app.get('/api/pilots', isAuthenticated, async (req, res) => {
            try {
               const result = await db.query(`SELECT p.id, p.name FROM pilots p ORDER BY p.name ASC`);
               res.json({ data: result.rows });
           } catch (err) { res.status(500).json({ error: '操縦者一覧の取得に失敗しました。' }); }
        });
        app.get('/api/pilots/:id', isAuthenticated, async (req, res) => {
            try {
                const pilotRes = await db.query("SELECT id, name, name_kana, email, phone, postal_code, prefecture, address1, address2, has_license, initial_flight_minutes FROM pilots WHERE id = $1", [req.params.id]);
                if (pilotRes.rows.length === 0) return res.status(404).json({ error: '操縦者が見つかりません。' });
                const pilot = pilotRes.rows[0];
                const timeRes = await db.query('SELECT SUM(actual_time_minutes) as app_flight_minutes FROM flight_logs WHERE pilot_id = $1', [req.params.id]);
                pilot.app_flight_minutes = parseInt(timeRes.rows[0].app_flight_minutes || 0, 10);
                res.json({ data: pilot });
            } catch (err) { res.status(500).json({ error: '操縦者情報の取得に失敗しました。' }); }
        });
        app.post('/api/pilots', isAuthenticated, async (req, res) => {
            const p = req.body;
            if (!p.password) return res.status(400).json({ error: 'パスワードは必須です。'});
            try {
                const hash = await bcrypt.hash(p.password, 10);
                await db.query(`INSERT INTO pilots (name, email, password, name_kana, postal_code, prefecture, address1, address2, phone, has_license, initial_flight_minutes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`, [p.name, p.email, hash, p.name_kana, p.postal_code, p.prefecture, p.address1, p.address2, p.phone, p.has_license, p.initial_flight_minutes || 0]);
                res.status(201).json({ message: '作成しました' });
            } catch (err) {
                if (err.code === '23505') { return res.status(409).json({ error: 'このメールアドレスは既に使用されています。' }); }
                res.status(400).json({ error: '登録に失敗しました。' });
            }
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
            } catch (err) { res.status(400).json({ error: '更新に失敗しました。' }); }
        });
        app.delete('/api/pilots/:id', isAuthenticated, async (req, res) => {
            const pilotIdToDelete = parseInt(req.params.id, 10);
            if (pilotIdToDelete === req.session.user.id) { return res.status(403).json({ error: '自分自身のアカウントは削除できません。' }); }
            try {
                await db.query('DELETE FROM pilots WHERE id = $1', [pilotIdToDelete]);
                res.status(204).send();
            } catch (err) { res.status(500).json({ error: '削除に失敗しました。' }); }
        });
        
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