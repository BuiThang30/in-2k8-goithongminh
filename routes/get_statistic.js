const express = require("express");
const router = express.Router();
const db = require('../db')
const sleepAnalysisService = require('../sleepAnalyzer/sleepAnalysisService')
const analysisService = new sleepAnalysisService({ openaiApiKey: process.env.OPENAI_API_KEY })

// deviceID của tài khoản đang đăng nhập: chỉ xem được báo cáo của gối mình
function sessionDeviceID(req) {
    const id = req.session && req.session.user ? parseInt(req.session.user.deviceID, 10) : NaN;
    return Number.isNaN(id) ? null : id;
}

// ===== Đánh dấu ngày: ngày đó đang đo ai =====
db.run(`CREATE TABLE IF NOT EXISTS dayMarks (
    deviceID INTEGER NOT NULL,
    day TEXT NOT NULL,
    name TEXT NOT NULL,
    age INTEGER,
    color TEXT NOT NULL DEFAULT '#f59e0b',
    updatedAt INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (deviceID, day)
)`);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function daysBetween(from, to) {
    const out = [];
    const start = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z');
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
    for (let t = start; t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
    return out.length <= 366 ? out : null;
}
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

router.get('/marks', function (req, res) {
    const deviceID = sessionDeviceID(req);
    if (deviceID === null) return res.status(401).json({ success: false, error: 'Chưa đăng nhập' });
    db.all(`SELECT day, name, age, color FROM dayMarks WHERE deviceID = ? ORDER BY day`, [deviceID], (err, rows) => {
        if (err) return res.json({ success: false, error: err.message });
        res.json({ success: true, data: rows });
    });
});

// Lưu đánh dấu cho một ngày hoặc một khoảng ngày: { from, to?, name, age?, color }
router.post('/marks', async function (req, res) {
    const deviceID = sessionDeviceID(req);
    if (deviceID === null) return res.status(401).json({ success: false, error: 'Chưa đăng nhập' });
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 40);
    const color = String(b.color || '');
    const age = b.age === '' || b.age == null ? null : parseInt(b.age, 10);
    if (!DAY_RE.test(b.from || '') || (b.to && !DAY_RE.test(b.to))) return res.json({ success: false, error: 'Ngày không hợp lệ' });
    if (!name) return res.json({ success: false, error: 'Hãy nhập tên người được đo' });
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return res.json({ success: false, error: 'Màu không hợp lệ' });
    if (age !== null && (Number.isNaN(age) || age < 1 || age > 120)) return res.json({ success: false, error: 'Tuổi không hợp lệ' });
    const days = daysBetween(b.from, b.to || b.from);
    if (!days) return res.json({ success: false, error: 'Khoảng ngày không hợp lệ (tối đa 366 ngày)' });
    try {
        await dbRun('BEGIN');
        for (const d of days) {
            await dbRun(
                `INSERT INTO dayMarks (deviceID, day, name, age, color, updatedAt) VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
                 ON CONFLICT(deviceID, day) DO UPDATE SET name = excluded.name, age = excluded.age, color = excluded.color, updatedAt = excluded.updatedAt`,
                [deviceID, d, name, age, color]
            );
        }
        await dbRun('COMMIT');
        res.json({ success: true, count: days.length });
    } catch (e) {
        try { await dbRun('ROLLBACK'); } catch (_) { /* chưa mở giao dịch */ }
        res.json({ success: false, error: e.message });
    }
});

// Xóa đánh dấu: ?from=YYYY-MM-DD&to=YYYY-MM-DD (to có thể bỏ trống)
router.delete('/marks', async function (req, res) {
    const deviceID = sessionDeviceID(req);
    if (deviceID === null) return res.status(401).json({ success: false, error: 'Chưa đăng nhập' });
    const { from, to } = req.query;
    if (!DAY_RE.test(from || '') || (to && !DAY_RE.test(to))) return res.json({ success: false, error: 'Ngày không hợp lệ' });
    try {
        const r = await dbRun(`DELETE FROM dayMarks WHERE deviceID = ? AND day BETWEEN ? AND ?`, [deviceID, from, to || from]);
        res.json({ success: true, count: r.changes });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

function parseRecommendations(row) {
    if (row && row.recommendations && typeof row.recommendations === 'string') {
        try { row.recommendations = JSON.parse(row.recommendations); } catch (e) { /* giữ nguyên chuỗi */ }
    }
    return row;
}

router.get('/', function (req, res, next) {
    const deviceID = sessionDeviceID(req);
    if (deviceID === null) return res.status(401).json({ success: false, error: 'Chưa đăng nhập' });
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    const offset = (page - 1) * limit;

    db.all(
        `SELECT * FROM sleepAnalysisReports WHERE deviceID = ? ORDER BY reportDate DESC`,
        [deviceID],
        (err, rows) => {

            if (err) return res.json({ success: false, error: err.message });
            res.json({ success: true, data: rows })
        }
    )
});


router.get('/re-ai/:sleepStatID', async function (req, res, next) {
    const { sleepStatID } = req.params
    let result = await analysisService.reGenerateAIAnalysis(sleepStatID)
    console.log(result)
    return res.json({ success: true, data: result })

})

router.get('/re-all/:sleepStatID', async function (req, res, next) {
    const { sleepStatID } = req.params
    let result = await analysisService.processNewSleepStatistic(sleepStatID)
    console.log(result)
    return res.json(result)

})

router.get('/last-report', function (req, res, next) {
    const deviceID = sessionDeviceID(req);
    if (deviceID === null) return res.status(401).json({ success: false, error: 'Chưa đăng nhập' });

    // Báo cáo của đêm mới nhất (theo ngày ngủ), không phụ thuộc thời điểm tạo báo cáo
    const sql = `
        SELECT * FROM sleepAnalysisReports
        WHERE deviceID = ?
        ORDER BY reportDate DESC, id DESC LIMIT 1
    `;

    db.get(sql, [deviceID], (err, row) => {
        if (err) return res.json({ success: false, error: err.message });
        if (!row) return res.json({ success: false, error: 'No reports found' });
        return res.json({ success: true, data: [parseRecommendations(row)] });
    });
});

// Danh sách các ngày đã có báo cáo (mới -> cũ) để người dùng chọn xem lại
router.get('/dates', function (req, res, next) {
    const deviceID = sessionDeviceID(req);
    if (deviceID === null) return res.status(401).json({ success: false, error: 'Chưa đăng nhập' });

    const limit = Math.min(Number(req.query.limit) || 400, 1000);
    const sql = `
        SELECT id, sleepStatID, reportDate, totalSleepHours, overallScore, qualityLevel
        FROM sleepAnalysisReports
        WHERE deviceID = ?
        ORDER BY reportDate DESC, id DESC
        LIMIT ?
    `;
    db.all(sql, [deviceID, limit], (err, rows) => {
        if (err) return res.json({ success: false, error: err.message });
        res.json({ success: true, data: rows });
    });
});

router.get('/:sleepStatID', async function (req, res, next) {
    const deviceID = sessionDeviceID(req);
    if (deviceID === null) return res.status(401).json({ success: false, error: 'Chưa đăng nhập' });

    const { sleepStatID } = req.params
    const data = await analysisService.getReport(sleepStatID)
    if (!data || data.deviceID !== deviceID) {
        return res.status(404).json({ success: false, error: 'Không tìm thấy báo cáo' });
    }
    res.json({ success: true, data: parseRecommendations(data) })
})

module.exports = router
