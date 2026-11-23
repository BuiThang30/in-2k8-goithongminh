/**************************************
 DEVICE ID
**************************************/
function getDeviceID() {
    return localStorage.getItem("deviceID");
}

/**************************************
 * 1) Generic API Fetcher 
 **************************************/
async function fetchData(endpoint, params = {}) {
    const query = new URLSearchParams(params).toString();
    const url = query ? `${endpoint}?${query}` : endpoint;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Network error");
        return await res.json();
    } catch (err) {
        console.error("Fetch error:", err);
        return [];
    }
}

/**************************************
 * 2) Chuẩn hóa dữ liệu cho Chart.js
 * fields = { x: 'timestamp', y: 'temperature' }
 **************************************/
function prepareChartData(data, fields) {
    return data
        .filter(item => item[fields.x] && item[fields.y] !== null)
        .map(item => ({
            x: item[fields.x] * 1000,     // convert UNIX seconds
            y: item[fields.y]
        }));
}

/**************************************
 * 3) Hàm vẽ line chart
 **************************************/
function renderLineChart(canvasId, chartData, options = {}) {
    const ctx = document.getElementById(canvasId).getContext('2d');

    // Destroy chart cũ (Chart.js yêu cầu)
    if (window._charts === undefined) window._charts = {};
    if (window._charts[canvasId]) window._charts[canvasId].destroy();

    const chart = new Chart(ctx, {
        type: "line",
        data: {
            labels: chartData.map((each => each.x)),
            datasets: [{
                label: options.label || "Dataset",
                data: chartData.map((each => each.y)),
                borderWidth: 2,
                tension: 0.25,     // đường cong nhẹ
                pointRadius: 2,
                fill: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'time',
                    time: { unit: options.timeUnit || "hour" },
                    display: true
                },
                y: {
                    display: true,
                    beginAtZero: false
                }
            }
        }
    });

    window._charts[canvasId] = chart;
}

function getNotice(value, type) {
    const config = {
        temperature: {
            min: 23,
            max: 28,
            threshold: 2,
            messages: {
                comfortable: "Comfortable",
                slightlyLow: "Slightly below normal",
                slightlyHigh: "Slightly above normal",
                tooLow: "Too cold",
                tooHigh: "Too hot",
            },
        },
        light: {
            min: 0,
            max: 3,
            threshold: 2,
            messages: {
                comfortable: "Low risk",
                slightlyHigh: "Moderate - Consider protection",
                tooHigh: "High - Use protection",
            },
        },
        co2: {
            min: 0,
            max: 50,
            threshold: 50,
            messages: {
                comfortable: "Good air quality",
                slightlyHigh: "Moderate",
                tooHigh: "Unhealthy for sensitive groups",
            },
        },
        humidity: {
            min: 40,
            max: 60,
            threshold: 10,
            messages: {
                comfortable: "Comfortable humidity",
                slightlyLow: "Slightly dry",
                tooLow: "Too dry - Use humidifier",
                slightlyHigh: "Slightly humid",
                tooHigh: "Too humid - Risk of mold",
            },
        },
        pm25: {
            min: 0,
            max: 35,
            threshold: 15,
            messages: {
                comfortable: "Good air quality",
                slightlyHigh: "Moderate pollution",
                tooHigh: "Unhealthy air - Wear mask",
            },
        },
        heartRate: {
            min: 60,
            max: 100,
            threshold: 20,
            messages: {
                comfortable: "Normal heart rate",
                slightlyLow: "Slightly low HR",
                tooLow: "Bradycardia - Too low",
                slightlyHigh: "Slightly high HR",
                tooHigh: "Tachycardia - Too high",
            },
        },
        spo2: {
            min: 92,
            max: 100,
            threshold: 2,
            messages: {
                comfortable: "Oxygen level normal",
                slightlyLow: "Slightly low oxygen",
                tooLow: "Low oxygen - Check health",
            },
        },
        bodyTemperature: {
            min: 36,
            max: 37.5,
            threshold: 0.5,
            messages: {
                comfortable: "Normal body temp",
                slightlyLow: "Slightly below normal",
                tooLow: "Hypothermia risk",
                slightlyHigh: "Slightly elevated",
                tooHigh: "Fever detected",
            },
        },
    };

    const setting = config[type];
    if (!setting) return "Unknown";

    const { min, max, threshold, messages } = setting;

    if (value >= min && value <= max) {
        return messages.comfortable || "Normal";
    } else if (value < min) {
        const diff = min - value;
        if (diff <= threshold) return messages.slightlyLow || "Slightly low";
        else return messages.tooLow || "Too low";
    } else {
        const diff = value - max;
        if (diff <= threshold)
            return messages.slightlyHigh || "Slightly high";
        else return messages.tooHigh || "Too high";
    }
}


