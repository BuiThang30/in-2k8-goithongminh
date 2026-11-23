/**
 * Tạo dữ liệu giấc ngủ ảo (sleepData + sleepStatistic + báo cáo phân tích) để thử giao diện.
 *
 *   node seedFakeSleep.js                         # thiết bị 1, từ 2026-09-01 đến hôm qua
 *   node seedFakeSleep.js --device=2              # thiết bị khác
 *   node seedFakeSleep.js --from=2026-09-01 --to=2026-11-22
 *   node seedFakeSleep.js --clean                 # xóa hết dữ liệu ảo của thiết bị rồi tạo lại
 *   node seedFakeSleep.js --clean --only-clean    # chỉ xóa dữ liệu ảo, không tạo mới
 *
 * - Dữ liệu ảo được đánh dấu type = 'fake_sleep_data' / 'fake_sleep_statistics' nên --clean
 *   chỉ xóa đúng dữ liệu ảo, không đụng dữ liệu thật của gối.
 * - Đêm nào đã có dữ liệu (thật hoặc ảo) thì bỏ qua, nên chạy lại nhiều lần không bị trùng.
 * - Không gọi OpenAI: phần "phân tích AI" được viết sẵn theo số liệu của từng đêm.
 * - Số liệu có cùng đơn vị với gối thật: startTime/endTime tính bằng mili giây,
 *   totalTime và timeLeft/Right/Center tính bằng giây, sleepData.timestamp tính bằng giây.
 */

require('dotenv').config();
const db = require('./db');
const SleepAnalysisService = require('./sleepAnalyzer/sleepAnalysisService');

// ---------- tham số dòng lệnh ----------
const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v === undefined ? true : v];
    })
);

const VN_OFFSET_MS = 7 * 3600 * 1000;            // giờ Việt Nam (UTC+7)
const DAY_MS = 24 * 3600 * 1000;
const deviceID = parseInt(args.device ?? 1, 10);
const stepMin = Math.max(1, parseInt(args.step ?? 10, 10));   // 10 phút / mẫu
const seed = parseInt(args.seed ?? 20260901, 10);

const fmtDate = (ms) => new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10);   // YYYY-MM-DD (giờ VN)
const parseDateVN = (s) => {                       // 00:00 giờ VN của ngày s, tính bằng ms UTC
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d) - VN_OFFSET_MS;
};

const fromMs = parseDateVN(args.from ?? '2026-09-01');
const yesterdayVN = parseDateVN(fmtDate(Date.now())) - DAY_MS;
const toMs = args.to ? parseDateVN(args.to) : yesterdayVN;

// ---------- số ngẫu nhiên có thể lặp lại ----------
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, n = 1) => Number(v.toFixed(n));

// ---------- tiện ích SQLite ----------
const run = (sql, params = []) => new Promise((res, rej) =>
    db.run(sql, params, function (err) { err ? rej(err) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) =>
    db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows))));

const svc = new SleepAnalysisService({ openaiApiKey: 'khong-dung-toi' });

