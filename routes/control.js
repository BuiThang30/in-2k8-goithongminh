const express = require("express");
const router = express.Router();

/**
 * Điều khiển gối thông minh qua web server.
 *
 * Luồng:
 *   Popup (home.html) --POST /control-->  server xếp hàng lệnh
 *   Gối (ESP32)       --GET  /control/esp?dev=<deviceID>&after=<id>&a=..&b=..-->  nhận lệnh mới + báo trạng thái
 *
 * Mỗi gối (deviceID) có hàng đợi lệnh + trạng thái riêng. Người dùng chỉ điều khiển / xem
 * được gối có deviceID trùng với deviceID của tài khoản đang đăng nhập.
 *   Popup             --GET  /control/state-->  hiển thị trạng thái thật của gối
 *
 * Định dạng lệnh khớp với ServerControl.cpp trên gối:
 *   {t:"motor", a:0..100, b:0..100}   a = massage, b = nhiệt
 *   {t:"mstop"}                       tắt massage + nhiệt (KHÔNG đụng tới nhạc)
 *   {t:"alloff"}                      TẮT TẤT CẢ: massage + nhiệt + nhạc
 *   {t:"play", track:1..3000} | {t:"pause"} | {t:"stop"}
 *   {t:"vol", volume:0..30}
 *   {t:"timer", minutes:0..}          0 = hủy hẹn giờ
 */

const CMD_TTL_MS = 30 * 1000;   // lệnh quá 30s mà gối chưa lấy thì bỏ (tránh bật nhiệt/massage muộn)
const MAX_QUEUE = 50;
const ONLINE_MS = 8000;       // gối hỏi lệnh mỗi 1s (5s khi lỗi); quá 8s không thấy -> coi là mất kết nối

const DEFAULT_DEVICE = 1;   // firmware cũ chưa gửi ?dev= thì coi là gối số 1

const newDevice = () => ({
  seq: 0,          // id của lệnh mới nhất
  queue: [],       // [{id, at, t, ...}]
  acked: -1,       // id gối đã xử lý (gối gửi lên qua ?after=)
  lastSeen: 0,     // lần gần nhất gối hỏi server
  // Trạng thái hiển thị trên popup (cập nhật ngay khi bấm + được gối xác nhận lại)
  state: {
    a: 0, b: 0,
    track: 1, volume: 15, playing: false,
    timer: 0, timerActive: false,
    remain: 0, remainAt: 0,
    auto: false,            // gối đang tự phát nhạc (Auto comfort)
  },
});

const devices = new Map();   // deviceID -> newDevice()
function getDevice(id) {
  if (!devices.has(id)) devices.set(id, newDevice());
  return devices.get(id);
}

const clampInt = (v, min, max) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return null;
  return Math.min(max, Math.max(min, n));
};

function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ message: "Chưa đăng nhập" });
  }
  next();
}

// deviceID của tài khoản đang đăng nhập (chỉ điều khiển được đúng gối của mình)
function sessionDeviceId(req) {
  const id = parseInt(req.session.user.deviceID, 10);
  return Number.isNaN(id) ? null : id;
}

const isOnline = (d) => Date.now() - d.lastSeen < ONLINE_MS;

function prune(d) {
  const now = Date.now();
  d.queue = d.queue.filter((c) => now - c.at < CMD_TTL_MS).slice(-MAX_QUEUE);
}

function push(d, cmd) {
  // Các lệnh "đặt giá trị" chỉ cần giữ cái mới nhất chưa được gối xử lý
  if (cmd.t === "motor" || cmd.t === "vol" || cmd.t === "timer") {
    d.queue = d.queue.filter((c) => !(c.t === cmd.t && c.id > d.acked));
  }
  d.seq += 1;
  d.queue.push({ id: d.seq, at: Date.now(), ...cmd });
  prune(d);
}

function remainNow(d) {
  const state = d.state;
  if (!state.timerActive) return 0;
  const left = state.remain - Math.floor((Date.now() - state.remainAt) / 1000);
  return Math.max(0, left);
}

