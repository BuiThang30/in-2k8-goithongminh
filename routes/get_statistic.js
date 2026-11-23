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