// ---------- sinh dữ liệu một đêm ----------
function buildNight(dayStartMs, rnd) {
    const dayOfWeek = new Date(dayStartMs + VN_OFFSET_MS).getUTCDay();   // 0=CN ... 6=T7
    const weekend = dayOfWeek === 5 || dayOfWeek === 6;                    // đêm thứ 6, thứ 7

    // "chất lượng đêm" 0..1, quyết định giờ ngủ, thời lượng, số lần trở mình, môi trường
    const q = clamp(Math.pow(rnd(), 0.85) * 1.05 - (rnd() < 0.15 ? 0.2 : 0), 0.03, 1);

    // giờ đi ngủ 21:45 -> 23:55
    const startLocalMin = clamp(Math.round(21.75 * 60 + rnd() * 100 + (weekend ? 35 : 0)), 21 * 60 + 45, 23 * 60 + 55);
    const durationH = clamp(5.2 + q * 2.4 + (rnd() - 0.5) * 1.0 + (weekend ? 0.5 : 0), 4.3, 9.6);
    const startMs = dayStartMs + startLocalMin * 60000;
    const durationMs = Math.round(durationH * 3600000);
    const endMs = startMs + durationMs;

    // môi trường của cả đêm
    const bad = 1 - q;                                      // đêm càng tệ thì phòng càng nóng/ồn/ngột
    const base = {
        temp: 20.5 + bad * 7.5 + rnd() * 2,
        hum: 45 + bad * 28 + rnd() * 8,
        co2: 450 + bad * 1200 * rnd() + rnd() * 150,
        pm25: 8 + bad * 45 * rnd() + rnd() * 10,
        light: 0.5 + rnd() * 6,
        noise: 26 + bad * 26 * (0.4 + rnd() * 0.6) + rnd() * 4,
        hr: 54 + bad * 20 + rnd() * 6,
        bodyTemp: 36.3 + rnd() * 0.5,
        spo2: 93.2 + q * 4.6 + rnd() * 0.8,
    };

    const restless = 0.04 + bad * 0.36;                 // xác suất đổi tư thế mỗi mẫu
    const stepMs = stepMin * 60000;
    const samples = [];
    let position = [1, 2, 3][Math.floor(rnd() * 3)];       // 1 giữa, 2 phải, 3 trái
    let changes = 0;
    const secPerSample = stepMin * 60;
    const time = { 1: 0, 2: 0, 3: 0 };

    for (let t = stepMs; t <= durationMs; t += stepMs) {
        const progress = t / durationMs;                    // 0..1
        const dip = Math.sin(Math.PI * progress);           // giữa đêm nhịp tim thấp nhất

        if (rnd() < restless) {
            let next;
            do { next = 1 + Math.floor(rnd() * 3); } while (next === position);
            position = next;
            changes++;
        }
        time[position] += secPerSample;

        const sleepDuration = t;                            // giống gối: giai đoạn tính theo thời gian ngủ
        const stage = sleepDuration <= 7200000 ? 1 : sleepDuration > 7200000 + 14400000 ? 3 : 2;

        const noiseSpike = rnd() < 0.04 ? 8 + rnd() * 10 : 0;
        const light = base.light + (progress > 0.9 ? rnd() * 25 : 0) + rnd() * 1.5;   // sáng sớm có ánh sáng

        samples.push({
            deviceID,
            type: 'fake_sleep_data',
            stage,
            sleepTime: Math.round(t / 1000),
            temperature: round(base.temp + Math.sin(progress * Math.PI) * -0.8 + (rnd() - 0.5) * 0.4, 2),
            humidity: round(clamp(base.hum + (rnd() - 0.5) * 3 + progress * 2, 20, 95), 2),
            co2: Math.round(base.co2 + progress * (200 + rnd() * 150) + (rnd() - 0.5) * 30),
            pm25: Math.round(clamp(base.pm25 + (rnd() - 0.5) * 8, 1, 200)),
            light: round(light, 2),
            noise: round(base.noise + noiseSpike + (rnd() - 0.5) * 3, 2),
            position,
            heartRate: Math.round(base.hr - dip * 7 + (rnd() - 0.5) * 5 + (changes && rnd() < restless ? 6 : 0)),
            bodyTemperature: round(base.bodyTemp - dip * 0.25 + (rnd() - 0.5) * 0.1, 2),
            spo2: Math.round(clamp(base.spo2 - (rnd() < 0.07 ? 2 + rnd() * 2 : 0) + (rnd() - 0.5), 88, 100)),
            timestamp: Math.round((startMs + t) / 1000),
        });
    }

    const totalSec = Math.round(samples.length * secPerSample);
    const stat = {
        deviceID,
        type: 'fake_sleep_statistics',
        startTime: startMs,
        endTime: startMs + samples.length * stepMs,
        totalTime: totalSec,
        totalSleepHours: round(totalSec / 3600, 4),
        isCompleteSleep: totalSec >= 6 * 3600 ? 1 : 0,
        timeLeft: time[3],
        timeRight: time[2],
        timeCenter: time[1],
        positionChanges: changes,
        timestamp: Math.round((startMs + samples.length * stepMs) / 1000),
    };
    return { stat, samples };
}