async function loadChart() {
    // gọi API: GET /sleep-data?deviceID=1
    const rawData = await fetchData("/api/sleep-data", { deviceID: getDeviceID() });
    if (rawData.success == false) {
        console.log(rawData.error);
        return;
    }

    const chartIDs = ["tempChart", "humidChart", "co2Chart", "pm25Chart", "heartRateChart", "oxygenChart", "healthTempChart", "lightChart", "noiseChart"]
    const chartdataType = ["temperature", "humidity", "co2", "pm25", "heartRate", "spo2", "bodyTemperature", "light", "noise"]
    const chartLabel = ["Temperature (°C)", "Humidity(%)", "CO2", "PM25 (ug/m3)", "Heart Rate (BPM)", "SpO2 (%)", "Body Temperature (°C)", "Light", "Noise"]


    for (let i = 0; i < chartIDs.length; i++) {
        const data = prepareChartData(rawData.data, { x: "timestamp", y: chartdataType[i] })

        renderLineChart(chartIDs[i], data, { label: chartLabel[i], timeUnit: "hour" })
    }
}

// chạy sau khi trang load
loadChart();

/**************************************
 * 4) Sleep Analysis Modal Functions
 **************************************/

// Danh sách ngày đã có báo cáo (mới -> cũ)
let reportList = [];      // [{sleepStatID, reportDate, overallScore, qualityLevel, ...}]
let reportIndex = 0;      // vị trí đang xem trong reportList
let reportReqToken = 0;   // bỏ kết quả cũ nếu người dùng bấm chuyển ngày nhanh

async function fetchJSON(url) {
    try {
        const res = await fetch(url, { credentials: "include" });
        if (res.status === 401) { window.location.href = "/login"; return { success: false, error: "Chưa đăng nhập" }; }
        if (!res.ok) throw new Error("Network error");
        return await res.json();
    } catch (err) {
        console.error("Fetch error:", url, err);
        return { success: false, error: err.message };
    }
}

// Fetch last report data
function fetchLastReport() {
    return fetchJSON("/statistic/last-report");
}

