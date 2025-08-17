// --- Pilot CRUD APIs (★★↓ここから差し替え★★) ---
        app.get('/api/pilots', isAuthenticated, async (req, res) => {
            // 全ユーザーの一覧はセキュリティリスクとなるため機能を削除。
            // 将来的に管理者機能が必要になった際に、権限チェックを実装した上で復活させる。
            res.status(403).json({ error: 'この機能は使用できません。' });
        });

        app.get('/api/pilots/:id', isAuthenticated, async (req, res) => {
            try {
                // 自分自身のID（セッション）と、要求されたID（URL）が一致するかを検証
                if (parseInt(req.params.id, 10) !== req.session.user.id) {
                    return res.status(403).json({ error: '権限がありません。' });
                }
                const pilotRes = await db.query("SELECT id, name, name_kana, email, phone, postal_code, prefecture, address1, address2, has_license, initial_flight_minutes FROM pilots WHERE id = $1", [req.params.id]);
                
                if (pilotRes.rows.length === 0) return res.status(404).json({ error: '操縦者が見つかりません。' });
                
                const pilot = pilotRes.rows[0];
                const timeRes = await db.query('SELECT SUM(actual_time_minutes) as app_flight_minutes FROM flight_logs WHERE pilot_id = $1', [req.params.id]);
                pilot.app_flight_minutes = parseInt(timeRes.rows[0].app_flight_minutes || 0, 10);
                res.json({ data: pilot });

            } catch (err) { res.status(500).json({ error: '操縦者情報の取得に失敗しました。' }); }
        });

        app.post('/api/pilots', isAuthenticated, async (req, res) => {
            // 新規作成は変更なし（ただし、将来的には管理者のみが実行できるように制限すべき）
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
            const idToUpdate = parseInt(req.params.id, 10);

            // 自分自身のIDと更新対象のIDが一致するかを検証
            if (idToUpdate !== req.session.user.id) {
                return res.status(403).json({ error: '権限がありません。' });
            }

            try {
                if (p.password) {
                    const hash = await bcrypt.hash(p.password, 10);
                    await db.query(`UPDATE pilots SET name=$1, name_kana=$2, email=$3, phone=$4, postal_code=$5, prefecture=$6, address1=$7, address2=$8, has_license=$9, initial_flight_minutes=$10, password=$11 WHERE id=$12`, [p.name, p.name_kana, p.email, p.phone, p.postal_code, p.prefecture, p.address1, p.address2, p.has_license, p.initial_flight_minutes, hash, idToUpdate]);
                } else {
                    await db.query(`UPDATE pilots SET name=$1, name_kana=$2, email=$3, phone=$4, postal_code=$5, prefecture=$6, address1=$7, address2=$8, has_license=$9, initial_flight_minutes=$10 WHERE id=$11`, [p.name, p.name_kana, p.email, p.phone, p.postal_code, p.prefecture, p.address1, p.address2, p.has_license, p.initial_flight_minutes, idToUpdate]);
                }
                res.json({ id: idToUpdate });
            } catch (err) { res.status(400).json({ error: '更新に失敗しました。' }); }
        });

        app.delete('/api/pilots/:id', isAuthenticated, async (req, res) => {
            const idToDelete = parseInt(req.params.id, 10);

            // 自分自身を削除するリクエストであることを確認
            if (idToDelete !== req.session.user.id) {
                return res.status(403).json({ error: '他人アカウントは削除できません。' });
            }
            try {
                await db.query('DELETE FROM pilots WHERE id = $1', [idToDelete]);
                // ログアウト処理も追加
                req.session.destroy(err => {
                    if (err) { return res.status(500).json({ error: 'セッションの削除に失敗しました。' });}
                    res.clearCookie('connect.sid').status(204).send();
                });
            } catch (err) { res.status(500).json({ error: '削除に失敗しました。' }); }
        });
        // --- (★★↑ここまで差し替え↑★★) ---