// ---------- viết phần phân tích (thay cho AI) ----------
function writeAnalysis(stat, m, qm) {
    const hrs = stat.totalSleepHours;
    const level = { excellent: 'xuất sắc', good: 'tốt', fair: 'trung bình', poor: 'kém' }[qm.qualityLevel];
    const lines = [];
    const tips = [];

    lines.push('TỔNG QUAN');
    lines.push(`Bạn ngủ ${hrs.toFixed(1)} giờ, điểm tổng thể ${qm.overallScore}/100, chất lượng giấc ngủ ở mức ${level}.`);
    lines.push('');
    lines.push('PHÂN TÍCH CHI TIẾT');
    lines.push(`- Nhịp tim trung bình ${m.avgHeartRate.toFixed(0)} bpm (thấp nhất ${m.minHeartRate}, cao nhất ${m.maxHeartRate}). SpO2 trung bình ${m.avgSpO2.toFixed(1)}%, thấp nhất ${m.minSpO2}%.`);
    lines.push(`- Bạn đổi tư thế ${stat.positionChanges} lần; nằm giữa ${Math.round(stat.timeCenter / 60)} phút, bên phải ${Math.round(stat.timeRight / 60)} phút, bên trái ${Math.round(stat.timeLeft / 60)} phút.`);
    lines.push(`- Môi trường phòng: ${m.avgEnvTemp.toFixed(1)}°C, độ ẩm ${m.avgHumidity.toFixed(0)}%, CO2 ${m.avgCO2.toFixed(0)} ppm, tiếng ồn ${m.avgNoise.toFixed(0)} dB.`);

    if (hrs < 6) tips.push('Thời gian ngủ còn ngắn (dưới 6 giờ). Hãy đi ngủ sớm hơn 30–60 phút để đủ 7–8 giờ.');
    else if (hrs > 9) tips.push('Bạn ngủ khá dài. Giữ giờ thức dậy cố định mỗi ngày để cơ thể ổn định nhịp sinh học.');
    if (stat.positionChanges >= 15) tips.push('Bạn trở mình nhiều, giấc ngủ chưa sâu. Hạn chế caffeine sau 14h và tránh ăn no sát giờ ngủ.');
    if (m.avgEnvTemp > 26) tips.push('Phòng hơi nóng. Nên giữ nhiệt độ khoảng 24–26°C và dùng chăn gối thoáng mát.');
    else if (m.avgEnvTemp < 20) tips.push('Phòng hơi lạnh. Giữ ấm cơ thể và đặt nhiệt độ phòng quanh 22–25°C.');
    if (m.avgHumidity > 70) tips.push('Độ ẩm cao. Dùng máy hút ẩm hoặc điều hòa chế độ khô để phòng thoáng hơn.');
    if (m.avgCO2 > 1000) tips.push('Nồng độ CO2 cao, phòng ngột ngạt. Mở cửa thông gió trước khi ngủ vài phút.');
    if (m.avgNoise > 38) tips.push('Phòng khá ồn. Dùng nút tai hoặc đóng cửa sổ để giảm tiếng ồn.');
    if (m.avgPM25 > 35) tips.push('Bụi mịn trong phòng cao. Nên lau dọn thường xuyên hoặc dùng máy lọc không khí.');
    if (m.minSpO2 < 93) tips.push('SpO2 có lúc xuống thấp. Nếu lặp lại nhiều đêm, hãy trao đổi với bác sĩ.');
    if (m.avgHeartRate > 70) tips.push('Nhịp tim lúc ngủ hơi cao. Thư giãn, tắm nước ấm và tránh dùng điện thoại trước khi ngủ.');
    if (!tips.length) tips.push('Giấc ngủ rất tốt. Hãy duy trì giờ giấc đều đặn và môi trường phòng như hiện tại.');
    if (tips.length < 3) tips.push('Duy trì giờ đi ngủ và thức dậy cố định, kể cả cuối tuần.');

    lines.push('');
    lines.push('ĐỀ XUẤT CẢI THIỆN');
    tips.slice(0, 5).forEach((t, i) => lines.push(`${i + 1}. ${t}`));
    lines.push('');
    lines.push('KẾT LUẬN');
    lines.push(qm.overallScore >= 80
        ? 'Đêm qua bạn ngủ rất tốt, tiếp tục giữ thói quen hiện tại.'
        : qm.overallScore >= 65
            ? 'Đêm qua bạn ngủ tạm ổn, còn một vài điểm có thể làm tốt hơn ở phần đề xuất.'
            : 'Giấc ngủ chưa thật sự trọn vẹn, hãy thử các gợi ý ở trên trong vài đêm tới.');
    return lines.join('\n');
}