// Format date from YYYY-MM-DD or timestamp
function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    return date.toLocaleDateString('vi-VN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

// Format quality level to Vietnamese
function formatQualityLevel(level) {
    const levels = {
        'excellent': 'Xuất sắc',
        'good': 'Tốt',
        'fair': 'Trung bình',
        'poor': 'Kém'
    };
    return levels[level] || level;
}

// Populate modal with report data
function populateModal(report) {
    // Report date
    document.getElementById('reportDate').textContent = formatDate(report.reportDate);

    // Scores
    document.getElementById('overallScore').textContent = report.overallScore || '-';
    document.getElementById('physiologyScore').textContent = report.physiologyScore || '-';
    document.getElementById('environmentScore').textContent = report.environmentScore || '-';
    document.getElementById('qualityLevel').textContent = formatQualityLevel(report.qualityLevel);

    // Sleep metrics
    document.getElementById('totalSleepHours').textContent =
        report.totalSleepHours ? Number(report.totalSleepHours).toFixed(1) : '-';
    document.getElementById('sleepEfficiency').textContent = report.sleepEfficiency || '-';
    document.getElementById('deepSleepPercent').textContent =
        report.deepSleepPercent ? report.deepSleepPercent.toFixed(1) : '-';
    document.getElementById('positionChanges').textContent = report.positionChanges || '-';

    // Health metrics
    document.getElementById('avgHeartRate').textContent =
        report.avgHeartRate ? report.avgHeartRate.toFixed(1) : '-';
    document.getElementById('avgSpO2').textContent =
        report.avgSpO2 ? report.avgSpO2.toFixed(1) : '-';
    document.getElementById('avgBodyTemp').textContent =
        report.avgBodyTemp ? report.avgBodyTemp.toFixed(1) : '-';

    // AI Analysis
    document.getElementById('aiAnalysis').textContent = report.aiAnalysis || 'Không có phân tích';

    // Recommendations
    const recommendationsList = document.getElementById('recommendations');
    recommendationsList.innerHTML = '';

    if (report.recommendations && Array.isArray(report.recommendations)) {
        report.recommendations.forEach(rec => {
            const li = document.createElement('li');
            li.className = 'flex items-start gap-2 bg-white rounded-lg p-3';
            li.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                </svg>
                <span class="text-sm text-gray-700">${rec}</span>
            `;
            recommendationsList.appendChild(li);
        });
    } else {
        recommendationsList.innerHTML = '<li class="text-sm text-gray-500 bg-white rounded-lg p-3">Không có khuyến nghị</li>';
    }
}

// Show modal states
function showLoadingState() {
    document.getElementById('loadingState').classList.remove('hidden');
    document.getElementById('errorState').classList.add('hidden');
    document.getElementById('contentState').classList.add('hidden');
}

function showErrorState(message) {
    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('errorState').classList.remove('hidden');
    document.getElementById('contentState').classList.add('hidden');
    document.getElementById('errorMessage').textContent = message || 'Không thể tải dữ liệu';
}

function showContentState() {
    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('errorState').classList.add('hidden');
    document.getElementById('contentState').classList.remove('hidden');
}

// ===== Chọn ngày báo cáo =====
function dateLabel(r) {
    const score = r.overallScore != null ? ` - ${Math.round(r.overallScore)} điểm` : '';
    return `${formatDate(r.reportDate)}${score}`;
}

function renderReportNav() {
    const nav = document.getElementById('reportNav');
    const select = document.getElementById('reportDateSelect');
    if (!reportList.length) { nav.classList.add('hidden'); return; }
    nav.classList.remove('hidden');

    // gom theo tháng cho dễ tìm
    select.innerHTML = '';
    let group = null, groupKey = '';
    reportList.forEach((r, i) => {
        const key = String(r.reportDate).slice(0, 7);
        if (key !== groupKey) {
            groupKey = key;
            group = document.createElement('optgroup');
            const [y, m] = key.split('-');
            group.label = `Tháng ${parseInt(m, 10)}/${y}`;
            select.appendChild(group);
        }
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = dateLabel(r);
        group.appendChild(opt);
    });
    syncReportNav();
}

function syncReportNav() {
    document.getElementById('reportDateSelect').value = String(reportIndex);
    // index 0 = mới nhất; "Ngày trước" đi tới index lớn hơn
    document.getElementById('reportPrev').disabled = reportIndex >= reportList.length - 1;
    document.getElementById('reportNext').disabled = reportIndex <= 0;
    document.getElementById('reportLatest').disabled = reportIndex === 0;
}

async function showReportAt(index) {
    if (index < 0 || index >= reportList.length) return;
    reportIndex = index;
    syncReportNav();
    const token = ++reportReqToken;
    showLoadingState();

    const result = await fetchJSON(`/statistic/${reportList[index].sleepStatID}`);
    if (token !== reportReqToken) return;   // đã chuyển sang ngày khác

    if (result.success && result.data) {
        populateModal(result.data);
        showContentState();
        document.querySelector('#analysisModal .overflow-y-auto').scrollTop = 0;
    } else {
        showErrorState(result.error || 'Không tìm thấy báo cáo');
    }
}

// Open modal and load data
async function openAnalysisModal() {
    const modal = document.getElementById('analysisModal');
    modal.classList.remove('hidden');
    showLoadingState();

    const list = await fetchJSON('/statistic/dates');
    reportList = (list.success && Array.isArray(list.data)) ? list.data : [];

    if (reportList.length) {
        renderReportNav();
        await showReportAt(0);          // mặc định: đêm gần nhất
        return;
    }

    // Không lấy được danh sách ngày: thử lấy báo cáo mới nhất như trước
    document.getElementById('reportNav').classList.add('hidden');
    const result = await fetchLastReport();
    if (result.success && result.data && result.data.length > 0) {
        populateModal(result.data[0]);
        showContentState();
    } else {
        showErrorState(result.error || 'Không tìm thấy báo cáo');
    }
}

// Close modal
function closeAnalysisModal() {
    const modal = document.getElementById('analysisModal');
    modal.classList.add('hidden');
}

async function openThresholdMoal() {
    const modal = document.getElementById('thresholdModal');
    modal.classList.remove('hidden');

    // Load current thresholds
    await loadCurrentThresholds();
}

// Event listeners for modal
document.addEventListener('DOMContentLoaded', function () {
    const analysisBtn = document.getElementById('analysisBtn');
    const closeModalBtn = document.getElementById('closeModal');
    const modal = document.getElementById('analysisModal');
    const settingThresholdBtn = document.getElementById("settingThresholdBtn");

    // Chuyển ngày báo cáo
    const prevBtn = document.getElementById('reportPrev');
    const nextBtn = document.getElementById('reportNext');
    const latestBtn = document.getElementById('reportLatest');
    const dateSelect = document.getElementById('reportDateSelect');
    if (prevBtn) prevBtn.addEventListener('click', () => showReportAt(reportIndex + 1));
    if (nextBtn) nextBtn.addEventListener('click', () => showReportAt(reportIndex - 1));
    if (latestBtn) latestBtn.addEventListener('click', () => showReportAt(0));
    if (dateSelect) dateSelect.addEventListener('change', () => showReportAt(parseInt(dateSelect.value, 10)));

    // Open modal on button click
    if (analysisBtn) {
        analysisBtn.addEventListener('click', openAnalysisModal);
    }

    // Close modal on close button click
    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', closeAnalysisModal);
    }

    // Close modal on overlay click
    if (modal) {
        modal.addEventListener('click', function (e) {
            if (e.target === modal) {
                closeAnalysisModal();
            }
        });
    }

    if (settingThresholdBtn) {
        settingThresholdBtn.addEventListener('click', async function (e) {
            await openThresholdMoal();
        })
    }

    // Threshold modal event listeners
    const closeThresholdModalBtn = document.getElementById('closeThresholdModal');
    const cancelThresholdBtn = document.getElementById('cancelThresholdBtn');
    const saveThresholdBtn = document.getElementById('saveThresholdBtn');
    const thresholdModal = document.getElementById('thresholdModal');

    if (closeThresholdModalBtn) {
        closeThresholdModalBtn.addEventListener('click', closeThresholdModal);
    }

    if (cancelThresholdBtn) {
        cancelThresholdBtn.addEventListener('click', closeThresholdModal);
    }

    if (saveThresholdBtn) {
        saveThresholdBtn.addEventListener('click', saveThresholds);
    }

    if (thresholdModal) {
        thresholdModal.addEventListener('click', function (e) {
            if (e.target === thresholdModal) {
                closeThresholdModal();
            }
        });
    }


    // Close modal on Escape key; ← → để chuyển ngày khi đang xem báo cáo
    document.addEventListener('keydown', function (e) {
        const open = modal && !modal.classList.contains('hidden');
        if (open && e.key === 'ArrowLeft' && document.activeElement !== dateSelect) showReportAt(reportIndex + 1);
        if (open && e.key === 'ArrowRight' && document.activeElement !== dateSelect) showReportAt(reportIndex - 1);
        if (e.key === 'Escape') {
            closeAnalysisModal();
            closeThresholdModal();
        }
    });
});


/**************************************
 * 5) Threshold Modal Functions
 **************************************/

// Load current threshold values from API
async function loadCurrentThresholds() {
    try {
        const result = await fetchData('/api/thresholds', { deviceID: getDeviceID() });
        if (result.success && result.data && result.data.length > 0) {
            const thresholds = result.data[0];
            document.getElementById('tempThreshold').value = thresholds.temp || '';
            document.getElementById('humidThreshold').value = thresholds.humid || '';
            document.getElementById('pm25Threshold').value = thresholds.pm25 || '';
            document.getElementById('co2Threshold').value = thresholds.co2 || '';
            document.getElementById('noiseThreshold').value = thresholds.noise || '';
            document.getElementById('lightThreshold').value = thresholds.light || '';
        }
    } catch (error) {
        console.error('Error loading thresholds:', error);
    }
}

// Save threshold values
async function saveThresholds() {
    const formData = new FormData(document.getElementById('thresholdForm'));
    const thresholds = {
        deviceID: getDeviceID(),
        temp: parseFloat(formData.get('temp')) || 30.0,
        humid: parseFloat(formData.get('humid')) || 70.0,
        pm25: parseFloat(formData.get('pm25')) || 50.0,
        co2: parseFloat(formData.get('co2')) || 1000.0,
        noise: parseFloat(formData.get('noise')) || 50.0,
        light: parseFloat(formData.get('light')) || 300.0
    };

    try {
        const response = await fetch('/api/thresholds/upsert', {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(thresholds)
        })

        const res = await response.json();
        if (res.success) {
            alert('Ngưỡng đã được lưu!');
            closeThresholdModal();
        } else {
            alert('Có lỗi xảy ra khi lưu ngưỡng: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error saving thresholds:', error);
        alert('Có lỗi xảy ra khi lưu ngưỡng');
    }
}

// Close threshold modal
function closeThresholdModal() {
    const modal = document.getElementById('thresholdModal');
    modal.classList.add('hidden');
}


/* =====================================================
 * POPUP ĐIỀU KHIỂN GỐI (giống web nội bộ của gối)
 *  - Gửi lệnh:  POST /control            (server xếp hàng, gối hỏi mỗi ~1s)
 *  - Đọc trạng thái thật của gối: GET /control/state
 * ===================================================== */
(function initControlPanel() {
  const $ = (id) => document.getElementById(id);
  const modal = $("controlModal");
  const openBtn = $("controlBtn");
  if (!modal || !openBtn) return;

  const POLL_MS = 1500;
  let pollTimer = null;
  let firstSync = true;              // true: lần đồng bộ kế tiếp phải ghi đè toàn bộ giao diện
  let online = false;                // gối có đang kết nối với server không
  let touchedAt = 0;                 // lần cuối người dùng chạm vào thanh gạt
  const touch = () => { touchedAt = Date.now(); };
  const recentlyTouched = () => Date.now() - touchedAt < 2500;

  // ---------- gọi API ----------
  async function post(body) {
    if (!online) throw new Error("offline");
    const res = await fetch("/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { window.location.href = "/login"; throw new Error("401"); }
    if (res.status === 409) { setOnline(false); throw new Error("offline"); }
    if (!res.ok) throw new Error(res.status);
    return res.json();
  }

  // Chỉ 1 request đang chạy, luôn gửi giá trị mới nhất (tránh dồn lệnh khi kéo thanh gạt)
  function sender(build) {
    let busy = false, dirty = false;
    async function go() {
      if (busy) { dirty = true; return; }
      busy = true; dirty = false;
      try { await post(build()); } catch (e) { console.error("Gửi lệnh lỗi:", e); }
      busy = false;
      if (dirty) setTimeout(go, 30);
    }
    return go;
  }

  // ---------- hiển thị ----------
  function paint(el) {
    const mn = +el.min, mx = +el.max, p = ((+el.value - mn) / (mx - mn)) * 100;
    const c = el.dataset.c || "#3A59D1";
    el.style.setProperty("--c", c);
    el.style.setProperty("--fill", `linear-gradient(to right, ${c} ${p}%, #dbe3ee ${p}%)`);
  }

  // on = true/false; checking = đang hỏi lần đầu (chưa biết gối online hay chưa)
  function setOnline(on, checking = false) {
    const was = online;
    online = on;
    $("pcDot").className = "pc-dot" + (on ? " on" : "");
    $("pcConn").textContent = on ? "Gối đã kết nối" : checking ? "Đang kiểm tra..." : "Gối chưa kết nối";
    $("pcOfflineNote").hidden = on || checking;

    // chưa kết nối: xám + khóa toàn bộ điều khiển
    modal.querySelector(".pc-body").classList.toggle("is-off", !on);
    modal.querySelectorAll(".pc-card button, .pc-card input").forEach((el) => { el.disabled = !on; });

    // vừa kết nối (lại): lấy trạng thái thật của gối đè lên giao diện
    if (on && !was) firstSync = true;
  }

  // ---------- MASSAGE & NHIỆT ----------
  const mv = [0, 0];
  const mEl = [$("pcMA"), $("pcMB")];
  const mLab = [$("pcVA"), $("pcVB")];
  const pushMotors = sender(() => ({ t: "motor", a: mv[0], b: mv[1] }));

  function showMotor(i) {
    mLab[i].textContent = mv[i] === 0 ? "Tắt" : mv[i] + "%";
    mLab[i].className = "pc-val " + (mv[i] > 0 ? (i ? "ht" : "fw") : "");
    mEl[i].value = mv[i];
    paint(mEl[i]);
  }
  // nút % nhanh: sáng lên khi massage và nhiệt đang cùng đúng mức đó
  function showPresets() {
    Array.from($("pcPresets").children).forEach((b) => {
      b.classList.toggle("sel", mv[0] > 0 && mv[0] === mv[1] && +b.dataset.p === mv[0]);
    });
  }
  function setMotor(i, v) { mv[i] = v; showMotor(i); showPresets(); }

  mEl.forEach((el, i) => {
    el.addEventListener("input", () => { touch(); setMotor(i, +el.value); pushMotors(); });
    el.addEventListener("change", () => {          // thả tay: gần 0 thì về 0 hẳn
      if (mv[i] > 0 && mv[i] <= 5) { setMotor(i, 0); pushMotors(); }
    });
  });

  $("pcPresets").addEventListener("click", (e) => {
    const p = e.target.dataset.p;
    if (p === undefined) return;
    touch();
    setMotor(0, +p); setMotor(1, +p);
    pushMotors();
  });

  // "Tắt massage & nhiệt": chỉ tắt 2 động cơ, nhạc giữ nguyên
  $("pcStopAll").addEventListener("click", () => {
    touch();
    setMotor(0, 0); setMotor(1, 0);
    post({ t: "mstop" }).catch(() => {});
  });

  // "TẮT TẤT CẢ": massage + nhiệt + nhạc
  $("pcAllOff").addEventListener("click", () => {
    touch();
    setMotor(0, 0); setMotor(1, 0);
    post({ t: "alloff" }).catch(() => {});
  });

  // ---------- NHẠC ----------
  const trackEl = $("pcTrack");
  function track() {
    let t = parseInt(trackEl.value, 10);
    if (Number.isNaN(t) || t < 1) t = 1;
    if (t > 3000) t = 3000;
    trackEl.value = t;
    return t;
  }
  $("pcTrackMinus").onclick = () => { trackEl.value = track() - 1; track(); };
  $("pcTrackPlus").onclick = () => { trackEl.value = track() + 1; track(); };
  trackEl.addEventListener("change", track);
  trackEl.addEventListener("input", touch);
  $("pcPlay").onclick = () => post({ t: "play", track: track() }).catch(() => {});
  $("pcPause").onclick = () => post({ t: "pause" }).catch(() => {});
  $("pcStopMusic").onclick = () => post({ t: "stop" }).catch(() => {});

  let vol = 15;
  const volEl = $("pcVol");
  const pushVol = sender(() => ({ t: "vol", volume: vol }));
  function showVol() { $("pcVVol").textContent = vol; volEl.value = vol; paint(volEl); }
  volEl.addEventListener("input", () => { touch(); vol = +volEl.value; showVol(); pushVol(); });

  // ---------- HẸN GIỜ ----------
  const tmrEl = $("pcTimer");
  function fmtT(m) {
    if (m === 0) return "Không hẹn";
    if (m < 60) return m + " phút";
    return Math.floor(m / 60) + " giờ" + (m % 60 ? " " + (m % 60) + " phút" : "");
  }
  function showTimer(m) {
    tmrEl.value = Math.min(m, +tmrEl.max);
    paint(tmrEl);
    $("pcVTimer").textContent = fmtT(m);
    Array.from($("pcTimerChips").children).forEach((b) => {
      b.classList.toggle("sel", m > 0 && +b.dataset.t === m);
    });
  }
  const sendTimer = (m) => post({ t: "timer", minutes: m }).catch(() => {});
  tmrEl.addEventListener("input", () => { touch(); showTimer(+tmrEl.value); });
  tmrEl.addEventListener("change", () => sendTimer(+tmrEl.value));
  $("pcTimerChips").addEventListener("click", (e) => {
    const t = e.target.dataset.t;
    if (t === undefined) return;
    touch(); showTimer(+t); sendTimer(+t);
  });

  // ---------- ĐỒNG BỘ TRẠNG THÁI TỪ GỐI ----------
  async function poll() {
    try {
      const res = await fetch("/control/state");
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) throw new Error(res.status);
      const d = await res.json();
      setOnline(d.online);

      if (firstSync || !recentlyTouched()) {
        setMotor(0, d.a); setMotor(1, d.b);
        vol = d.volume; showVol();
        showTimer(d.timer || 0);
        if (firstSync) trackEl.value = d.track;
        if (d.online) firstSync = false;   // gối chưa kết nối thì lần sau vẫn đồng bộ lại
      }

      $("pcCountdown").textContent = "";
      if (d.online && d.timerActive && d.remain > 0) {
        const m = Math.floor(d.remain / 60), s = d.remain % 60;
        $("pcCountdown").textContent = `Còn lại ${m}:${s < 10 ? "0" : ""}${s}`;
      }
    } catch (e) {
      setOnline(false);
    }
  }

  // ---------- mở / đóng ----------
  openBtn.onclick = () => {
    modal.classList.add("active");
    firstSync = true;
    setOnline(false, true);            // chờ kết quả hỏi đầu tiên: xám + "Đang kiểm tra..."
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  };
  function closePanel() {
    modal.classList.remove("active");
    clearInterval(pollTimer);
    pollTimer = null;
  }
  $("closeControl").onclick = closePanel;
  modal.addEventListener("click", (e) => { if (e.target === modal) closePanel(); });

  showMotor(0); showMotor(1); showVol(); showTimer(0);
})();


/* =====================================================
 * THẺ "TRẠNG THÁI GỐI" Ở TRANG CHÍNH
 *  Gối báo trạng thái lên server mỗi ~1 giây (bài đang phát, âm lượng,
 *  tốc độ massage, mức nhiệt, hẹn giờ); trang này đọc lại qua GET /control/state.
 * ===================================================== */
(function initPillowStatus() {
  const card = document.getElementById("psCard");
  if (!card) return;
  const $ = (id) => document.getElementById(id);

  // Module DFPlayer chỉ biết SỐ bài. Muốn hiện tên bài thì điền vào đây, ví dụ:
  //   const TRACK_NAMES = { 1: "Tiếng mưa", 2: "Nhạc piano", 3: "Sóng biển" };
  const TRACK_NAMES = {};

  const POLL_MS = 2000;
  let last = null;          // dữ liệu /control/state gần nhất
  let fetchedAt = 0;        // thời điểm nhận dữ liệu đó (để đếm ngược mượt mỗi giây)

  const trackLabel = (n) => (TRACK_NAMES[n] ? `Bài ${n} · ${TRACK_NAMES[n]}` : `Bài ${n}`);
  const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  function fmtTimerSet(m) {
    if (m < 60) return `${m} phút`;
    return `${Math.floor(m / 60)} giờ` + (m % 60 ? ` ${m % 60} phút` : "");
  }
  function fmtAgo(s) {
    if (s < 5) return "vừa xong";
    if (s < 60) return `${s} giây trước`;
    if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
    return `${Math.floor(s / 3600)} giờ trước`;
  }

  function render() {
    const d = last;
    const online = !!(d && d.online);
    const seen = !!(d && d.ago !== null);

    card.classList.toggle("is-off", !online);
    $("psConn").textContent = !d ? "Đang kiểm tra..." : online ? "Gối đã kết nối" : "Gối chưa kết nối";

    if (!seen) {      // chưa từng nhận dữ liệu từ gối -> không có gì để hiển thị
      ["psMusicVal", "psMassageVal", "psHeatVal", "psTimerVal"].forEach((id) => { $(id).textContent = "—"; });
      ["psMusicSub", "psTimerSub"].forEach((id) => { $(id).textContent = "\u00a0"; $(id).className = "ps-sub"; });
      $("psMassageBar").style.width = "0%";
      $("psHeatBar").style.width = "0%";
      $("psAuto").hidden = true;
      $("psFoot").textContent = d ? "Chưa nhận được dữ liệu nào từ gối." : "";
      return;
    }

    // Nhạc
    const musicSub = $("psMusicSub");
    if (d.playing) {
      $("psMusicVal").textContent = trackLabel(d.track);
      musicSub.textContent = (online ? "" : "Lần cuối: ") + `Đang phát · âm lượng ${d.volume}/30`;
      musicSub.className = online ? "ps-sub on" : "ps-sub";
    } else {
      $("psMusicVal").textContent = "Không phát";
      musicSub.textContent = `Bài gần nhất: ${d.track} · âm lượng ${d.volume}/30`;
      musicSub.className = "ps-sub";
    }
    $("psAuto").hidden = !(d.playing && d.auto);

    // Massage & nhiệt (0-100%)
    $("psMassageVal").textContent = d.a > 0 ? `${d.a}%` : "Tắt";
    $("psMassageBar").style.width = `${d.a}%`;
    $("psHeatVal").textContent = d.b > 0 ? `${d.b}%` : "Tắt";
    $("psHeatBar").style.width = `${d.b}%`;

    // Hẹn giờ (đếm ngược mỗi giây giữa hai lần hỏi server)
    const remain = d.timerActive ? Math.max(0, d.remain - Math.floor((Date.now() - fetchedAt) / 1000)) : 0;
    if (d.timerActive && remain > 0) {
      $("psTimerVal").textContent = fmtClock(remain);
      $("psTimerSub").textContent = `Hẹn ${fmtTimerSet(d.timer)} · hết giờ tắt tất cả`;
      $("psTimerSub").className = "ps-sub on";
    } else {
      $("psTimerVal").textContent = "Không hẹn";
      $("psTimerSub").textContent = "Chưa đặt hẹn giờ";
      $("psTimerSub").className = "ps-sub";
    }

    $("psFoot").textContent = online
      ? ""
      : `Gối mất kết nối ${fmtAgo(d.ago + Math.floor((Date.now() - fetchedAt) / 1000))} — đang hiển thị trạng thái cuối cùng.`;
  }

  async function poll() {
    try {
      const res = await fetch("/control/state");
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) throw new Error(res.status);
      last = await res.json();
      fetchedAt = Date.now();
    } catch (e) {
      if (last) last.online = false;      // lỗi mạng/server: coi như chưa kết nối
    }
    render();
  }

  poll();
  setInterval(poll, POLL_MS);
  setInterval(render, 1000);
})();


/* =====================================================
 * ĐĂNG XUẤT + ĐỒNG BỘ deviceID THEO TÀI KHOẢN ĐANG ĐĂNG NHẬP
 * ===================================================== */
(function initAuth() {
  // deviceID luôn lấy theo session trên server, không tin giá trị sửa tay trong localStorage
  fetch("/auth/me", { credentials: "include" })
    .then((r) => r.json())
    .then((d) => {
      if (!d.loggedIn) { window.location.href = "/login"; return; }
      localStorage.setItem("deviceID", d.user.deviceID);
    })
    .catch(() => {});

  const btn = document.getElementById("logoutBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (!confirm("Đăng xuất khỏi Smart Pillow?")) return;
    localStorage.removeItem("deviceID");
    window.location.href = "/auth/logout";
  });
})();

// iOS Safari: cần có listener touchstart thì :active mới chạy khi chạm nút
document.addEventListener("touchstart", function () {}, { passive: true });