// ---------- Popup -> server ----------
router.post("/", requireLogin, (req, res) => {
  const body = req.body || {};
  const t = body.t;

  // Chỉ điều khiển gối có deviceID trùng với tài khoản đăng nhập.
  // deviceID do client gửi lên (nếu có) mà khác tài khoản thì từ chối.
  const devId = sessionDeviceId(req);
  if (devId === null) return res.status(403).json({ message: "Tài khoản chưa gắn với gối nào" });
  if (body.deviceID !== undefined && parseInt(body.deviceID, 10) !== devId) {
    return res.status(403).json({ message: "Sai ID thiết bị" });
  }
  const dev = getDevice(devId);
  const state = dev.state;

  // Gối chưa kết nối thì không nhận lệnh (tránh xếp hàng lệnh cũ rồi chạy muộn)
  if (!isOnline(dev)) {
    return res.status(409).json({ message: "Gối chưa kết nối" });
  }

  switch (t) {
    case "motor": {
      // Luôn gửi đủ cả a và b để việc gộp lệnh không làm mất giá trị của động cơ còn lại
      const a = body.a === undefined ? state.a : clampInt(body.a, 0, 100);
      const b = body.b === undefined ? state.b : clampInt(body.b, 0, 100);
      if (a === null || b === null) return res.status(400).json({ message: "Giá trị a/b không hợp lệ" });
      state.a = a; state.b = b;
      push(dev, { t: "motor", a, b });
      break;
    }
    case "mstop": // chỉ tắt massage + nhiệt, nhạc giữ nguyên
      state.a = 0; state.b = 0;
      push(dev, { t: "mstop" });
      break;
    case "alloff": // TẮT TẤT CẢ: massage + nhiệt + nhạc (giống nút "TẮT TẤT CẢ" trên web của gối)
      state.a = 0; state.b = 0; state.playing = false;
      push(dev, { t: "mstop" });
      push(dev, { t: "stop" });
      break;
    case "play": {
      const track = clampInt(body.track, 1, 3000);
      if (track === null) return res.status(400).json({ message: "Bài hát không hợp lệ" });
      state.track = track; state.playing = true;
      push(dev, { t: "play", track });
      break;
    }
    case "pause":
      state.playing = false;
      push(dev, { t: "pause" });
      break;
    case "stop":
      state.playing = false;
      push(dev, { t: "stop" });
      break;
    case "vol": {
      const volume = clampInt(body.volume, 0, 30);
      if (volume === null) return res.status(400).json({ message: "Âm lượng không hợp lệ" });
      state.volume = volume;
      push(dev, { t: "vol", volume });
      break;
    }
    case "timer": {
      const minutes = clampInt(body.minutes, 0, 600);
      if (minutes === null) return res.status(400).json({ message: "Hẹn giờ không hợp lệ" });
      state.timer = minutes;
      state.timerActive = minutes > 0;
      state.remain = minutes * 60;
      state.remainAt = Date.now();
      push(dev, { t: "timer", minutes });
      break;
    }
    default:
      return res.status(400).json({ message: "Lệnh không hợp lệ" });
  }

  console.log(`📥 [gối ${devId}] Lệnh #${dev.seq}:`, JSON.stringify(body));
  res.json({ success: true, id: dev.seq });
});

// ---------- Gối hỏi lệnh ----------
router.get("/esp", (req, res) => {
  const devId = parseInt(req.query.dev, 10);
  const dev = getDevice(Number.isNaN(devId) ? DEFAULT_DEVICE : devId);
  const state = dev.state;
  dev.lastSeen = Date.now();
  prune(dev);

  const after = parseInt(req.query.after, 10);
  const hasAfter = !Number.isNaN(after);

  // Gối báo đã xử lý tới lệnh nào
  if (hasAfter && after >= 0) dev.acked = Math.min(after, dev.seq);

  // Chỉ nhận trạng thái do gối báo khi nó đã bắt kịp hàng đợi (hoặc vừa khởi động),
  // tránh số liệu cũ ghi đè lên giá trị người dùng vừa chỉnh trên popup.
  if (!hasAfter || after < 0 || after >= dev.seq) {
    const q = req.query;
    const a = clampInt(q.a, 0, 100), b = clampInt(q.b, 0, 100);
    if (a !== null) state.a = a;
    if (b !== null) state.b = b;
    const track = clampInt(q.track, 1, 3000);
    if (track !== null) state.track = track;
    const vol = clampInt(q.vol, 0, 30);
    if (vol !== null) state.volume = vol;
    if (q.playing !== undefined) state.playing = q.playing === "1";
    const timer = clampInt(q.timer, 0, 600);
    if (timer !== null) state.timer = timer;
    if (q.tact !== undefined) state.timerActive = q.tact === "1";
    if (q.auto !== undefined) state.auto = q.auto === "1";
    const remain = clampInt(q.remain, 0, 36000);
    if (remain !== null) { state.remain = remain; state.remainAt = Date.now(); }
  }

  // Gối vừa khởi động (after=-1) hoặc server vừa khởi động lại (after > dev.seq):
  // chỉ đồng bộ id, không phát lại lệnh cũ.
  if (!hasAfter || after < 0 || after > dev.seq) {
    return res.json({ cmds: [], last: dev.seq });
  }

  const cmds = dev.queue.filter((c) => c.id > after).map(({ id, at, ...cmd }) => cmd);
  res.json({ cmds, last: dev.seq });
});

// ---------- Popup đọc trạng thái ----------
router.get("/state", requireLogin, (req, res) => {
  const devId = sessionDeviceId(req);
  if (devId === null) return res.status(403).json({ message: "Tài khoản chưa gắn với gối nào" });
  const dev = getDevice(devId);
  const state = dev.state;
  res.json({
    deviceID: devId,
    online: isOnline(dev),
    a: state.a,
    b: state.b,
    track: state.track,
    volume: state.volume,
    playing: state.playing,
    timer: state.timer,
    timerActive: state.timerActive,
    remain: remainNow(dev),
    auto: state.auto,
    // số giây kể từ lần gối hỏi lệnh gần nhất; null = từ lúc server chạy chưa thấy gối lần nào
    ago: dev.lastSeen ? Math.floor((Date.now() - dev.lastSeen) / 1000) : null,
  });
});

module.exports = router;
