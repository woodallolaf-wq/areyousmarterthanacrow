/* Mortar Mode — hidden ballistic-arc calculator for the paintball field.
 * Entry gate lives in app.js (5 taps on the crow streak row). Zero backend,
 * zero dependencies. Single IIFE exposing window.MortarMode.
 *
 * Physics: point mass + quadratic drag, RK4 at dt = 2 ms. Vacuum kinematics
 * are off ~8x at these Reynolds numbers and are not used anywhere. Solutions
 * are solved on the descending branch (range peak → 87°), where range
 * decreases monotonically with angle, so distance->angle inversion is unique.
 * Distances beyond the mortar envelope get a low-arc angle rather than a
 * rejection; only physically unreachable distances are refused. */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Physics constants (.68 cal paintball)
  // ---------------------------------------------------------------------------
  var G = 9.81; // m/s²
  var RHO = 1.225; // kg/m³
  var CD = 0.47; // sphere
  var DIAM = 0.01727; // m
  var MASS = 0.003; // kg
  var AREA = (Math.PI * DIAM * DIAM) / 4;
  var K = (0.5 * RHO * CD * AREA) / MASS; // ≈ 0.0225 m⁻¹, terminal v ≈ 21 m/s
  var LAUNCH_H = 1.5; // m
  var DT = 0.002; // s
  var FPS_TO_MS = 0.3048;
  var DEG = Math.PI / 180;

  // Lookup-table bounds. 25°–89.5° — wide enough to reach below the range
  // peak (~30.5°); the solver only uses the descending branch from the peak
  // upward, so low-arc solutions are available without inversion ambiguity.
  var ANGLE_MIN = 25;
  var ANGLE_MAX = 89.5;
  var ANGLE_STEP = 0.25;
  var VEL_MIN = 250; // fps
  var VEL_MAX = 285;
  var VEL_STEP = 5;
  var AIM_CAP = 87; // UI hard cap — ≥88° is effectively straight up
  var DANGER_DEG = 88;
  var LOW_ARC_DEG = 46; // below this the solution is flagged as low arc
  var GREEN_TOL = 0.2; // deg — tight; the fine-trim readout guides the rest
  var DEFAULT_VEL = 265; // fps
  var FIT_ANGLE = 65.0; // held angle for the velocity back-fit

  var KEY_TARGETS = "mm.targets";
  var KEY_CAL = "mm.cal";

  // ---------------------------------------------------------------------------
  // Integrator
  // ---------------------------------------------------------------------------
  // One full trajectory: returns { range, tof } for launch at angleDeg / vFps
  // from LAUNCH_H down to ground (y = 0), RK4 on [x, y, vx, vy].
  function simulate(vFps, angleDeg) {
    var v0 = vFps * FPS_TO_MS;
    var a = angleDeg * DEG;
    var x = 0;
    var y = LAUNCH_H;
    var vx = v0 * Math.cos(a);
    var vy = v0 * Math.sin(a);
    var t = 0;
    var h = DT;

    while (t < 30) {
      var px = x;
      var py = y;

      var v1 = Math.sqrt(vx * vx + vy * vy);
      var ax1 = -K * v1 * vx;
      var ay1 = -G - K * v1 * vy;

      var vx2 = vx + (ax1 * h) / 2;
      var vy2 = vy + (ay1 * h) / 2;
      var v2 = Math.sqrt(vx2 * vx2 + vy2 * vy2);
      var ax2 = -K * v2 * vx2;
      var ay2 = -G - K * v2 * vy2;

      var vx3 = vx + (ax2 * h) / 2;
      var vy3 = vy + (ay2 * h) / 2;
      var v3 = Math.sqrt(vx3 * vx3 + vy3 * vy3);
      var ax3 = -K * v3 * vx3;
      var ay3 = -G - K * v3 * vy3;

      var vx4 = vx + ax3 * h;
      var vy4 = vy + ay3 * h;
      var v4 = Math.sqrt(vx4 * vx4 + vy4 * vy4);
      var ax4 = -K * v4 * vx4;
      var ay4 = -G - K * v4 * vy4;

      x += (h / 6) * (vx + 2 * vx2 + 2 * vx3 + vx4);
      y += (h / 6) * (vy + 2 * vy2 + 2 * vy3 + vy4);
      vx += (h / 6) * (ax1 + 2 * ax2 + 2 * ax3 + ax4);
      vy += (h / 6) * (ay1 + 2 * ay2 + 2 * ay3 + ay4);
      t += h;

      if (y <= 0 && vy < 0) {
        // Linear interpolation across the ground crossing.
        var f = py / (py - y);
        return { range: px + (x - px) * f, tof: t - h + h * f };
      }
    }
    return { range: x, tof: t }; // unreachable in practice; safety cap
  }

  // ---------------------------------------------------------------------------
  // Lookup table + solver
  // ---------------------------------------------------------------------------
  // Columns are built lazily per grid velocity: [{ a, r, t }], angle ascending,
  // range strictly descending (high branch).
  var columns = {};

  function getColumn(fps) {
    if (!columns[fps]) {
      var col = [];
      for (var a = ANGLE_MIN; a <= ANGLE_MAX + 1e-9; a += ANGLE_STEP) {
        var s = simulate(fps, a);
        col.push({ a: a, r: s.range, t: s.tof });
      }
      columns[fps] = col;
    }
    return columns[fps];
  }

  function colAt(col, angle, field) {
    var f = (angle - ANGLE_MIN) / ANGLE_STEP;
    var i = Math.floor(f);
    if (i < 0) return col[0][field];
    if (i >= col.length - 1) return col[col.length - 1][field];
    var w = f - i;
    return col[i][field] * (1 - w) + col[i + 1][field] * w;
  }

  // distance (m) -> { angle, tof, sens } at velFps, or { err, max/min }.
  // Never clamps: out-of-envelope requests are rejected with the limit value.
  function solve(dist, velFps) {
    if (!(dist > 0) || !isFinite(dist)) return { err: "bad" };

    var v = Math.min(VEL_MAX, Math.max(VEL_MIN, velFps || DEFAULT_VEL));
    var g0 = VEL_MIN + Math.floor((v - VEL_MIN) / VEL_STEP) * VEL_STEP;
    if (g0 >= VEL_MAX) g0 = VEL_MAX - VEL_STEP;
    var g1 = g0 + VEL_STEP;
    var w = (v - g0) / VEL_STEP;
    var c0 = getColumn(g0);
    var c1 = getColumn(g1);

    function rangeAt(angle) {
      return colAt(c0, angle, "r") * (1 - w) + colAt(c1, angle, "r") * w;
    }
    function tofAt(angle) {
      return colAt(c0, angle, "t") * (1 - w) + colAt(c1, angle, "t") * w;
    }

    // Locate the range peak — inversion is unique only from the peak upward.
    var peakA = ANGLE_MIN;
    var peakR = -1;
    for (var a = ANGLE_MIN; a <= AIM_CAP + 1e-9; a += ANGLE_STEP) {
      var r = rangeAt(a);
      if (r > peakR) {
        peakR = r;
        peakA = a;
      }
    }

    var minR = rangeAt(AIM_CAP);
    if (dist > peakR) return { err: "far", max: peakR };
    if (dist < minR) return { err: "near", min: minR };

    var lo = peakA;
    var hi = AIM_CAP;
    for (var i = 0; i < 40; i++) {
      var mid = (lo + hi) / 2;
      if (rangeAt(mid) >= dist) lo = mid;
      else hi = mid;
    }
    var angle = (lo + hi) / 2;

    var aLo = Math.max(peakA, angle - 0.5);
    var aHi = Math.min(AIM_CAP, angle + 0.5);
    var sens = (rangeAt(aLo) - rangeAt(aHi)) / (aHi - aLo); // m per degree

    return { angle: angle, tof: tofAt(angle), sens: sens };
  }

  // Velocity back-fit: observed impact distance at a held FIT_ANGLE -> muzzle
  // velocity (fps). Range at 65° increases monotonically with v, so bisect.
  function fitVelocity(obsDist) {
    var lo = VEL_MIN;
    var hi = VEL_MAX;
    if (obsDist <= simulate(lo, FIT_ANGLE).range) return { v: lo, clamped: true };
    if (obsDist >= simulate(hi, FIT_ANGLE).range) return { v: hi, clamped: true };
    for (var i = 0; i < 25; i++) {
      var mid = (lo + hi) / 2;
      if (simulate(mid, FIT_ANGLE).range < obsDist) lo = mid;
      else hi = mid;
    }
    return { v: (lo + hi) / 2, clamped: false };
  }

  // ---------------------------------------------------------------------------
  // Persistence (same rules as app.js: never assume localStorage works)
  // ---------------------------------------------------------------------------
  function loadJSON(key, fallback) {
    try {
      if (typeof localStorage === "undefined") return fallback;
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, val) {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(key, JSON.stringify(val));
      }
    } catch (e) {
      // Full or blocked. Feature keeps working in-memory.
    }
  }

  function loadCal() {
    var c = loadJSON(KEY_CAL, null);
    if (!c || typeof c !== "object") c = {};
    if (typeof c.mountOffset !== "number" || !isFinite(c.mountOffset)) {
      c.mountOffset = 0;
    }
    if (typeof c.velFps !== "number" || !isFinite(c.velFps)) {
      c.velFps = DEFAULT_VEL;
    }
    c.velFps = Math.min(VEL_MAX, Math.max(VEL_MIN, c.velFps));
    return c;
  }

  function loadTargets() {
    var t = loadJSON(KEY_TARGETS, []);
    if (!Array.isArray(t)) return [];
    return t.filter(function (x) {
      return (
        x &&
        typeof x.name === "string" &&
        typeof x.dist === "number" &&
        x.dist > 0
      );
    });
  }

  var cal = loadCal();
  var targets = loadTargets();

  function saveCal() {
    saveJSON(KEY_CAL, cal);
  }
  function saveTargets() {
    saveJSON(KEY_TARGETS, targets);
  }

  // ---------------------------------------------------------------------------
  // Sensor pipeline (gun-mounted inclinometer)
  // ---------------------------------------------------------------------------
  // Pitch from the gravity vector via devicemotion — NOT DeviceOrientation
  // Euler angles: beta is unstable near vertical and this feature lives at
  // 65–85°. Gravity-vector pitch is stable through 90°. Portrait-axis mount.
  var ALPHA = 0.08; // exponential smoothing — heavy, so the readout holds still
  var sensor = {
    running: false,
    granted: false,
    gy: 0,
    gz: 0,
    pitch: null,
    samples: [] // { t, p } over the last 500 ms, for the HOLD STEADY check
  };

  function onMotion(e) {
    var g = e.accelerationIncludingGravity;
    if (!g || typeof g.y !== "number" || typeof g.z !== "number") return;
    sensor.gy = ALPHA * g.y + (1 - ALPHA) * sensor.gy;
    sensor.gz = ALPHA * g.z + (1 - ALPHA) * sensor.gz;
    // Sign flipped from the original spec formula: on-device testing showed
    // the axis inverted (barrel up read -90°). flat=0, muzzle up=+90.
    var pitch = (Math.atan2(-sensor.gy, -sensor.gz) * 180) / Math.PI;
    sensor.pitch = pitch;

    var now = Date.now();
    sensor.samples.push({ t: now, p: pitch });
    while (sensor.samples.length && now - sensor.samples[0].t > 500) {
      sensor.samples.shift();
    }

    if (view === "AIM") updateAim();
    else if (view === "CAL") updateCal();
  }

  // Must be called from a user gesture (iOS permission gate, HTTPS only).
  // Never read sensors on load — iOS fails silently and the readout sits at 0.
  function startSensor() {
    if (sensor.running) return Promise.resolve("ok");
    if (typeof window === "undefined" || typeof DeviceMotionEvent === "undefined") {
      return Promise.resolve("unsupported");
    }
    var attach = function () {
      sensor.gy = 0;
      sensor.gz = 0;
      sensor.pitch = null;
      sensor.samples = [];
      window.addEventListener("devicemotion", onMotion);
      sensor.running = true;
      sensor.granted = true;
      return "ok";
    };
    if (typeof DeviceMotionEvent.requestPermission === "function") {
      return DeviceMotionEvent.requestPermission()
        .then(function (res) {
          return res === "granted" ? attach() : "denied";
        })
        .catch(function () {
          return "denied";
        });
    }
    return Promise.resolve(attach());
  }

  function stopSensor() {
    if (sensor.running) {
      window.removeEventListener("devicemotion", onMotion);
      sensor.running = false;
      sensor.pitch = null;
      sensor.samples = [];
    }
  }

  // Spread of pitch over the last 0.5 s; > 1.5° means the shooter is moving.
  function pitchSpread() {
    if (sensor.samples.length < 6) return 0;
    var lo = Infinity;
    var hi = -Infinity;
    for (var i = 0; i < sensor.samples.length; i++) {
      var p = sensor.samples[i].p;
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    return hi - lo;
  }

  // ---------------------------------------------------------------------------
  // Wake lock — the display must not sleep mid-aim
  // ---------------------------------------------------------------------------
  var wakeLock = null;

  function acquireWakeLock() {
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    navigator.wakeLock
      .request("screen")
      .then(function (wl) {
        wakeLock = wl;
      })
      .catch(function () {});
  }

  function releaseWakeLock() {
    if (wakeLock) {
      try {
        wakeLock.release();
      } catch (e) {}
      wakeLock = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Audio cue (iOS browsers do not vibrate — beep + green flash are the cues)
  // ---------------------------------------------------------------------------
  var audioCtx = null;
  var beepEnabled = false;

  function initAudio() {
    if (audioCtx) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    } catch (e) {}
  }

  function beep() {
    if (!beepEnabled || !audioCtx) return;
    try {
      var t0 = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.16);
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // View controller — HIDDEN -> MENU -> (CALIBRATE | TARGETS | AIM)
  // ---------------------------------------------------------------------------
  var view = "HIDDEN";
  var built = false;
  var els = {};

  // Aim state
  var solution = null; // { angle, tof, sens, dist, label, pos }
  var selectedTarget = -1;
  var manualPitch = null; // bubble-level fallback when motion access is denied
  var inZone = false;

  var MARKUP =
    '<div class="mm-wrap">' +
    '  <div class="mm-header">' +
    '    <span class="mm-title">MORTAR</span>' +
    '    <button class="mm-x" id="mm-close" aria-label="Close">✕</button>' +
    "  </div>" +
    '  <section id="mm-view-menu" class="mm-view">' +
    '    <button class="mm-btn mm-btn-big" id="mm-go-aim">AIM</button>' +
    '    <button class="mm-btn mm-btn-big" id="mm-go-targets">TARGETS</button>' +
    '    <button class="mm-btn mm-btn-big" id="mm-go-cal">CALIBRATE</button>' +
    '    <p class="mm-note">Field rules first: no-lob rules or overhead netting kill' +
    "      high-arc (apex 20–28 m). Masks on, chrono limits unchanged — this" +
    "      changes where the barrel points, nothing else.</p>" +
    "  </section>" +
    '  <section id="mm-view-aim" class="mm-view" hidden>' +
    '    <button class="mm-btn mm-btn-small mm-back" data-mm-back>← MENU</button>' +
    '    <div class="mm-live" id="mm-live" hidden>' +
    '      <div class="mm-steady" id="mm-steady" hidden>HOLD STEADY</div>' +
    '      <div class="mm-angle-now" id="mm-angle-now">—</div>' +
    '      <div class="mm-target-line" id="mm-target-line"></div>' +
    '      <div class="mm-arrow" id="mm-arrow"></div>' +
    '      <div class="mm-live-btns">' +
    '        <button class="mm-btn mm-btn-small" id="mm-rezero">RE-ZERO (hold level)</button>' +
    '        <button class="mm-btn mm-btn-small" id="mm-beep">BEEP: OFF</button>' +
    "      </div>" +
    "    </div>" +
    '    <button class="mm-btn mm-btn-big" id="mm-enter-aim">ENTER AIM MODE</button>' +
    '    <div class="mm-denied" id="mm-denied" hidden>' +
    '      <div id="mm-denied-msg"></div>' +
    '      <input id="mm-manual-angle" type="number" inputmode="decimal"' +
    '        placeholder="bubble-level angle ° (fallback)">' +
    "    </div>" +
    '    <div class="mm-err" id="mm-aim-err" hidden></div>' +
    '    <div class="mm-solution" id="mm-solution" hidden>' +
    '      <div class="mm-sol-name" id="mm-sol-name"></div>' +
    '      <div class="mm-sol-angle" id="mm-sol-angle"></div>' +
    '      <div class="mm-sol-meta" id="mm-sol-meta"></div>' +
    "    </div>" +
    '    <div class="mm-tiles" id="mm-tiles"></div>' +
    '    <div class="mm-row">' +
    '      <input id="mm-dist" type="number" inputmode="decimal" min="1" step="0.5"' +
    '        placeholder="distance m">' +
    '      <button class="mm-btn" id="mm-solve">SOLVE</button>' +
    "    </div>" +
    '    <p class="mm-hint">Volley fire — walk rounds in · wind unmodeled</p>' +
    "  </section>" +
    '  <section id="mm-view-targets" class="mm-view" hidden>' +
    '    <button class="mm-btn mm-btn-small mm-back" data-mm-back>← MENU</button>' +
    '    <div class="mm-h">Target registry</div>' +
    '    <p class="mm-note">Enter during field walk-through. Solutions are valid only' +
    "      from the position they were measured from.</p>" +
    '    <ul class="mm-list" id="mm-target-list"></ul>' +
    '    <div class="mm-form">' +
    '      <input id="mm-t-name" type="text" placeholder="name (snake)">' +
    '      <input id="mm-t-dist" type="number" inputmode="decimal" min="1" step="0.5"' +
    '        placeholder="distance m">' +
    '      <input id="mm-t-pos" type="text" placeholder="measured from (spawn wall)">' +
    '      <button class="mm-btn" id="mm-t-add">ADD TARGET</button>' +
    "    </div>" +
    "  </section>" +
    '  <section id="mm-view-cal" class="mm-view" hidden>' +
    '    <button class="mm-btn mm-btn-small mm-back" data-mm-back>← MENU</button>' +
    '    <div class="mm-h">1 · Zero mount</div>' +
    '    <p class="mm-note">Strap phone to gun (portrait axis). Aim the barrel flat' +
    "      along a level reference, then tap ZERO. Any strap change invalidates the" +
    "      zero. This is the highest-leverage calibration step: ~2 m per degree.</p>" +
    '    <button class="mm-btn" id="mm-cal-start">ENABLE SENSOR</button>' +
    '    <div class="mm-cal-live" id="mm-cal-live" hidden>' +
    '      <div class="mm-cal-pitch" id="mm-cal-pitch">—</div>' +
    '      <button class="mm-btn" id="mm-cal-zero">ZERO</button>' +
    "    </div>" +
    '    <div class="mm-note" id="mm-cal-offset"></div>' +
    '    <div class="mm-h">2 · Velocity fit (optional)</div>' +
    '    <p class="mm-note">Fire 3 shots at a held 65.0°. Pace the impact distance' +
    "      and enter it — worth ≤ 1.5 m at high arc.</p>" +
    '    <div class="mm-row">' +
    '      <input id="mm-cal-obs" type="number" inputmode="decimal" min="1" step="0.5"' +
    '        placeholder="observed m">' +
    '      <button class="mm-btn" id="mm-cal-fit">FIT</button>' +
    "    </div>" +
    '    <div class="mm-note" id="mm-cal-vel"></div>' +
    '    <button class="mm-btn mm-btn-small" id="mm-cal-vreset">RESET TO 265 FPS</button>' +
    '    <div class="mm-h">3 · Sanity shot</div>' +
    '    <p class="mm-note">Solve for a paced known distance, fire, observe. Off by' +
    "      more than 5 m in calm air → re-zero the mount before blaming anything" +
    "      else.</p>" +
    "  </section>" +
    "</div>";

  function $id(id) {
    return document.getElementById(id);
  }

  function buildUI() {
    var root = $id("mortar-root");
    if (!root) return false;
    root.innerHTML = MARKUP;

    els.root = root;
    els.viewMenu = $id("mm-view-menu");
    els.viewAim = $id("mm-view-aim");
    els.viewTargets = $id("mm-view-targets");
    els.viewCal = $id("mm-view-cal");

    els.live = $id("mm-live");
    els.steady = $id("mm-steady");
    els.angleNow = $id("mm-angle-now");
    els.targetLine = $id("mm-target-line");
    els.arrow = $id("mm-arrow");
    els.enterAim = $id("mm-enter-aim");
    els.denied = $id("mm-denied");
    els.deniedMsg = $id("mm-denied-msg");
    els.manualAngle = $id("mm-manual-angle");
    els.aimErr = $id("mm-aim-err");
    els.solutionBox = $id("mm-solution");
    els.solName = $id("mm-sol-name");
    els.solAngle = $id("mm-sol-angle");
    els.solMeta = $id("mm-sol-meta");
    els.tiles = $id("mm-tiles");
    els.dist = $id("mm-dist");
    els.beepBtn = $id("mm-beep");

    els.targetList = $id("mm-target-list");
    els.tName = $id("mm-t-name");
    els.tDist = $id("mm-t-dist");
    els.tPos = $id("mm-t-pos");

    els.calStart = $id("mm-cal-start");
    els.calLive = $id("mm-cal-live");
    els.calPitch = $id("mm-cal-pitch");
    els.calOffset = $id("mm-cal-offset");
    els.calObs = $id("mm-cal-obs");
    els.calVel = $id("mm-cal-vel");

    $id("mm-close").addEventListener("click", close_);
    $id("mm-go-aim").addEventListener("click", function () {
      showView("AIM");
    });
    $id("mm-go-targets").addEventListener("click", function () {
      showView("TARGETS");
    });
    $id("mm-go-cal").addEventListener("click", function () {
      showView("CAL");
    });
    root.querySelectorAll("[data-mm-back]").forEach(function (b) {
      b.addEventListener("click", function () {
        showView("MENU");
      });
    });

    // --- Aim ---
    els.enterAim.addEventListener("click", function () {
      startSensor().then(function (status) {
        if (status === "ok") {
          els.enterAim.hidden = true;
          els.denied.hidden = true;
          els.live.hidden = false;
          acquireWakeLock();
          updateAim();
        } else {
          // Fallback: numeric entry of a bubble-level reading.
          els.denied.hidden = false;
          els.live.hidden = false;
          els.deniedMsg.textContent =
            status === "denied"
              ? "Motion access denied. Re-enable via Settings → Safari → " +
                "Motion & Orientation Access, then reload."
              : "No motion sensors on this device — use a bubble level and " +
                "type the barrel angle below.";
          updateAim();
        }
      });
    });

    els.manualAngle.addEventListener("input", function () {
      var v = parseFloat(els.manualAngle.value);
      manualPitch = isFinite(v) ? v : null;
      updateAim();
    });

    $id("mm-solve").addEventListener("click", function () {
      var d = parseFloat(els.dist.value);
      selectedTarget = -1;
      renderTiles();
      doSolve(d, null, null);
    });

    $id("mm-rezero").addEventListener("click", function () {
      if (sensor.pitch === null) return;
      cal.mountOffset = sensor.pitch;
      saveCal();
      flash(els.arrow, "ZEROED");
      updateAim();
    });

    els.beepBtn.addEventListener("click", function () {
      beepEnabled = !beepEnabled;
      if (beepEnabled) initAudio(); // gesture — unlocks WebAudio on iOS
      els.beepBtn.textContent = "BEEP: " + (beepEnabled ? "ON" : "OFF");
    });

    // --- Targets ---
    $id("mm-t-add").addEventListener("click", function () {
      var name = (els.tName.value || "").trim();
      var dist = parseFloat(els.tDist.value);
      var pos = (els.tPos.value || "").trim();
      if (!name || !(dist > 0)) return;
      targets.push({ name: name, dist: dist, pos: pos });
      saveTargets();
      els.tName.value = "";
      els.tDist.value = "";
      els.tPos.value = "";
      renderTargetList();
    });

    // --- Calibrate ---
    els.calStart.addEventListener("click", function () {
      startSensor().then(function (status) {
        if (status === "ok") {
          els.calStart.hidden = true;
          els.calLive.hidden = false;
          updateCal();
        } else {
          els.calStart.textContent =
            status === "denied"
              ? "MOTION ACCESS DENIED — Settings → Safari → Motion & Orientation"
              : "NO MOTION SENSORS ON THIS DEVICE";
        }
      });
    });

    $id("mm-cal-zero").addEventListener("click", function () {
      if (sensor.pitch === null) return;
      cal.mountOffset = sensor.pitch;
      saveCal();
      renderCalLabels();
      updateCal();
    });

    $id("mm-cal-fit").addEventListener("click", function () {
      var obs = parseFloat(els.calObs.value);
      if (!(obs > 0)) return;
      var fit = fitVelocity(obs);
      cal.velFps = fit.v;
      saveCal();
      solution = null; // stale — velocity changed
      renderSolution();
      renderCalLabels(
        fit.clamped
          ? "Observed distance is outside the 250–285 fps envelope — " +
            "clamped. Re-check the paced distance and the held 65.0°."
          : null
      );
    });

    $id("mm-cal-vreset").addEventListener("click", function () {
      cal.velFps = DEFAULT_VEL;
      saveCal();
      solution = null;
      renderSolution();
      renderCalLabels();
    });

    // Re-acquire the wake lock when the page becomes visible again mid-session.
    document.addEventListener("visibilitychange", function () {
      if (
        document.visibilityState === "visible" &&
        view === "AIM" &&
        sensor.running
      ) {
        acquireWakeLock();
      }
    });

    built = true;
    return true;
  }

  function showView(name) {
    view = name;
    els.viewMenu.hidden = name !== "MENU";
    els.viewAim.hidden = name !== "AIM";
    els.viewTargets.hidden = name !== "TARGETS";
    els.viewCal.hidden = name !== "CAL";
    els.root.scrollTop = 0;

    if (name === "AIM") {
      renderTiles();
      renderSolution();
      var live = sensor.running || manualPitch !== null;
      els.enterAim.hidden = sensor.running;
      els.live.hidden = !live;
      if (sensor.running) acquireWakeLock();
      updateAim();
    } else {
      releaseWakeLock();
    }
    if (name === "TARGETS") renderTargetList();
    if (name === "CAL") {
      els.calStart.hidden = sensor.running;
      els.calLive.hidden = !sensor.running;
      renderCalLabels();
      updateCal();
    }
  }

  // ---------------------------------------------------------------------------
  // Aim view
  // ---------------------------------------------------------------------------
  function doSolve(dist, label, pos) {
    var res = solve(dist, cal.velFps);
    if (res.err === "far") {
      // Physically unreachable at any angle — nothing to aim.
      solution = null;
      showAimErr("BEYOND MAX RANGE — MAX " + res.max.toFixed(0) + " m");
    } else if (res.err === "near") {
      solution = null;
      showAimErr(
        "TOO CLOSE — MIN " + res.min.toFixed(0) + " m (87° cap)"
      );
    } else if (res.err) {
      solution = null;
      showAimErr("ENTER A DISTANCE IN METERS");
    } else {
      solution = {
        angle: res.angle,
        tof: res.tof,
        sens: res.sens,
        dist: dist,
        label: label,
        pos: pos
      };
      showAimErr(null);
    }
    renderSolution();
    updateAim();
  }

  function showAimErr(msg) {
    els.aimErr.hidden = !msg;
    els.aimErr.textContent = msg || "";
  }

  function renderSolution() {
    if (!solution) {
      els.solutionBox.hidden = true;
      return;
    }
    els.solutionBox.hidden = false;
    els.solName.textContent =
      (solution.label ? solution.label + " — " : "") +
      solution.dist + " m" +
      (solution.pos ? " · from " + solution.pos : "");
    els.solAngle.textContent = "ELEV " + solution.angle.toFixed(1) + "°";
    els.solMeta.textContent =
      "TOF " + solution.tof.toFixed(1) + " s · " +
      solution.sens.toFixed(1) + " m/° · " +
      Math.round(cal.velFps) + " fps" +
      (solution.angle < LOW_ARC_DEG ? " · LOW ARC — flat trajectory" : "");
  }

  function renderTiles() {
    els.tiles.innerHTML = "";
    if (!targets.length) {
      var note = document.createElement("div");
      note.className = "mm-note";
      note.textContent = "No saved targets — type a distance below.";
      els.tiles.appendChild(note);
      return;
    }
    targets.forEach(function (t, i) {
      var btn = document.createElement("button");
      btn.className = "mm-tile" + (i === selectedTarget ? " selected" : "");
      var name = document.createElement("div");
      name.className = "mm-tile-name";
      name.textContent = t.name;
      var dist = document.createElement("div");
      dist.className = "mm-tile-dist";
      dist.textContent = t.dist + " m";
      btn.appendChild(name);
      btn.appendChild(dist);
      if (t.pos) {
        var pos = document.createElement("div");
        pos.className = "mm-tile-pos";
        pos.textContent = "from " + t.pos;
        btn.appendChild(pos);
      }
      btn.addEventListener("click", function () {
        selectedTarget = i;
        renderTiles();
        doSolve(t.dist, t.name, t.pos);
      });
      els.tiles.appendChild(btn);
    });
  }

  function updateAim() {
    if (view !== "AIM") return;

    var displayed = null;
    if (sensor.running && sensor.pitch !== null) {
      displayed = sensor.pitch - cal.mountOffset;
    } else if (manualPitch !== null) {
      displayed = manualPitch;
    }

    if (displayed === null) {
      els.angleNow.textContent = "—";
      els.targetLine.textContent = solution
        ? "TARGET " + solution.angle.toFixed(1) + "°"
        : "";
      els.arrow.textContent = "";
      return;
    }

    els.angleNow.textContent = displayed.toFixed(1) + "°";
    els.targetLine.textContent = solution
      ? "TARGET " + solution.angle.toFixed(1) + "°"
      : "";

    els.steady.hidden = !(sensor.running && pitchSpread() > 1.5);

    var danger = displayed >= DANGER_DEG;
    var zone = false;
    var arrowText;
    if (danger) {
      arrowText = "≈ STRAIGHT UP — ROUNDS RETURN TO YOU";
    } else if (solution) {
      var d = solution.angle - displayed;
      if (Math.abs(d) <= GREEN_TOL) {
        zone = true;
        // Keep the fine delta visible so the shooter can trim to perfect.
        arrowText =
          Math.abs(d) < 0.05
            ? "ON — DEAD ON"
            : "ON — " + (d > 0 ? "▲ " : "▼ ") + Math.abs(d).toFixed(1) + "°";
      } else if (d > 0) {
        arrowText = "▲ RAISE " + d.toFixed(1) + "°";
      } else {
        arrowText = "▼ LOWER " + (-d).toFixed(1) + "°";
      }
    } else {
      arrowText = "PICK A TARGET";
    }
    els.arrow.textContent = arrowText;

    els.root.classList.toggle("mm-green", zone);
    els.root.classList.toggle("mm-danger", danger);

    if (zone && !inZone) {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        try {
          navigator.vibrate([80, 40, 80]); // Android; iOS uses flash + beep
        } catch (e) {}
      }
      beep();
    }
    inZone = zone;
  }

  function flash(el, msg) {
    var prev = el.textContent;
    el.textContent = msg;
    setTimeout(function () {
      if (el.textContent === msg) el.textContent = prev;
    }, 900);
  }

  // ---------------------------------------------------------------------------
  // Targets view
  // ---------------------------------------------------------------------------
  function renderTargetList() {
    els.targetList.innerHTML = "";
    if (!targets.length) {
      var note = document.createElement("li");
      note.className = "mm-note";
      note.textContent = "No targets yet.";
      els.targetList.appendChild(note);
      return;
    }
    targets.forEach(function (t, i) {
      var li = document.createElement("li");
      li.className = "mm-trow";
      var info = document.createElement("span");
      info.className = "mm-trow-info";
      info.textContent =
        t.name + " — " + t.dist + " m" + (t.pos ? " · from " + t.pos : "");
      var del = document.createElement("button");
      del.className = "mm-btn mm-btn-small";
      del.textContent = "DEL";
      del.addEventListener("click", function () {
        targets.splice(i, 1);
        saveTargets();
        if (selectedTarget === i) selectedTarget = -1;
        renderTargetList();
      });
      li.appendChild(info);
      li.appendChild(del);
      els.targetList.appendChild(li);
    });
  }

  // ---------------------------------------------------------------------------
  // Calibration view
  // ---------------------------------------------------------------------------
  function renderCalLabels(extraNote) {
    els.calOffset.textContent =
      "Mount offset: " +
      (cal.mountOffset >= 0 ? "+" : "") +
      cal.mountOffset.toFixed(1) +
      "°";
    els.calVel.textContent =
      "Muzzle velocity: " +
      cal.velFps.toFixed(0) +
      " fps" +
      (cal.velFps === DEFAULT_VEL ? " (default)" : " (fitted)") +
      (extraNote ? " — " + extraNote : "");
  }

  function updateCal() {
    if (view !== "CAL" || sensor.pitch === null) return;
    els.calPitch.textContent =
      sensor.pitch.toFixed(1) +
      "° raw · " +
      (sensor.pitch - cal.mountOffset).toFixed(1) +
      "° corrected";
  }

  // ---------------------------------------------------------------------------
  // Open / close
  // ---------------------------------------------------------------------------
  function open_() {
    if (typeof document === "undefined") return;
    if (!built && !buildUI()) return;
    cal = loadCal();
    targets = loadTargets();
    // Warm the solver for the current velocity (~tens of ms, once per column).
    getColumn(VEL_MIN + Math.floor((cal.velFps - VEL_MIN) / VEL_STEP) * VEL_STEP);
    els.root.hidden = false;
    showView("MENU");
  }

  function close_() {
    stopSensor();
    releaseWakeLock();
    inZone = false;
    if (els.root) {
      els.root.classList.remove("mm-green", "mm-danger");
      els.root.hidden = true;
    }
    view = "HIDDEN";
    // Quiz state untouched — the overlay just goes away.
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  var api = {
    open: open_,
    close: close_,
    // Physics hooks for offline verification (node). Not used by the UI.
    _physics: {
      simulate: simulate,
      solve: solve,
      fitVelocity: fitVelocity,
      K: K
    }
  };

  if (typeof window !== "undefined") window.MortarMode = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