// ---------- chạy ----------
(async () => {
    try {
        // đảm bảo có bảng (db/init.js chưa chạy thì tạo)
        await new Promise((r) => setTimeout(r, 300));

        if (args.clean) {
            const fakeStats = await all(`SELECT id FROM sleepStatistic WHERE deviceID = ? AND type = 'fake_sleep_statistics'`, [deviceID]);
            const ids = fakeStats.map((r) => r.id);
            await run('BEGIN');
            if (ids.length) {
                const ph = ids.map(() => '?').join(',');
                await run(`DELETE FROM sleepAnalysisReports WHERE sleepStatID IN (${ph})`, ids);
                await run(`DELETE FROM analysisTriggers WHERE sleepStatID IN (${ph})`, ids);
            }
            await run(`DELETE FROM sleepStatistic WHERE deviceID = ? AND type = 'fake_sleep_statistics'`, [deviceID]);
            await run(`DELETE FROM sleepData WHERE deviceID = ? AND type = 'fake_sleep_data'`, [deviceID]);
            await run('COMMIT');
            console.log(`Đã xóa dữ liệu ảo của thiết bị ${deviceID} (${ids.length} đêm).`);
            if (args['only-clean']) return;
        }

        let nights = 0, skipped = 0, rows = 0, scoreSum = 0;
        await run('BEGIN');
        for (let day = fromMs; day <= toMs; day += DAY_MS) {
            // cửa sổ của một đêm: 12:00 hôm đó -> 12:00 hôm sau
            const exists = await all(
                `SELECT id FROM sleepStatistic WHERE deviceID = ? AND startTime BETWEEN ? AND ?`,
                [deviceID, day + 12 * 3600000, day + 36 * 3600000 - 1]
            );
            if (exists.length) { skipped++; continue; }

            const rnd = mulberry32(seed + Math.round(day / DAY_MS));
            const { stat, samples } = buildNight(day, rnd);

            for (const s of samples) {
                await run(
                    `INSERT INTO sleepData (deviceID, type, stage, sleepTime, temperature, humidity, co2, pm25, light, noise,
                                            position, heartRate, bodyTemperature, spo2, timestamp)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [s.deviceID, s.type, s.stage, s.sleepTime, s.temperature, s.humidity, s.co2, s.pm25, s.light,
                     s.noise, s.position, s.heartRate, s.bodyTemperature, s.spo2, s.timestamp]
                );
            }
            rows += samples.length;

            const r = await run(
                `INSERT INTO sleepStatistic (deviceID, type, startTime, endTime, totalTime, totalSleepHours, isCompleteSleep,
                                             timeLeft, timeRight, timeCenter, positionChanges, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [stat.deviceID, stat.type, stat.startTime, stat.endTime, stat.totalTime, stat.totalSleepHours,
                 stat.isCompleteSleep, stat.timeLeft, stat.timeRight, stat.timeCenter, stat.positionChanges, stat.timestamp]
            );
            stat.id = r.lastID;

            // báo cáo phân tích: dùng đúng công thức tính điểm của hệ thống
            const metrics = await svc.calculateSleepMetrics(samples);
            const quality = svc.calculateQualityMetrics(stat, metrics);
            const aiAnalysis = writeAnalysis(stat, metrics, quality);

            await svc.saveAnalysisReport({
                deviceID, sleepStatID: stat.id, sleepStat: stat,
                calculatedMetrics: metrics, qualityMetrics: quality, aiAnalysis,
            });
            await run(
                `INSERT INTO analysisTriggers (sleepStatID, triggerType, status, startedAt, completedAt)
                 VALUES (?, 'scheduled', 'completed', ?, ?)`,
                [stat.id, stat.endTime, stat.endTime]
            );

            nights++;
            scoreSum += quality.overallScore;
        }
        await run('COMMIT');

        console.log(`Thiết bị ${deviceID}: ${fmtDate(fromMs)} -> ${fmtDate(toMs)}`);
        console.log(`  Đã tạo ${nights} đêm (${rows} mẫu sleepData), bỏ qua ${skipped} đêm đã có dữ liệu.`);
        if (nights) console.log(`  Điểm tổng thể trung bình: ${(scoreSum / nights).toFixed(1)}`);
    } catch (err) {
        console.error('Lỗi:', err);
        try { await run('ROLLBACK'); } catch (e) { /* chưa mở giao dịch */ }
        process.exitCode = 1;
    } finally {
        db.close();
    }
})();
