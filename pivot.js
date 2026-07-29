/* Nostia Pivot — UI preview of the Organizations: Sponsored Adventures feature.
 *
 * WHAT THIS IS: a throwaway prototype for evaluating the interaction design of
 * nostia-pivot (spec §11's eight views, which were never built). It is hidden
 * behind a tap gesture in the quiz's Streaks & Trophies screen, exactly like
 * Mortar Mode. Entry gate lives in app.js (3 taps on the Claude streak row).
 *
 * WHAT THIS IS NOT: a product. There is no backend, no network call of any
 * kind, no real money and no real user data. Every "API" call below is an
 * in-memory mock, and both model-backed features (the authoring assistant and
 * the photo judge) return canned responses. The preview strip at the top says
 * so; do not remove it — this is served from a public domain and anyone who
 * finds the gesture must know immediately that nothing here is real.
 *
 * Zero dependencies, ES5, single IIFE exposing window.NostiaPivot — matching
 * mortar.js so the site stays buildless. */

(function () {
  "use strict";

  var STORE_KEY = "np_preview_state";
  var SIM_SPEED = 6; // dwell runs 6x wall clock; a real 90s dwell per stop is
                     // not worth sitting through when testing the UI.

  // ===========================================================================
  // DOM helpers
  // ===========================================================================

  /* Builds an element. Text always goes in via textContent — never innerHTML —
     so an adventure title typed by the user cannot inject markup into the page
     that hosts the quiz. */
  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "text") node.textContent = v;
        else if (k === "html") node.innerHTML = v; // only ever for our own SVG
        else if (k === "on") { for (var ev in v) node.addEventListener(ev, v[ev]); }
        else if (k === "class") node.className = v;
        else if (v === true) node.setAttribute(k, "");
        else node.setAttribute(k, v);
      }
    }
    if (kids) {
      var list = Array.isArray(kids) ? kids : [kids];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371000;
    var rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad;
    var dLng = (lng2 - lng1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function nowIso() { return new Date().toISOString(); }
  function uid() { return Math.floor(Math.random() * 1e9); }

  // ===========================================================================
  // QR encoder — ported from nostia-pivot/services/orgInviteService.js
  // ===========================================================================
  // Byte mode, ECC level M, mask 0. Verified in the nostia-pivot smoke suite by
  // three independent checks (GF(256) field against published values, a
  // Reed-Solomon syndrome check that does not mirror the encoder, and a payload
  // round-trip). Ported rather than re-derived so the invite view shows a
  // genuinely scannable code, and self-contained SVG so there is still no
  // network call anywhere in this file.

  var GF_EXP = new Array(512);
  var GF_LOG = new Array(256);
  (function initGf() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF_EXP[i] = x; GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255];
  }());

  function gfMul(a, b) { return (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]; }

  function rsGenerator(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = [];
      for (var z = 0; z <= poly.length; z++) next.push(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGenerator(ecLen);
    var res = [];
    for (var z = 0; z < ecLen; z++) res.push(0);
    for (var d = 0; d < data.length; d++) {
      var factor = data[d] ^ res[0];
      res.shift();
      res.push(0);
      for (var i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
    return res;
  }

  var QR_VERSIONS = [
    { v: 2, total: 44, ec: 16, blocks: 1, size: 25 },
    { v: 3, total: 70, ec: 26, blocks: 1, size: 29 },
    { v: 4, total: 100, ec: 36, blocks: 2, size: 33 },
    { v: 5, total: 134, ec: 48, blocks: 2, size: 37 },
    { v: 6, total: 172, ec: 64, blocks: 4, size: 41 },
    { v: 7, total: 196, ec: 72, blocks: 4, size: 45 }
  ];
  var QR_ALIGN = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38] };

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return out;
  }

  function buildQrMatrix(text) {
    var bytes = utf8Bytes(text);
    var spec = null;
    for (var s = 0; s < QR_VERSIONS.length; s++) {
      if ((QR_VERSIONS[s].total - QR_VERSIONS[s].ec) >= bytes.length + 3) { spec = QR_VERSIONS[s]; break; }
    }
    if (!spec) throw new Error("QR payload too long");

    var bits = [];
    function push(value, len) { for (var i = len - 1; i >= 0; i--) bits.push((value >> i) & 1); }
    push(0x4, 4);
    push(bytes.length, 8);
    for (var b = 0; b < bytes.length; b++) push(bytes[b], 8);

    var capacityBits = (spec.total - spec.ec) * 8;
    for (var t = 0; t < 4 && bits.length < capacityBits; t++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    var dataCw = [];
    for (var i2 = 0; i2 < bits.length; i2 += 8) {
      dataCw.push(parseInt(bits.slice(i2, i2 + 8).join(""), 2));
    }
    var pad = [0xec, 0x11];
    var p = 0;
    while (dataCw.length < spec.total - spec.ec) { dataCw.push(pad[p % 2]); p++; }

    var perBlock = Math.floor(dataCw.length / spec.blocks);
    var ecPer = spec.ec / spec.blocks;
    var dBlocks = [], eBlocks = [];
    for (var k = 0; k < spec.blocks; k++) {
      var chunk = dataCw.slice(k * perBlock, (k + 1) * perBlock);
      dBlocks.push(chunk);
      eBlocks.push(rsEncode(chunk, ecPer));
    }
    var finalCw = [];
    for (var q = 0; q < perBlock; q++) for (var bb = 0; bb < spec.blocks; bb++) finalCw.push(dBlocks[bb][q]);
    for (var r = 0; r < ecPer; r++) for (var cc = 0; cc < spec.blocks; cc++) finalCw.push(eBlocks[cc][r]);

    var size = spec.size;
    var m = [];
    for (var y = 0; y < size; y++) { m.push([]); for (var x = 0; x < size; x++) m[y].push(null); }

    function placeFinder(row, col) {
      for (var dr = -1; dr <= 7; dr++) {
        for (var dc = -1; dc <= 7; dc++) {
          var rr = row + dr, ccc = col + dc;
          if (rr < 0 || ccc < 0 || rr >= size || ccc >= size) continue;
          var inner = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          var ring = inner && (dr === 0 || dr === 6 || dc === 0 || dc === 6);
          var core = inner && dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          m[rr][ccc] = (ring || core) ? 1 : 0;
        }
      }
    }
    placeFinder(0, 0); placeFinder(0, size - 7); placeFinder(size - 7, 0);

    for (var ti = 8; ti < size - 8; ti++) {
      var bit = ti % 2 === 0 ? 1 : 0;
      m[6][ti] = bit; m[ti][6] = bit;
    }

    var align = QR_ALIGN[spec.v];
    for (var ai = 0; ai < align.length; ai++) {
      for (var aj = 0; aj < align.length; aj++) {
        var ar = align[ai], ac = align[aj];
        if (m[ar][ac] !== null) continue;
        for (var dr2 = -2; dr2 <= 2; dr2++) {
          for (var dc2 = -2; dc2 <= 2; dc2++) {
            var isRing = Math.abs(dr2) === 2 || Math.abs(dc2) === 2;
            m[ar + dr2][ac + dc2] = (isRing || (dr2 === 0 && dc2 === 0)) ? 1 : 0;
          }
        }
      }
    }

    m[size - 8][8] = 1; // dark module

    for (var f = 0; f < 9; f++) {
      if (m[8][f] === null) m[8][f] = 0;
      if (m[f][8] === null) m[f][8] = 0;
    }
    for (var g = 0; g < 8; g++) {
      if (m[8][size - 1 - g] === null) m[8][size - 1 - g] = 0;
      if (m[size - 1 - g][8] === null) m[size - 1 - g][8] = 0;
    }

    var dataBits = [];
    for (var dcw = 0; dcw < finalCw.length; dcw++) {
      for (var db = 7; db >= 0; db--) dataBits.push((finalCw[dcw] >> db) & 1);
    }

    var bitIndex = 0, upward = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;
      for (var step = 0; step < size; step++) {
        var row2 = upward ? size - 1 - step : step;
        var cols = [col, col - 1];
        for (var ci = 0; ci < 2; ci++) {
          var c2 = cols[ci];
          if (m[row2][c2] !== null) continue;
          var bt = bitIndex < dataBits.length ? dataBits[bitIndex] : 0;
          bitIndex++;
          if ((row2 + c2) % 2 === 0) bt ^= 1; // mask 0
          m[row2][c2] = bt;
        }
      }
      upward = !upward;
    }

    // Format info: ECC-M (00) + mask 0 (000), BCH(15,5), XOR 0x5412.
    var fmtData = (0x0 << 3) | 0x0;
    var rem = fmtData << 10;
    for (var fb = 14; fb >= 10; fb--) {
      if ((rem >> fb) & 1) rem ^= 0x537 << (fb - 10);
    }
    var formatBits = ((fmtData << 10) | rem) ^ 0x5412;

    for (var c3 = 0; c3 <= 5; c3++) m[8][c3] = (formatBits >> c3) & 1;
    m[8][7] = (formatBits >> 6) & 1;
    m[8][8] = (formatBits >> 7) & 1;
    m[7][8] = (formatBits >> 8) & 1;
    for (var r3 = 9; r3 <= 14; r3++) m[14 - r3][8] = (formatBits >> r3) & 1;
    // Bits 0..6 ONLY in the bottom-left column. Bit 7 must NOT go at row
    // size-8: that is the dark module. Writing eight bits here silently
    // clobbers it and the code will not scan.
    for (var r4 = 0; r4 <= 6; r4++) m[size - 1 - r4][8] = (formatBits >> r4) & 1;
    for (var c4 = 7; c4 <= 14; c4++) m[8][size - 15 + c4] = (formatBits >> c4) & 1;

    m[size - 8][8] = 1; // re-assert after format placement

    for (var fy = 0; fy < size; fy++) {
      for (var fx = 0; fx < size; fx++) if (m[fy][fx] === null) m[fy][fx] = 0;
    }
    return m;
  }

  function qrSvg(payload) {
    var m = buildQrMatrix(payload);
    var size = m.length;
    var quiet = 4;
    var dim = size + quiet * 2;
    var rects = "";
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (m[y][x]) rects += '<rect x="' + (x + quiet) + '" y="' + (y + quiet) + '" width="1" height="1"/>';
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + " " + dim +
      '" shape-rendering="crispEdges"><rect width="' + dim + '" height="' + dim +
      '" fill="#fff"/><g fill="#000">' + rects + "</g></svg>";
  }

  // ===========================================================================
  // Config — mirrors nostia-pivot/config/entitlements.json
  // ===========================================================================

  var TIERS = {
    trial: { label: "Trial", adventures: 1, stops: 5, analytics: true, custom_branding: false,
      invite_codes: false, csv_export: false, assist_calls_per_day: 3 },
    standard: { label: "Standard", adventures: 5, stops: 15, analytics: true, custom_branding: true,
      invite_codes: true, csv_export: false, assist_calls_per_day: 20 },
    institutional: { label: "Institutional", adventures: null, stops: null, analytics: true,
      custom_branding: true, invite_codes: true, csv_export: true, assist_calls_per_day: 100 }
  };

  var BOUNDS = {
    radiusMin: 15, radiusMax: 250,
    dwellMin: 15, dwellMax: 600,
    titleChars: 60, textChars: 200, criterionChars: 160, briefChars: 600,
    pointsScale: [25, 50, 100],
    attemptsPerStep: 5,
    smallN: 5
  };

  var DIFFICULTY_POINTS = { easy: 25, medium: 50, advanced: 100 };
  var MODES = ["geo", "photo", "geo_and_photo", "geo_or_photo"];
  var MODE_LABELS = {
    geo: "Geofence only",
    photo: "Photo only",
    geo_and_photo: "Geofence + photo",
    geo_or_photo: "Geofence or photo"
  };

  function requiresPhoto(mode) { return mode === "photo" || mode === "geo_and_photo" || mode === "geo_or_photo"; }
  function requiresGeo(mode) { return mode === "geo" || mode === "geo_and_photo" || mode === "geo_or_photo"; }

  function clampPoints(requested, difficulty) {
    var ceiling = DIFFICULTY_POINTS[difficulty] || 25;
    var n = isFinite(requested) ? Math.floor(requested) : ceiling;
    var allowed = BOUNDS.pointsScale.filter(function (p) { return p <= Math.min(n, ceiling); });
    return allowed.length ? Math.max.apply(null, allowed) : BOUNDS.pointsScale[0];
  }

  // Local POI layer the assistant may choose from. §4.1: the model selects from
  // a supplied candidate list and never names a venue freely — that constraint
  // is what stops it inventing places, so it is preserved even in the mock.
  var BASE_LAT = 42.9814, BASE_LNG = -70.9478;
  var POIS = [
    { name: "Swasey Pavilion", lat: 42.9812, lng: -70.9476, cat: "culture" },
    { name: "String Bridge", lat: 42.9803, lng: -70.9459, cat: "scenic" },
    { name: "Exeter Town Hall", lat: 42.9819, lng: -70.9481, cat: "culture" },
    { name: "The Old Mill", lat: 42.9797, lng: -70.9444, cat: "culture" },
    { name: "Gilman Park Gate", lat: 42.9836, lng: -70.9421, cat: "park" },
    { name: "Water Street Books", lat: 42.9815, lng: -70.9470, cat: "shop" },
    { name: "Founders Park", lat: 42.9808, lng: -70.9452, cat: "park" },
    { name: "Bandstand Green", lat: 42.9822, lng: -70.9488, cat: "park" }
  ];

  var BLOCKED_TERMS = ["firearm", "weapon", "trespass", "break into", "explosive", "assault"];

  function tripsBlocklist(text) {
    var hay = String(text || "").toLowerCase()
      .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e")
      .replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t");
    for (var i = 0; i < BLOCKED_TERMS.length; i++) {
      if (hay.indexOf(BLOCKED_TERMS[i]) !== -1) return BLOCKED_TERMS[i];
    }
    return null;
  }

  // ===========================================================================
  // Mock store
  // ===========================================================================

  var S = null; // in-memory state

  function seed() {
    var orgId = 1;
    var state = {
      org: { id: orgId, name: "Exeter Historical Society", org_type: "institution" },
      subscription: { tier: "standard", status: "active",
        current_period_end: new Date(Date.now() + 30 * 864e5).toISOString() },
      adventures: [],
      steps: [],
      runs: [],
      events: [],
      codes: [],
      nextId: 100,
      me: { id: 9001, name: "You" }
    };

    // --- Published 3-stop adventure, with history so analytics has real numbers.
    var pubId = 1;
    state.adventures.push({
      id: pubId, org_id: orgId, title: "Exeter Riverwalk",
      description: "A short historical loop along the Squamscott.",
      status: "published", version: 1, difficulty: "medium", estimated_minutes: 55,
      requires_membership: 0, unordered: 0, points_award: 50,
      published_at: nowIso(), created_at: nowIso()
    });
    var pubSteps = [
      { title: "Swasey Pavilion", text: "Find the bandstand in the square and stand under it.",
        criterion: "The white bandstand roof and its columns", mode: "geo",
        lat: 42.9812, lng: -70.9476, radius: 60, dwell: 90, ref: null, src: "human" },
      { title: "String Bridge", text: "Walk down to the bridge over the falls.",
        criterion: "The iron railing with the river behind it", mode: "geo_and_photo",
        lat: 42.9803, lng: -70.9459, radius: 45, dwell: 90, ref: "ref/string-bridge.jpg", src: "human" },
      { title: "The Old Mill", text: "Continue to the brick mill building.",
        criterion: "The brick facade with the arched windows", mode: "geo_or_photo",
        lat: 42.9797, lng: -70.9444, radius: 70, dwell: 60, ref: "ref/old-mill.jpg", src: "llm_edited" }
    ];
    pubSteps.forEach(function (s, i) {
      state.steps.push({
        id: state.nextId++, org_adventure_id: pubId, ord: i + 1, title: s.title, text: s.text,
        verify_criterion: s.criterion, verification_mode: s.mode, lat: s.lat, lng: s.lng,
        geofence_radius_m: s.radius, dwell_seconds: s.dwell, reference_image_url: s.ref,
        approved_at: nowIso(), approved_by_user_id: 1, draft_source: s.src
      });
    });

    // Seeded ledger: 7 distinct users so the dashboard clears the small-n
    // threshold of 5 and shows real figures rather than "too few runs".
    var pubStepIds = state.steps.filter(function (s) { return s.org_adventure_id === pubId; })
      .map(function (s) { return s.id; });
    var reachCounts = [7, 6, 4]; // visible drop-off between stop 2 and 3
    for (var u = 0; u < 7; u++) {
      var userId = 5000 + u;
      var runId = state.nextId++;
      state.runs.push({ id: runId, org_adventure_id: pubId, org_adventure_version: 1,
        user_id: userId, outcome: u < 4 ? "completed" : "abandoned", plan_id: state.nextId++ });
      state.events.push({ adv: pubId, ver: 1, run: runId, step: null, user: userId, type: "viewed" });
      state.events.push({ adv: pubId, ver: 1, run: runId, step: null, user: userId, type: "started" });
      for (var st = 0; st < 3; st++) {
        if (u < reachCounts[st]) {
          state.events.push({ adv: pubId, ver: 1, run: runId, step: pubStepIds[st], user: userId, type: "step_arrived" });
          if (u < reachCounts[st] - (st === 1 ? 1 : 0)) {
            state.events.push({ adv: pubId, ver: 1, run: runId, step: pubStepIds[st], user: userId, type: "step_verified" });
          } else {
            state.events.push({ adv: pubId, ver: 1, run: runId, step: pubStepIds[st], user: userId, type: "step_failed" });
          }
        }
      }
      if (u < 4) state.events.push({ adv: pubId, ver: 1, run: runId, step: null, user: userId, type: "completed" });
      else state.events.push({ adv: pubId, ver: 1, run: runId, step: null, user: userId, type: "abandoned" });
      if (u < 3) state.events.push({ adv: pubId, ver: 1, run: runId, step: null, user: userId, type: "rated", rating: 4 + (u % 2) });
      if (u < 2) state.events.push({ adv: pubId, ver: 1, run: runId, step: pubStepIds[0], user: userId, type: "corroborated" });
    }

    // --- Draft that deliberately FAILS preflight, so the inline-failure UI is
    //     visible the moment you open the editor.
    var draftId = 2;
    state.adventures.push({
      id: draftId, org_id: orgId, title: "Academy Orientation Walk",
      description: "Draft — for the incoming class.",
      status: "draft", version: 0, difficulty: "easy", estimated_minutes: 40,
      requires_membership: 1, unordered: 0, points_award: 25, created_at: nowIso()
    });
    state.steps.push({
      id: state.nextId++, org_adventure_id: draftId, ord: 1, title: "Founders Park",
      text: "Meet your group by the park gate.", verify_criterion: "The stone gate posts",
      verification_mode: "geo", lat: 42.9808, lng: -70.9452, geofence_radius_m: 50,
      dwell_seconds: 90, reference_image_url: null,
      approved_at: null, approved_by_user_id: null, draft_source: "human" // unapproved
    });
    state.steps.push({
      id: state.nextId++, org_adventure_id: draftId, ord: 2, title: "Library Steps",
      text: "Photograph the crest above the library door.", verify_criterion: "The carved stone crest",
      verification_mode: "geo_and_photo", lat: 42.9819, lng: -70.9481, geofence_radius_m: 40,
      dwell_seconds: 90, reference_image_url: null, // missing reference
      approved_at: null, approved_by_user_id: null, draft_source: "human"
    });

    // --- Invite codes: one membership grant, one adventure-scoped.
    state.codes.push({ id: state.nextId++, org_id: orgId, org_adventure_id: null,
      code: "H7QMDXCA", max_uses: null, use_count: 12, expires_at: null, revoked_at: null });
    state.codes.push({ id: state.nextId++, org_id: orgId, org_adventure_id: pubId,
      code: "R4WKPYTN", max_uses: 200, use_count: 37, expires_at: null, revoked_at: null });

    return state;
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.adventures) return parsed;
      }
    } catch (e) { /* corrupt or unavailable storage -> reseed */ }
    return seed();
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* private mode */ }
  }

  function resetData() { S = seed(); save(); }

  // ===========================================================================
  // Mock API — mirrors the §10 endpoint shapes AND the real service semantics,
  // so the UI exercises the true contracts rather than a convenient fiction.
  // Synchronous except the two model-backed calls, which fake latency so their
  // loading states are reachable.
  // ===========================================================================

  var api = {};

  api.tier = function () { return TIERS[S.subscription.tier]; };

  api.entitled = function (action) {
    var st = S.subscription.status;
    if (st === "active" || st === "trialing") return { ok: true };
    // §9: a lapsed subscription fails CLOSED on writes, OPEN on reads.
    if (action === "analytics") return { ok: true, degraded: true };
    return { ok: false, reason: st };
  };

  api.listAdventures = function (status) {
    return S.adventures.filter(function (a) { return !status || a.status === status; });
  };

  api.getAdventure = function (id) {
    for (var i = 0; i < S.adventures.length; i++) if (S.adventures[i].id === id) return S.adventures[i];
    return null;
  };

  api.listSteps = function (advId) {
    return S.steps.filter(function (s) { return s.org_adventure_id === advId; })
      .sort(function (a, b) { return a.ord - b.ord; });
  };

  api.getStep = function (id) {
    for (var i = 0; i < S.steps.length; i++) if (S.steps[i].id === id) return S.steps[i];
    return null;
  };

  api.publishedCount = function () {
    return S.adventures.filter(function (a) { return a.status === "published"; }).length;
  };

  api.createAdventure = function (input) {
    var ent = api.entitled("create");
    if (!ent.ok) return { error: "Subscription required (" + ent.reason + ")" };
    var limits = api.tier();
    if (limits.adventures !== null && api.publishedCount() >= limits.adventures) {
      return { error: "Tier limit: " + limits.adventures + " published adventures on " + limits.label };
    }
    var hit = tripsBlocklist(input.title + " " + (input.description || ""));
    if (hit) return { error: "Content blocked (" + hit + ")" };

    var adv = {
      id: S.nextId++, org_id: S.org.id,
      title: input.title, description: input.description || "",
      status: "draft", version: 0,
      difficulty: input.difficulty || "easy",
      estimated_minutes: input.estimated_minutes || 45,
      requires_membership: input.requires_membership ? 1 : 0,
      unordered: input.unordered ? 1 : 0,
      points_award: clampPoints(input.points_award, input.difficulty || "easy"),
      created_at: nowIso()
    };
    S.adventures.push(adv);
    save();
    return { adventure: adv };
  };

  api.updateAdventure = function (id, patch) {
    var adv = api.getAdventure(id);
    if (!adv) return { error: "Not found" };
    if (adv.status === "published") return { error: "Published adventures are immutable - create a revision" };
    var hit = tripsBlocklist((patch.title || "") + " " + (patch.description || ""));
    if (hit) return { error: "Content blocked (" + hit + ")" };
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) adv[k] = patch[k];
    adv.points_award = clampPoints(adv.points_award, adv.difficulty);
    save();
    return { adventure: adv };
  };

  api.validateStep = function (input) {
    var mode = input.verification_mode;
    if (MODES.indexOf(mode) === -1) return "Invalid verification mode";
    if (!input.text) return "Instruction text is required";
    if (input.text.length > BOUNDS.textChars) return "Text exceeds " + BOUNDS.textChars + " characters";
    if (input.verify_criterion.length > BOUNDS.criterionChars) {
      return "Criterion exceeds " + BOUNDS.criterionChars + " characters";
    }
    if (requiresPhoto(mode) && !input.verify_criterion) {
      return "A verify criterion is required when the mode includes a photo";
    }
    var hasCoord = input.lat !== null && isFinite(input.lat) && isFinite(input.lng);
    if (!hasCoord && mode !== "photo") return "Drop a pin, or switch the mode to photo-only";
    if (hasCoord && (input.geofence_radius_m < BOUNDS.radiusMin || input.geofence_radius_m > BOUNDS.radiusMax)) {
      return "Radius must be " + BOUNDS.radiusMin + "-" + BOUNDS.radiusMax + " m";
    }
    if (input.dwell_seconds < BOUNDS.dwellMin || input.dwell_seconds > BOUNDS.dwellMax) {
      return "Dwell must be " + BOUNDS.dwellMin + "-" + BOUNDS.dwellMax + " s";
    }
    var hit = tripsBlocklist(input.title + " " + input.text + " " + input.verify_criterion);
    if (hit) return "Content blocked (" + hit + ")";
    return null;
  };

  api.addStep = function (advId, input) {
    var adv = api.getAdventure(advId);
    if (!adv || adv.status !== "draft") return { error: "Only draft adventures can be edited" };
    var limits = api.tier();
    var count = api.listSteps(advId).length;
    if (limits.stops !== null && count >= limits.stops) {
      return { error: "Tier limit: " + limits.stops + " stops on " + limits.label };
    }
    var err = api.validateStep(input);
    if (err) return { error: err };

    var step = {
      id: S.nextId++, org_adventure_id: advId, ord: count + 1,
      title: input.title, text: input.text, verify_criterion: input.verify_criterion,
      verification_mode: input.verification_mode,
      lat: input.lat, lng: input.lng,
      geofence_radius_m: input.geofence_radius_m, dwell_seconds: input.dwell_seconds,
      reference_image_url: null,
      approved_at: null, approved_by_user_id: null,
      draft_source: input.draft_source || "human"
    };
    S.steps.push(step);
    save();
    return { step: step };
  };

  /* §12 approval integrity: any edit clears approval in the same write.
     Unconditionally - NOT "if something meaningful changed". A conditional
     would itself be a code path that edits and preserves approval, which the
     spec forbids outright. */
  api.updateStep = function (stepId, input) {
    var step = api.getStep(stepId);
    if (!step) return { error: "Not found" };
    var adv = api.getAdventure(step.org_adventure_id);
    if (!adv || adv.status !== "draft") return { error: "Only draft adventures can be edited" };
    var err = api.validateStep(input);
    if (err) return { error: err };

    var wasApproved = !!step.approved_at;
    step.title = input.title;
    step.text = input.text;
    step.verify_criterion = input.verify_criterion;
    step.verification_mode = input.verification_mode;
    step.lat = input.lat;
    step.lng = input.lng;
    step.geofence_radius_m = input.geofence_radius_m;
    step.dwell_seconds = input.dwell_seconds;
    // §4 stage 3: editing an LLM draft flips provenance. This is the
    // measurement that says whether the assistant saved time or made rework.
    if (step.draft_source === "llm_accepted") step.draft_source = "llm_edited";
    step.approved_at = null;
    step.approved_by_user_id = null;
    save();
    return { step: step, approvalCleared: wasApproved };
  };

  api.deleteStep = function (stepId) {
    var step = api.getStep(stepId);
    if (!step) return { error: "Not found" };
    var advId = step.org_adventure_id;
    S.steps = S.steps.filter(function (s) { return s.id !== stepId; });
    api.listSteps(advId).forEach(function (s, i) { s.ord = i + 1; });
    save();
    return { ok: true };
  };

  api.attachReference = function (stepId, filename) {
    var step = api.getStep(stepId);
    if (!step) return { error: "Not found" };
    step.reference_image_url = "ref/" + (filename || "reference.jpg");
    // Attaching a reference is an edit, so it clears approval like any other.
    var wasApproved = !!step.approved_at;
    step.approved_at = null;
    step.approved_by_user_id = null;
    save();
    return { ok: true, approvalCleared: wasApproved };
  };

  api.approveStep = function (stepId) {
    var step = api.getStep(stepId);
    if (!step) return { error: "Not found" };
    if (requiresPhoto(step.verification_mode) && !step.reference_image_url) {
      return { error: "Upload a reference image before approving a photo stop" };
    }
    if (requiresGeo(step.verification_mode) && (step.lat === null || !isFinite(step.lat))) {
      return { error: "Drop a pin before approving a geofenced stop" };
    }
    step.approved_at = nowIso();
    step.approved_by_user_id = S.me.id;
    save();
    return { step: step };
  };

  /* §13.1 preflight. Returns ALL failures, not the first - an admin fixing a
     12-stop tour one error per round trip is §15's "authoring effort exceeds
     org tolerance" risk, made worse by us. */
  api.preflight = function (advId) {
    var out = [];
    var adv = api.getAdventure(advId);
    if (!adv) return [{ text: "Adventure not found" }];
    if (adv.status !== "draft") out.push({ text: "Already " + adv.status });

    if (!api.entitled("publish").ok) out.push({ text: "Subscription is " + S.subscription.status });

    var steps = api.listSteps(advId);
    if (!steps.length) out.push({ text: "Add at least one stop" });

    steps.forEach(function (s) {
      var where = "Stop " + s.ord + " (" + (s.title || "untitled") + ")";
      if (!s.approved_at) out.push({ text: where + " - not approved", stepId: s.id });
      if (requiresPhoto(s.verification_mode) && !s.reference_image_url) {
        out.push({ text: where + " - missing reference image", stepId: s.id });
      }
      if (requiresGeo(s.verification_mode)) {
        if (s.lat === null || !isFinite(s.lat)) {
          out.push({ text: where + " - missing coordinate", stepId: s.id });
        } else if (s.geofence_radius_m < BOUNDS.radiusMin || s.geofence_radius_m > BOUNDS.radiusMax) {
          out.push({ text: where + " - radius out of bounds", stepId: s.id });
        }
      }
      if (s.dwell_seconds < BOUNDS.dwellMin || s.dwell_seconds > BOUNDS.dwellMax) {
        out.push({ text: where + " - dwell out of bounds", stepId: s.id });
      }
    });

    var limits = api.tier();
    if (limits.stops !== null && steps.length > limits.stops) {
      out.push({ text: "Too many stops for " + limits.label + " (" + steps.length + " > " + limits.stops + ")" });
    }
    if (limits.adventures !== null && api.publishedCount() >= limits.adventures) {
      out.push({ text: "Published-adventure limit reached on " + limits.label });
    }
    return out;
  };

  api.publish = function (advId) {
    var fails = api.preflight(advId);
    if (fails.length) return { error: "Preflight failed", failures: fails };
    var adv = api.getAdventure(advId);
    adv.status = "published";
    adv.version += 1;
    adv.published_at = nowIso();
    save();
    return { adventure: adv };
  };

  api.archive = function (advId) {
    var adv = api.getAdventure(advId);
    if (!adv) return { error: "Not found" };
    adv.status = "archived";
    save();
    return { adventure: adv };
  };

  /* §4 stage 8: revising a published adventure creates a NEW draft. The live
     one keeps serving runners and printed QR codes while the draft is edited,
     and approval does NOT carry over - a revision is new content. */
  api.revise = function (advId) {
    var adv = api.getAdventure(advId);
    if (!adv || adv.status !== "published") return { error: "Only a published adventure can be revised" };
    var copy = JSON.parse(JSON.stringify(adv));
    copy.id = S.nextId++;
    copy.status = "draft";
    copy.created_at = nowIso();
    delete copy.published_at;
    S.adventures.push(copy);
    api.listSteps(advId).forEach(function (s) {
      var c = JSON.parse(JSON.stringify(s));
      c.id = S.nextId++;
      c.org_adventure_id = copy.id;
      c.approved_at = null;
      c.approved_by_user_id = null;
      S.steps.push(c);
    });
    save();
    return { adventure: copy };
  };

  // --- Invite codes (§7) ----------------------------------------------------

  var CODE_ALPHABET = "34679ACDEFGHJKMNPQRTUVWXY"; // ambiguous glyphs excluded

  api.mintCode = function (advId, maxUses) {
    if (!api.tier().invite_codes) {
      return { error: "Invite codes require a paid tier (currently " + api.tier().label + ")" };
    }
    var code = "";
    for (var i = 0; i < 8; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    var row = { id: S.nextId++, org_id: S.org.id, org_adventure_id: advId || null,
      code: code, max_uses: maxUses || null, use_count: 0, expires_at: null, revoked_at: null };
    S.codes.push(row);
    save();
    return { code: row };
  };

  api.revokeCode = function (id) {
    for (var i = 0; i < S.codes.length; i++) {
      if (S.codes[i].id === id) { S.codes[i].revoked_at = nowIso(); save(); return { ok: true }; }
    }
    return { error: "Not found" };
  };

  api.codeLink = function (code) { return "https://api.nostia.io/i/" + code; };

  // --- Analytics (§8) -------------------------------------------------------

  function distinctUsers(advId, ver, type, stepId) {
    var seen = {};
    S.events.forEach(function (e) {
      if (e.adv !== advId || e.ver !== ver || e.type !== type) return;
      if (stepId !== undefined && e.step !== stepId) return;
      seen[e.user] = 1;
    });
    return Object.keys(seen).length;
  }

  function countEvents(advId, ver, type, stepId) {
    return S.events.filter(function (e) {
      return e.adv === advId && e.ver === ver && e.type === type &&
        (stepId === undefined || e.step === stepId);
    }).length;
  }

  /* §8 small-n suppression: below 5 distinct users an aggregate is
     re-identifiable on a small campus, so the cell is withheld rather than
     rendered as a misleading zero. */
  function suppress(n, value) {
    return n < BOUNDS.smallN ? { suppressed: true } : value;
  }

  api.analytics = function (advId) {
    var adv = api.getAdventure(advId);
    if (!adv) return null;
    var ver = adv.version;

    var runs = S.runs.filter(function (r) {
      return r.org_adventure_id === advId && r.org_adventure_version === ver;
    });
    var starters = {};
    runs.forEach(function (r) { starters[r.user_id] = 1; });
    var startCount = Object.keys(starters).length;
    var completed = runs.filter(function (r) { return r.outcome === "completed"; }).length;
    var viewCount = distinctUsers(advId, ver, "viewed");

    var perStop = [];
    var prevReached = null;
    api.listSteps(advId).forEach(function (s) {
      var reached = distinctUsers(advId, ver, "step_arrived", s.id);
      var verified = distinctUsers(advId, ver, "step_verified", s.id);
      var failed = countEvents(advId, ver, "step_failed", s.id);
      var verifiedEvents = countEvents(advId, ver, "step_verified", s.id);
      perStop.push({
        id: s.id, ord: s.ord, title: s.title || ("Stop " + s.ord),
        reachedRaw: reached,
        reached: suppress(reached, reached),
        verified: suppress(verified, verified),
        dropOff: prevReached === null ? null
          : suppress(Math.max(reached, prevReached), { n: reached, denom: prevReached }),
        failRatio: suppress(verified, { n: failed, denom: verifiedEvents || 1 })
      });
      prevReached = reached;
    });

    var ratings = S.events.filter(function (e) {
      return e.adv === advId && e.ver === ver && e.type === "rated";
    }).map(function (e) { return e.rating; });
    var medianRating = null;
    if (ratings.length) {
      ratings.sort(function (a, b) { return a - b; });
      medianRating = ratings[Math.floor(ratings.length / 2)];
    }

    var corrRuns = {};
    S.events.forEach(function (e) {
      if (e.adv === advId && e.ver === ver && e.type === "corroborated") corrRuns[e.run] = 1;
    });

    return {
      adventure: adv,
      threshold: BOUNDS.smallN,
      views: suppress(viewCount, viewCount),
      starts: suppress(startCount, startCount),
      completion: suppress(startCount, { n: completed, denom: runs.length }),
      corroborated: suppress(startCount, Object.keys(corrRuns).length),
      medianRating: suppress(ratings.length, medianRating),
      perStop: perStop
    };
  };

  // ===========================================================================
  // Dummy AI — the two model-backed features. Both canned; nothing leaves the
  // browser. Latency is faked so their loading states are actually reachable.
  // ===========================================================================

  /* §4.1 authoring assistant. The rule that matters is preserved: the model may
     ONLY select from a supplied candidate list and never names a venue freely -
     free-naming is how the consumer pipeline invents places that do not exist.
     Output is a DRAFT: unapproved, marked llm_accepted. */
  api.assist = function (brief, stopCount, cb) {
    function fail(msg) { setTimeout(function () { cb({ error: msg }); }, 250); }

    var hit = tripsBlocklist(brief);
    // Input pass of the dual-pass filter - rejected before any "model" call, so
    // it consumes no quota. An org admin is not a trusted prompt source.
    if (hit) return fail("Brief blocked (" + hit + ") - nothing was sent");
    if (!brief || brief.length < 8) return fail("Describe the tour first");
    if (brief.length > BOUNDS.briefChars) return fail("Brief is too long");

    setTimeout(function () {
      var picked = POIS.slice(0, Math.min(stopCount, POIS.length));
      var verbs = ["Make your way to", "Head over to", "Continue on to", "Find your way to"];
      cb({
        stops: picked.map(function (p, i) {
          return {
            title: p.name,
            text: verbs[i % verbs.length] + " " + p.name + " and take a look around.",
            verify_criterion: "A photo clearly showing " + p.name,
            lat: p.lat, lng: p.lng
          };
        })
      });
    }, 1100);
  };

  /* §5 photo judge. The run view picks the verdict explicitly so every
     downstream UI state is reachable on demand instead of by luck. Note there
     are FIVE verdicts, not three: 'unsafe' and 'unjudged' exist in the live
     service and the spec's three-verdict contract omits both. */
  api.judge = function (forced, cb) {
    var reasons = {
      pass: "Matched the reference: brick facade and arched windows both located.",
      fail: "Could not find the reference subject - this looks like an interior wall.",
      inconclusive: "The judge did not respond. Your attempt was not counted.",
      unsafe: "This photo was rejected by the safety screen.",
      unjudged: "Photo accepted without judging (judge is off)."
    };
    setTimeout(function () {
      cb({
        verdict: forced,
        reason: reasons[forced],
        matched_on: forced === "pass" ? ["brick facade", "arched windows"] : []
      });
    }, 900);
  };

  // ===========================================================================
  // Shell / router
  // ===========================================================================

  var root = null;
  var route = { name: "list", params: {} };
  var sheet = null;    // open sheet descriptor, or null
  var runSim = null;   // runner simulation state
  var simTimer = null;

  function go(name, params) {
    if (name !== "run") stopSim();
    route = { name: name, params: params || {} };
    sheet = null;
    render();
  }

  function toast(msg) {
    var t = el("div", { class: "np-toast", text: msg });
    root.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2300);
  }

  function header(title, sub, backTo) {
    return el("div", { class: "np-header" }, [
      backTo ? el("button", {
        class: "np-btn np-btn-ghost np-btn-sm", text: "←",
        "aria-label": "Back",
        on: { click: function () { go(backTo.name, backTo.params); } }
      }) : null,
      el("div", { class: "np-title" }, [
        document.createTextNode(title),
        sub ? el("div", { class: "np-sub", text: sub }) : null
      ]),
      el("button", {
        class: "np-btn np-btn-ghost np-btn-sm", text: "Close",
        on: { click: close_ }
      })
    ]);
  }

  function tabs() {
    var items = [
      { id: "list", ico: "▦", label: "Adventures" },
      { id: "analytics", ico: "◧", label: "Analytics" },
      { id: "invites", ico: "⌗", label: "Invites" },
      { id: "billing", ico: "◎", label: "Billing" }
    ];
    var active = route.name;
    if (active === "editor" || active === "stop" || active === "run") active = "list";
    return el("div", { class: "np-tabs" }, items.map(function (it) {
      return el("button", {
        class: active === it.id ? "on" : "",
        on: { click: function () { go(it.id); } }
      }, [
        el("span", { class: "np-tab-ico", text: it.ico }),
        document.createTextNode(it.label)
      ]);
    }));
  }

  function statusPill(status) {
    return el("span", { class: "np-pill np-pill-" + status, text: status });
  }

  function field(labelText, control, hint) {
    return el("div", { class: "np-field" }, [
      el("label", { class: "np-label", text: labelText }),
      control,
      hint ? el("div", { class: "np-hint", text: hint }) : null
    ]);
  }

  function row(label, value) {
    return el("div", { class: "np-row" }, [
      el("span", { class: "np-row-label", text: label }),
      el("span", { class: "np-row-value", text: value })
    ]);
  }

  function segmented(options, current, onPick) {
    return el("div", { class: "np-seg" }, options.map(function (o) {
      return el("button", {
        class: o.value === current ? "on" : "",
        text: o.label,
        on: { click: function () { onPick(o.value); } }
      });
    }));
  }

  // ---------------------------------------------------------------------------
  // Mock map. No tiles, no network — a CSS grid with projected pins. Enough to
  // place a coordinate and see a geofence radius, which is all §11's
  // "map pin + radius slider" needs for a design review.
  // ---------------------------------------------------------------------------

  var MAP_SPAN = 0.010; // degrees of latitude across the box

  function mapBox(opts) {
    var box = el("div", { class: "np-map" });
    var w = 0, h = 170;
    var centerLat = opts.centerLat, centerLng = opts.centerLng;

    function project(lat, lng) {
      var lngSpan = MAP_SPAN / Math.cos(centerLat * Math.PI / 180);
      return {
        x: ((lng - centerLng) / lngSpan + 0.5) * (w || 1),
        y: (0.5 - (lat - centerLat) / MAP_SPAN) * h
      };
    }
    function unproject(px, py) {
      var lngSpan = MAP_SPAN / Math.cos(centerLat * Math.PI / 180);
      return {
        lat: centerLat + (0.5 - py / h) * MAP_SPAN,
        lng: centerLng + (px / (w || 1) - 0.5) * lngSpan
      };
    }

    box.appendChild(el("div", { class: "np-map-note", text: opts.note || "Schematic — not a real map" }));

    function paint() {
      w = box.clientWidth || 320;
      // Remove previously painted markers but keep the note.
      var olds = box.querySelectorAll(".np-map-pin, .np-map-fence, .np-map-me");
      for (var i = 0; i < olds.length; i++) olds[i].parentNode.removeChild(olds[i]);

      (opts.pins || []).forEach(function (p) {
        var pt = project(p.lat, p.lng);
        if (p.radius) {
          // metres -> px using the vertical scale (h px == MAP_SPAN degrees lat)
          var mPerDeg = 111320;
          var pxPerM = (h / MAP_SPAN) / mPerDeg;
          var d = Math.max(8, p.radius * pxPerM * 2);
          box.appendChild(el("div", {
            class: "np-map-fence",
            style: "left:" + pt.x + "px;top:" + pt.y + "px;width:" + d + "px;height:" + d + "px"
          }));
        }
        box.appendChild(el("div", {
          class: "np-map-pin",
          style: "left:" + pt.x + "px;top:" + pt.y + "px" + (p.dim ? ";opacity:.45" : "")
        }));
      });

      if (opts.me) {
        var mp = project(opts.me.lat, opts.me.lng);
        box.appendChild(el("div", { class: "np-map-me", style: "left:" + mp.x + "px;top:" + mp.y + "px" }));
      }
    }

    if (opts.onPick) {
      box.addEventListener("click", function (ev) {
        var r = box.getBoundingClientRect();
        w = box.clientWidth;
        var c = unproject(ev.clientX - r.left, ev.clientY - r.top);
        opts.onPick(c.lat, c.lng);
      });
    }

    // clientWidth is 0 until layout, so paint on the next frame too.
    setTimeout(paint, 0);
    paint();
    return box;
  }

  // ===========================================================================
  // VIEW: OrgAdventureListView
  // ===========================================================================

  var listFilter = "";

  function viewList() {
    var wrap = el("div", { class: "np-wrap" });
    wrap.appendChild(header(S.org.name, "Sponsored adventures"));

    var limits = api.tier();
    var used = api.publishedCount();
    wrap.appendChild(el("div", { class: "np-card" }, [
      el("div", { class: "np-card-head" }, [
        el("div", {}, [
          el("div", { class: "np-card-title", text: limits.label + " plan" }),
          el("div", {
            class: "np-card-meta",
            text: used + " of " + (limits.adventures === null ? "unlimited" : limits.adventures) +
              " published · up to " + (limits.stops === null ? "unlimited" : limits.stops) + " stops each"
          })
        ]),
        el("span", {
          class: "np-pill " + (S.subscription.status === "active" ? "np-pill-ok" : "np-pill-bad"),
          text: S.subscription.status
        })
      ])
    ]));

    wrap.appendChild(segmented([
      { value: "", label: "All" },
      { value: "draft", label: "Draft" },
      { value: "published", label: "Live" },
      { value: "archived", label: "Archived" }
    ], listFilter, function (v) { listFilter = v; render(); }));

    var list = api.listAdventures(listFilter);
    if (!list.length) {
      wrap.appendChild(el("div", { class: "np-empty", text: "Nothing here yet." }));
    }
    list.forEach(function (adv) {
      var steps = api.listSteps(adv.id);
      var approved = steps.filter(function (s) { return !!s.approved_at; }).length;
      wrap.appendChild(el("button", { class: "np-card np-card-tap", on: { click: function () { go("editor", { id: adv.id }); } } }, [
        el("div", { class: "np-card-head" }, [
          el("div", {}, [
            el("div", { class: "np-card-title", text: adv.title }),
            el("div", {
              class: "np-card-meta",
              text: steps.length + " stops · " + approved + " approved · " +
                adv.difficulty + " · " + adv.points_award + " pts" +
                (adv.status === "published" ? " · v" + adv.version : "")
            })
          ]),
          statusPill(adv.status)
        ])
      ]));
    });

    wrap.appendChild(el("button", {
      class: "np-btn np-btn-block", text: "New adventure",
      on: { click: function () { openCreateSheet(); } }
    }));

    wrap.appendChild(el("div", { class: "np-note", text: "Everything in this preview is mock data held in your browser. Nothing is sent anywhere." }));
    wrap.appendChild(el("button", {
      class: "np-btn np-btn-ghost np-btn-sm", text: "Reset preview data",
      on: { click: function () { resetData(); go("list"); toast("Preview data reset"); } }
    }));

    return wrap;
  }

  function openCreateSheet() {
    var titleIn = el("input", { class: "np-input", placeholder: "Riverside history walk", maxlength: 80 });
    var descIn = el("textarea", { class: "np-textarea", placeholder: "One or two lines for the runner." });
    var diff = "easy";
    var diffSeg = el("div");
    function paintDiff() {
      clear(diffSeg);
      diffSeg.appendChild(segmented([
        { value: "easy", label: "Easy 25" },
        { value: "medium", label: "Medium 50" },
        { value: "advanced", label: "Advanced 100" }
      ], diff, function (v) { diff = v; paintDiff(); }));
    }
    paintDiff();

    sheet = {
      title: "New adventure",
      body: [
        field("Title", titleIn),
        field("Description", descIn),
        field("Difficulty", diffSeg, "Difficulty caps the points award (25 / 50 / 100)."),
        el("button", {
          class: "np-btn np-btn-block", text: "Create draft",
          on: {
            click: function () {
              var t = titleIn.value.trim();
              if (!t) { toast("Give it a title"); return; }
              var res = api.createAdventure({
                title: t, description: descIn.value.trim(),
                difficulty: diff, points_award: DIFFICULTY_POINTS[diff]
              });
              if (res.error) { toast(res.error); return; }
              go("editor", { id: res.adventure.id });
              toast("Draft created");
            }
          }
        })
      ]
    };
    render();
  }

  // ===========================================================================
  // VIEW: OrgAdventureEditorView
  // ===========================================================================

  function viewEditor() {
    var adv = api.getAdventure(route.params.id);
    if (!adv) { go("list"); return el("div"); }
    var isDraft = adv.status === "draft";
    var steps = api.listSteps(adv.id);

    var wrap = el("div", { class: "np-wrap" });
    wrap.appendChild(header(adv.title, adv.status + (adv.version ? " · v" + adv.version : ""), { name: "list" }));

    // §11: preflight failures shown INLINE in the editor.
    if (isDraft) {
      var fails = api.preflight(adv.id);
      if (fails.length) {
        wrap.appendChild(el("div", { class: "np-preflight" }, [
          el("div", { class: "np-preflight-title", text: "Cannot publish yet — " + fails.length + " to fix" }),
          el("ul", {}, fails.map(function (f) {
            return el("li", {}, [
              document.createTextNode("• " + f.text),
              f.stepId ? el("button", {
                class: "np-btn np-btn-ghost np-btn-sm", text: "Fix",
                style: "margin-left:8px",
                on: { click: function () { go("stop", { advId: adv.id, stepId: f.stepId }); } }
              }) : null
            ]);
          }))
        ]));
      } else {
        wrap.appendChild(el("div", { class: "np-card" }, [
          el("span", { class: "np-pill np-pill-ok", text: "preflight clean" })
        ]));
      }
    }

    // --- Metadata
    wrap.appendChild(el("div", { class: "np-section-title", text: "Details" }));
    if (isDraft) {
      var titleIn = el("input", { class: "np-input", value: adv.title, maxlength: 80 });
      var descIn = el("textarea", { class: "np-textarea" });
      descIn.value = adv.description || "";
      var minsIn = el("input", { class: "np-input", type: "number", value: adv.estimated_minutes, min: 5, max: 600 });

      var diffHolder = el("div");
      function paintDiff2() {
        clear(diffHolder);
        diffHolder.appendChild(segmented([
          { value: "easy", label: "Easy" },
          { value: "medium", label: "Medium" },
          { value: "advanced", label: "Advanced" }
        ], adv.difficulty, function (v) {
          api.updateAdventure(adv.id, { difficulty: v, points_award: DIFFICULTY_POINTS[v] });
          render();
        }));
      }
      paintDiff2();

      wrap.appendChild(field("Title", titleIn));
      wrap.appendChild(field("Description", descIn));
      wrap.appendChild(field("Difficulty", diffHolder,
        "Points are clamped server-side to 25 / 50 / 100 — currently " + adv.points_award + "."));
      wrap.appendChild(field("Estimated minutes", minsIn));

      wrap.appendChild(el("div", { class: "np-card" }, [
        el("div", { class: "np-row" }, [
          el("span", { class: "np-row-label", text: "Requires membership" }),
          el("button", {
            class: "np-btn np-btn-ghost np-btn-sm",
            text: adv.requires_membership ? "Member-only" : "Open to anyone",
            on: {
              click: function () {
                api.updateAdventure(adv.id, { requires_membership: adv.requires_membership ? 0 : 1 });
                render();
              }
            }
          })
        ]),
        el("div", { class: "np-row" }, [
          el("span", { class: "np-row-label", text: "Stop order" }),
          el("button", {
            class: "np-btn np-btn-ghost np-btn-sm",
            text: adv.unordered ? "Any order" : "In order",
            on: {
              click: function () {
                api.updateAdventure(adv.id, { unordered: adv.unordered ? 0 : 1 });
                render();
              }
            }
          })
        ])
      ]));

      wrap.appendChild(el("button", {
        class: "np-btn np-btn-ghost np-btn-sm", text: "Save details",
        on: {
          click: function () {
            var res = api.updateAdventure(adv.id, {
              title: titleIn.value.trim() || adv.title,
              description: descIn.value.trim(),
              estimated_minutes: parseInt(minsIn.value, 10) || adv.estimated_minutes
            });
            if (res.error) { toast(res.error); return; }
            render();
            toast("Saved");
          }
        }
      }));
    } else {
      wrap.appendChild(el("div", { class: "np-card" }, [
        row("Difficulty", adv.difficulty),
        row("Points", String(adv.points_award)),
        row("Access", adv.requires_membership ? "Member-only" : "Open"),
        row("Order", adv.unordered ? "Any order" : "In order"),
        row("Version", "v" + adv.version)
      ]));
      wrap.appendChild(el("div", { class: "np-note", text: "A published adventure is immutable. Revise it to create a new draft version — in-flight runs keep the version they started on." }));
    }

    // --- Stops
    wrap.appendChild(el("div", { class: "np-section-title", text: "Stops (" + steps.length + ")" }));
    if (!steps.length) wrap.appendChild(el("div", { class: "np-empty", text: "No stops yet." }));

    steps.forEach(function (s) {
      var problems = [];
      if (!s.approved_at) problems.push("unapproved");
      if (requiresPhoto(s.verification_mode) && !s.reference_image_url) problems.push("no reference");
      wrap.appendChild(el("button", {
        class: "np-stop",
        on: { click: function () { go("stop", { advId: adv.id, stepId: s.id }); } }
      }, [
        el("div", { class: "np-stop-ord " + (s.approved_at ? "done" : ""), text: String(s.ord) }),
        el("div", { class: "np-stop-body" }, [
          el("div", { class: "np-stop-title", text: s.title || "Untitled stop" }),
          el("div", {
            class: "np-stop-meta",
            text: MODE_LABELS[s.verification_mode] +
              (s.geofence_radius_m ? " · " + s.geofence_radius_m + " m" : "") +
              " · " + s.dwell_seconds + " s" +
              (s.draft_source !== "human" ? " · " + s.draft_source : "")
          }),
          problems.length
            ? el("div", { style: "margin-top:6px" }, problems.map(function (p) {
                return el("span", { class: "np-pill np-pill-bad", text: p, style: "margin-right:5px" });
              }))
            : el("div", { style: "margin-top:6px" }, [el("span", { class: "np-pill np-pill-ok", text: "approved" })])
        ])
      ]));
    });

    if (isDraft) {
      wrap.appendChild(el("div", { class: "np-btn-row" }, [
        el("button", {
          class: "np-btn np-btn-ghost", text: "Add stop",
          on: { click: function () { go("stop", { advId: adv.id, stepId: null }); } }
        }),
        el("button", {
          class: "np-btn np-btn-ghost", text: "✦ Draft with assistant",
          on: { click: function () { openAssistSheet(adv.id); } }
        })
      ]));
    }

    // --- Actions
    wrap.appendChild(el("div", { class: "np-section-title", text: "Actions" }));
    var actions = [];
    if (isDraft) {
      var clean = api.preflight(adv.id).length === 0;
      actions.push(el("button", {
        class: "np-btn np-btn-block", text: "Publish", disabled: !clean,
        on: {
          click: function () {
            var res = api.publish(adv.id);
            if (res.error) { toast(res.error); render(); return; }
            render();
            toast("Published as v" + res.adventure.version);
          }
        }
      }));
      if (!clean) actions.push(el("div", { class: "np-hint", text: "Publish unlocks when every item above is fixed." }));
    }
    if (adv.status === "published") {
      actions.push(el("button", {
        class: "np-btn np-btn-block", text: "Preview as runner",
        on: { click: function () { go("run", { id: adv.id }); } }
      }));
      actions.push(el("button", {
        class: "np-btn np-btn-ghost np-btn-block", text: "Create revision",
        on: {
          click: function () {
            var res = api.revise(adv.id);
            if (res.error) { toast(res.error); return; }
            go("editor", { id: res.adventure.id });
            toast("New draft created — approvals cleared");
          }
        }
      }));
      actions.push(el("button", {
        class: "np-btn np-btn-ghost np-btn-block", text: "View analytics",
        on: { click: function () { go("analytics", { id: adv.id }); } }
      }));
      actions.push(el("button", {
        class: "np-btn np-btn-danger np-btn-block", text: "Archive",
        on: { click: function () { api.archive(adv.id); render(); toast("Archived — in-flight runs continue"); } }
      }));
    }
    actions.forEach(function (a) { wrap.appendChild(a); });

    return wrap;
  }

  // ===========================================================================
  // VIEW: OrgStopEditorView
  // ===========================================================================

  function viewStopEditor() {
    var advId = route.params.advId;
    var adv = api.getAdventure(advId);
    var existing = route.params.stepId ? api.getStep(route.params.stepId) : null;
    if (!adv) { go("list"); return el("div"); }

    // Working copy — nothing is written until Save, so the approval-clearing
    // rule fires exactly once, on an actual edit.
    var draft = existing ? {
      title: existing.title, text: existing.text, verify_criterion: existing.verify_criterion,
      verification_mode: existing.verification_mode, lat: existing.lat, lng: existing.lng,
      geofence_radius_m: existing.geofence_radius_m || 60, dwell_seconds: existing.dwell_seconds
    } : {
      title: "", text: "", verify_criterion: "", verification_mode: "geo_and_photo",
      lat: BASE_LAT, lng: BASE_LNG, geofence_radius_m: 60, dwell_seconds: 90
    };

    var wrap = el("div", { class: "np-wrap" });
    wrap.appendChild(header(existing ? "Stop " + existing.ord : "New stop",
      adv.title, { name: "editor", params: { id: advId } }));

    if (existing && existing.approved_at) {
      wrap.appendChild(el("div", { class: "np-card" }, [
        el("span", { class: "np-pill np-pill-ok", text: "approved" }),
        el("div", { class: "np-hint", text: "Saving any change here clears this approval. That is deliberate — approval is per-version of the text a human actually read." })
      ]));
    }

    var titleIn = el("input", { class: "np-input", value: draft.title, maxlength: BOUNDS.titleChars });
    wrap.appendChild(field("Stop name", titleIn));

    var textIn = el("textarea", { class: "np-textarea", maxlength: BOUNDS.textChars });
    textIn.value = draft.text;
    var textCount = el("span", { class: "np-counter", text: draft.text.length + "/" + BOUNDS.textChars });
    textIn.addEventListener("input", function () {
      textCount.textContent = textIn.value.length + "/" + BOUNDS.textChars;
    });
    var textLabel = el("label", { class: "np-label" }, [document.createTextNode("Instruction"), textCount]);
    wrap.appendChild(el("div", { class: "np-field" }, [textLabel, textIn]));

    var critIn = el("textarea", { class: "np-textarea", maxlength: BOUNDS.criterionChars });
    critIn.value = draft.verify_criterion;
    var critCount = el("span", { class: "np-counter", text: draft.verify_criterion.length + "/" + BOUNDS.criterionChars });
    critIn.addEventListener("input", function () {
      critCount.textContent = critIn.value.length + "/" + BOUNDS.criterionChars;
    });
    var critLabel = el("label", { class: "np-label" }, [document.createTextNode("Verify criterion"), critCount]);
    wrap.appendChild(el("div", { class: "np-field" }, [
      critLabel, critIn,
      el("div", { class: "np-hint", text: "What a correct photo should visibly contain. Concrete and checkable beats subjective." })
    ]));

    // --- Verification mode
    var modeHolder = el("div");
    var mapHolder = el("div");
    var radiusHolder = el("div");

    function paintMap() {
      clear(mapHolder);
      if (!requiresGeo(draft.verification_mode)) {
        mapHolder.appendChild(el("div", { class: "np-note", text: "Photo-only stops need no coordinate." }));
        return;
      }
      mapHolder.appendChild(el("label", { class: "np-label", text: "Location — tap to move the pin" }));
      mapHolder.appendChild(mapBox({
        centerLat: draft.lat || BASE_LAT, centerLng: draft.lng || BASE_LNG,
        pins: [{ lat: draft.lat, lng: draft.lng, radius: draft.geofence_radius_m }],
        onPick: function (lat, lng) { draft.lat = lat; draft.lng = lng; paintMap(); }
      }));
      mapHolder.appendChild(el("div", {
        class: "np-hint np-mono",
        text: draft.lat.toFixed(5) + ", " + draft.lng.toFixed(5)
      }));
    }

    function paintRadius() {
      clear(radiusHolder);
      if (!requiresGeo(draft.verification_mode)) return;
      var rIn = el("input", {
        class: "np-range", type: "range",
        min: BOUNDS.radiusMin, max: BOUNDS.radiusMax, value: draft.geofence_radius_m, step: 5
      });
      var rLab = el("div", { class: "np-hint", text: draft.geofence_radius_m + " m geofence" });
      rIn.addEventListener("input", function () {
        draft.geofence_radius_m = parseInt(rIn.value, 10);
        rLab.textContent = draft.geofence_radius_m + " m geofence";
        paintMap();
      });
      radiusHolder.appendChild(el("div", { class: "np-field" }, [
        el("label", { class: "np-label", text: "Geofence radius" }), rIn, rLab
      ]));

      var dIn = el("input", {
        class: "np-range", type: "range",
        min: BOUNDS.dwellMin, max: 300, value: draft.dwell_seconds, step: 5
      });
      var dLab = el("div", { class: "np-hint", text: draft.dwell_seconds + " s continuous presence" });
      dIn.addEventListener("input", function () {
        draft.dwell_seconds = parseInt(dIn.value, 10);
        dLab.textContent = draft.dwell_seconds + " s continuous presence";
      });
      radiusHolder.appendChild(el("div", { class: "np-field" }, [
        el("label", { class: "np-label", text: "Dwell time" }), dIn, dLab
      ]));
    }

    function paintMode() {
      clear(modeHolder);
      modeHolder.appendChild(el("label", { class: "np-label", text: "Verification" }));
      modeHolder.appendChild(segmented([
        { value: "geo", label: "Geo" },
        { value: "photo", label: "Photo" },
        { value: "geo_and_photo", label: "Both" },
        { value: "geo_or_photo", label: "Either" }
      ], draft.verification_mode, function (v) {
        draft.verification_mode = v;
        paintMode(); paintMap(); paintRadius();
      }));
      modeHolder.appendChild(el("div", { class: "np-hint", text: MODE_LABELS[draft.verification_mode] }));
    }

    paintMode(); paintMap(); paintRadius();
    wrap.appendChild(modeHolder);
    wrap.appendChild(mapHolder);
    wrap.appendChild(radiusHolder);

    // --- Reference image (§5)
    if (existing) {
      wrap.appendChild(el("div", { class: "np-section-title", text: "Reference photo" }));
      var refCard = el("div", { class: "np-card" }, [
        el("div", { class: "np-row" }, [
          el("span", { class: "np-row-label", text: "Reference" }),
          el("span", {
            class: "np-pill " + (existing.reference_image_url ? "np-pill-ok" : "np-pill-bad"),
            text: existing.reference_image_url ? "uploaded" : "missing"
          })
        ]),
        el("div", { class: "np-hint", text: "The ground truth the judge compares against. Required when the mode includes a photo. Never served to the app — it exists server-side for the judge only." })
      ]);
      var fileIn = el("input", { type: "file", accept: "image/*", style: "display:none" });
      fileIn.addEventListener("change", function () {
        var name = fileIn.files && fileIn.files[0] ? fileIn.files[0].name : "reference.jpg";
        // Nothing is uploaded or read — the preview records the filename only.
        var res = api.attachReference(existing.id, name);
        render();
        toast(res.approvalCleared ? "Reference attached — approval cleared" : "Reference attached");
      });
      refCard.appendChild(fileIn);
      refCard.appendChild(el("button", {
        class: "np-btn np-btn-ghost np-btn-sm",
        text: existing.reference_image_url ? "Replace reference" : "Upload reference",
        on: { click: function () { fileIn.click(); } }
      }));
      wrap.appendChild(refCard);
    }

    // --- Save / approve / delete
    wrap.appendChild(el("div", { class: "np-section-title", text: "Actions" }));

    wrap.appendChild(el("button", {
      class: "np-btn np-btn-block", text: existing ? "Save stop" : "Add stop",
      on: {
        click: function () {
          draft.title = titleIn.value.trim();
          draft.text = textIn.value.trim();
          draft.verify_criterion = critIn.value.trim();
          if (!requiresGeo(draft.verification_mode)) { draft.lat = null; draft.lng = null; }
          var res = existing ? api.updateStep(existing.id, draft) : api.addStep(advId, draft);
          if (res.error) { toast(res.error); return; }
          if (existing) {
            go("stop", { advId: advId, stepId: existing.id });
            toast(res.approvalCleared ? "Saved — approval cleared" : "Saved");
          } else {
            go("editor", { id: advId });
            toast("Stop added");
          }
        }
      }
    }));

    if (existing) {
      wrap.appendChild(el("button", {
        class: "np-btn np-btn-ghost np-btn-block",
        text: existing.approved_at ? "Re-approve stop" : "Approve stop",
        on: {
          click: function () {
            var res = api.approveStep(existing.id);
            if (res.error) { toast(res.error); return; }
            render();
            toast("Approved by you");
          }
        }
      }));
      wrap.appendChild(el("button", {
        class: "np-btn np-btn-danger np-btn-block", text: "Delete stop",
        on: {
          click: function () {
            api.deleteStep(existing.id);
            go("editor", { id: advId });
            toast("Stop deleted");
          }
        }
      }));
    }

    return wrap;
  }

  // ===========================================================================
  // VIEW: OrgAssistSheet (§4.1) — dummy model
  // ===========================================================================

  function openAssistSheet(advId) {
    var briefIn = el("textarea", {
      class: "np-textarea",
      placeholder: "A 45-minute walk through the old mill district, ending at the river.",
      maxlength: BOUNDS.briefChars
    });
    var count = 4;
    var countHolder = el("div");
    function paintCount() {
      clear(countHolder);
      countHolder.appendChild(segmented([
        { value: 3, label: "3" }, { value: 4, label: "4" },
        { value: 5, label: "5" }, { value: 6, label: "6" }
      ], count, function (v) { count = v; paintCount(); }));
    }
    paintCount();

    var status = el("div", { class: "np-hint" });
    var runBtn = el("button", { class: "np-btn np-btn-block", text: "Generate draft stops" });

    runBtn.addEventListener("click", function () {
      runBtn.disabled = true;
      status.textContent = "Drafting…";
      api.assist(briefIn.value.trim(), count, function (res) {
        runBtn.disabled = false;
        if (res.error) { status.textContent = res.error; return; }
        var added = 0;
        res.stops.forEach(function (st) {
          var r = api.addStep(advId, {
            title: st.title, text: st.text, verify_criterion: st.verify_criterion,
            verification_mode: "geo_and_photo",
            lat: st.lat, lng: st.lng, geofence_radius_m: 60, dwell_seconds: 90,
            draft_source: "llm_accepted"
          });
          if (!r.error) added++;
        });
        go("editor", { id: advId });
        toast(added + " draft stops added — all unapproved");
      });
    });

    sheet = {
      title: "Draft with assistant",
      body: [
        el("div", { class: "np-note", text: "Preview: this returns a canned response. In the real feature the model may only pick from the POI layer already in the database — it never names a venue freely." }),
        field("Describe the tour", briefIn),
        field("Area", el("div", { class: "np-card", text: "Exeter, NH · 1.5 km radius" }),
          "The candidate list is drawn from this area."),
        field("Stops", countHolder),
        runBtn,
        status,
        el("div", { class: "np-hint", text: "Everything it returns is a draft. A named human still has to approve every stop before publish." })
      ]
    };
    render();
  }

  // ===========================================================================
  // VIEW: OrgAdventureRunView (§6 / §13.2 / §13.3)
  // ===========================================================================
  // The §13.2 state machine is real: outside -> dwelling -> arrived ->
  // capture_unlocked -> verified, with the ordering gate and an accuracy floor.
  // Only the POSITIONS are simulated. Dwell ticks at SIM_SPEED because sitting
  // through a real 90 s dwell per stop, repeatedly, is not a design review.

  function startSim(advId) {
    var steps = api.listSteps(advId);
    if (!steps.length) return;
    runSim = {
      advId: advId,
      me: { lat: steps[0].lat + 0.0022, lng: steps[0].lng + 0.0022 }, // start outside
      accuracy: 8,
      verdict: "pass",
      busy: false,
      steps: steps.map(function (s) {
        return {
          id: s.id, ord: s.ord, title: s.title, mode: s.verification_mode,
          lat: s.lat, lng: s.lng, radius: s.geofence_radius_m, dwell: s.dwell_seconds,
          hasRef: !!s.reference_image_url,
          state: "outside", dwellLeft: s.dwell_seconds,
          geoVerified: false, verified: false, attempts: 0, lastReason: null
        };
      })
    };
    if (simTimer) clearInterval(simTimer);
    simTimer = setInterval(tickSim, 1000);
  }

  function stopSim() {
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    runSim = null;
  }

  function activeStep() {
    if (!runSim) return null;
    var adv = api.getAdventure(runSim.advId);
    for (var i = 0; i < runSim.steps.length; i++) {
      var st = runSim.steps[i];
      if (st.verified) continue;
      // §6 ordered by default: an earlier unverified stop blocks the later ones.
      if (!adv.unordered && i > 0) {
        for (var j = 0; j < i; j++) if (!runSim.steps[j].verified) return null;
      }
      return st;
    }
    return null;
  }

  function tickSim() {
    if (!runSim || route.name !== "run") return;
    var st = activeStep();
    if (!st) return;

    if (!requiresGeo(st.mode)) { st.state = "capture_unlocked"; paintRun(); return; }

    var d = haversine(runSim.me.lat, runSim.me.lng, st.lat, st.lng);
    // §6 accuracy floor: a fix worse than the radius is not evidence at all.
    if (runSim.accuracy > st.radius) {
      st.state = "low_accuracy";
      paintRun();
      return;
    }

    if (d > st.radius) {
      // Leaving the fence clears the dwell — presence must be CONTINUOUS.
      st.state = "outside";
      st.dwellLeft = st.dwell;
      paintRun();
      return;
    }

    if (st.dwellLeft > 0) {
      st.state = "dwelling";
      st.dwellLeft = Math.max(0, st.dwellLeft - SIM_SPEED);
      paintRun();
      return;
    }

    // Dwell satisfied.
    if (!st.geoVerified) {
      st.geoVerified = true;
      if (st.mode === "geo" || st.mode === "geo_or_photo") {
        st.verified = true;
        st.state = "verified";
        maybeComplete();
      } else {
        st.state = "capture_unlocked"; // geo_and_photo
      }
      paintRun();
    }
  }

  function maybeComplete() {
    var all = runSim.steps.every(function (s) { return s.verified; });
    if (all) toast("Run complete — points awarded from the org pool");
  }

  function submitPhoto() {
    var st = activeStep();
    if (!st || runSim.busy) return;
    if (st.attempts >= BOUNDS.attemptsPerStep) { toast("Attempt limit reached"); return; }
    runSim.busy = true;
    paintRun();

    api.judge(runSim.verdict, function (res) {
      runSim.busy = false;
      if (res.verdict === "inconclusive") {
        // §5: a vendor outage must never cost the user an attempt.
        st.lastReason = res.reason;
        st.state = "capture_unlocked";
        paintRun();
        toast("Inconclusive — attempt refunded");
        return;
      }
      if (res.verdict === "unsafe") {
        st.lastReason = res.reason;
        paintRun();
        toast("Photo rejected by the safety screen");
        return;
      }
      st.attempts += 1;
      if (res.verdict === "pass" || res.verdict === "unjudged") {
        st.verified = true;
        st.state = "verified";
        st.lastReason = res.reason;
        paintRun();
        maybeComplete();
      } else {
        st.lastReason = res.reason;
        st.state = "capture_unlocked";
        paintRun();
        toast("Attempt " + st.attempts + " of " + BOUNDS.attemptsPerStep);
      }
    });
  }

  var runBody = null;

  function paintRun() {
    if (!runBody || !runSim) return;
    clear(runBody);
    var adv = api.getAdventure(runSim.advId);
    var st = activeStep();

    // --- Map
    runBody.appendChild(mapBox({
      centerLat: runSim.steps[0].lat, centerLng: runSim.steps[0].lng,
      note: "Tap to move — simulated position",
      me: runSim.me,
      pins: runSim.steps.map(function (s) {
        return { lat: s.lat, lng: s.lng, radius: s.radius, dim: s.verified || (st && s.id !== st.id) };
      }),
      onPick: function (lat, lng) { runSim.me = { lat: lat, lng: lng }; tickSim(); paintRun(); }
    }));

    // --- Current stop status
    if (!st) {
      runBody.appendChild(el("div", { class: "np-card" }, [
        el("div", { class: "np-card-title", text: "Adventure complete" }),
        el("div", { class: "np-card-meta", text: "Every required stop verified. Completion fires server-side — there is no client-claimed finish." })
      ]));
    } else {
      var d = Math.round(haversine(runSim.me.lat, runSim.me.lng, st.lat, st.lng));
      var card = el("div", { class: "np-card" });
      card.appendChild(el("div", { class: "np-card-head" }, [
        el("div", {}, [
          el("div", { class: "np-card-title", text: "Stop " + st.ord + " · " + (st.title || "Untitled") }),
          el("div", { class: "np-card-meta", text: MODE_LABELS[st.mode] + " · " + st.radius + " m fence" })
        ]),
        el("span", { class: "np-pill np-pill-accent", text: st.state })
      ]));

      if (st.state === "dwelling") {
        card.appendChild(el("div", { class: "np-dwell", text: st.dwellLeft + "s" }));
        card.appendChild(el("div", { class: "np-dwell-sub", text: "Stay put — continuous presence required (simulated at " + SIM_SPEED + "×)" }));
      } else if (st.state === "outside") {
        card.appendChild(el("div", { class: "np-dwell", text: d + "m" }));
        card.appendChild(el("div", { class: "np-dwell-sub", text: "Walk to the stop to start the dwell" }));
      } else if (st.state === "low_accuracy") {
        card.appendChild(el("div", { class: "np-dwell-sub", text: "GPS accuracy (" + runSim.accuracy + " m) is worse than the " + st.radius + " m fence — not counted as evidence." }));
      } else if (st.state === "capture_unlocked") {
        card.appendChild(el("div", { class: "np-dwell-sub", text: "Arrived. Photo unlocked." + (st.hasRef ? " Compared against the org's reference." : "") }));
      }

      if (st.lastReason) {
        card.appendChild(el("div", { class: "np-note", text: st.lastReason }));
      }
      if (st.attempts) {
        card.appendChild(el("div", { class: "np-hint", text: "Attempts used: " + st.attempts + " of " + BOUNDS.attemptsPerStep }));
      }
      runBody.appendChild(card);

      // Judge verdict picker — forces every downstream UI state on demand.
      if (st.state === "capture_unlocked") {
        runBody.appendChild(el("div", { class: "np-section-title", text: "Dummy judge verdict" }));
        runBody.appendChild(segmented([
          { value: "pass", label: "pass" },
          { value: "fail", label: "fail" },
          { value: "inconclusive", label: "inconc." },
          { value: "unsafe", label: "unsafe" }
        ], runSim.verdict, function (v) { runSim.verdict = v; paintRun(); }));
        runBody.appendChild(el("button", {
          class: "np-btn np-btn-block",
          text: runSim.busy ? "Judging…" : "Take photo",
          disabled: runSim.busy,
          on: { click: submitPhoto }
        }));
      }

      // Simulation shortcuts
      runBody.appendChild(el("div", { class: "np-btn-row", style: "margin-top:10px" }, [
        el("button", {
          class: "np-btn np-btn-ghost np-btn-sm", text: "Teleport to stop",
          on: {
            click: function () {
              runSim.me = { lat: st.lat, lng: st.lng };
              tickSim(); paintRun();
            }
          }
        }),
        el("button", {
          class: "np-btn np-btn-ghost np-btn-sm", text: "Walk away",
          on: {
            click: function () {
              runSim.me = { lat: st.lat + 0.0022, lng: st.lng + 0.0022 };
              tickSim(); paintRun();
            }
          }
        }),
        el("button", {
          class: "np-btn np-btn-ghost np-btn-sm",
          text: runSim.accuracy > 100 ? "Good GPS" : "Degrade GPS",
          on: {
            click: function () {
              runSim.accuracy = runSim.accuracy > 100 ? 8 : 500;
              tickSim(); paintRun();
            }
          }
        })
      ]));
    }

    // --- Stop list
    runBody.appendChild(el("div", { class: "np-section-title", text: "Stops" }));
    runSim.steps.forEach(function (s) {
      var cls = s.verified ? "done" : (st && s.id === st.id ? "active" : "");
      runBody.appendChild(el("div", { class: "np-stop" }, [
        el("div", { class: "np-stop-ord " + cls, text: s.verified ? "✓" : String(s.ord) }),
        el("div", { class: "np-stop-body" }, [
          el("div", { class: "np-stop-title", text: s.title || "Untitled" }),
          el("div", {
            class: "np-stop-meta",
            text: s.verified ? "verified"
              : (st && s.id === st.id ? s.state : (adv.unordered ? "available" : "locked until earlier stops verify"))
          })
        ])
      ]));
    });
  }

  function viewRun() {
    var adv = api.getAdventure(route.params.id);
    if (!adv) { go("list"); return el("div"); }
    if (!runSim || runSim.advId !== adv.id) startSim(adv.id);

    var wrap = el("div", { class: "np-wrap" });
    wrap.appendChild(header(adv.title, "Runner preview · v" + adv.version, { name: "editor", params: { id: adv.id } }));
    wrap.appendChild(el("div", { class: "np-note", text: "Position is simulated. The dwell, ordering and accuracy rules are the real ones." }));
    runBody = el("div");
    wrap.appendChild(runBody);
    paintRun();
    wrap.appendChild(el("button", {
      class: "np-btn np-btn-ghost np-btn-block", text: "Restart run",
      style: "margin-top:14px",
      on: { click: function () { startSim(adv.id); paintRun(); toast("Run restarted"); } }
    }));
    return wrap;
  }

  // ===========================================================================
  // VIEW: OrgAnalyticsView (§8)
  // ===========================================================================

  function metricTile(label, value, denomText) {
    var valNode;
    if (value && value.suppressed) {
      valNode = el("div", { class: "np-metric-value suppressed", text: "too few runs" });
    } else {
      valNode = el("div", { class: "np-metric-value", text: value });
    }
    return el("div", { class: "np-metric" }, [
      el("div", { class: "np-metric-label", text: label }),
      valNode,
      denomText ? el("div", { class: "np-metric-denom", text: denomText }) : null
    ]);
  }

  function pct(obj) {
    if (!obj || obj.suppressed) return obj;
    if (!obj.denom) return "—";
    return Math.round((obj.n / obj.denom) * 100) + "%";
  }

  function viewAnalytics() {
    var wrap = el("div", { class: "np-wrap" });
    wrap.appendChild(header("Analytics", S.org.name));

    var measurable = S.adventures.filter(function (a) { return a.status !== "draft"; });
    if (!measurable.length) {
      wrap.appendChild(el("div", { class: "np-empty", text: "Publish an adventure to see analytics." }));
      return wrap;
    }

    var chosenId = route.params.id || measurable[0].id;
    if (!api.getAdventure(chosenId)) chosenId = measurable[0].id;

    if (measurable.length > 1) {
      wrap.appendChild(segmented(measurable.map(function (a) {
        return { value: a.id, label: a.title.length > 14 ? a.title.slice(0, 13) + "…" : a.title };
      }), chosenId, function (v) { go("analytics", { id: v }); }));
    }

    var a = api.analytics(chosenId);
    wrap.appendChild(el("div", { class: "np-card" }, [
      el("div", { class: "np-card-title", text: a.adventure.title }),
      el("div", { class: "np-card-meta", text: "Version " + a.adventure.version + " — each version is its own measurement series." })
    ]));

    var comp = a.completion;
    wrap.appendChild(el("div", { class: "np-metrics" }, [
      metricTile("Starts", a.starts, comp && !comp.suppressed ? "distinct users" : null),
      metricTile("Views", a.views),
      metricTile("Completion", pct(comp),
        comp && !comp.suppressed ? comp.n + " of " + comp.denom + " runs" : null),
      metricTile("Corroborated", a.corroborated,
        !a.corroborated || a.corroborated.suppressed ? null : "runs with 2+ together"),
      metricTile("Median rating", a.medianRating),
      metricTile("Small-n floor", a.threshold, "cells below this are withheld")
    ]));

    wrap.appendChild(el("div", { class: "np-section-title", text: "Per-stop drop-off" }));
    wrap.appendChild(el("div", { class: "np-note", text: "The most actionable figure here. A cliff between two stops names the broken stop." }));

    var maxReached = 0;
    a.perStop.forEach(function (s) { if (s.reachedRaw > maxReached) maxReached = s.reachedRaw; });

    a.perStop.forEach(function (s) {
      var reachedTxt, widthPct = 0, isDrop = false;
      if (s.reached && s.reached.suppressed) {
        reachedTxt = "withheld";
      } else {
        reachedTxt = s.reached + " reached";
        widthPct = maxReached ? (s.reachedRaw / maxReached) * 100 : 0;
      }
      if (s.dropOff && !s.dropOff.suppressed && s.dropOff.denom) {
        var keep = s.dropOff.n / s.dropOff.denom;
        if (keep < 0.75) isDrop = true;
        reachedTxt += " · " + Math.round(keep * 100) + "% of previous";
      }
      wrap.appendChild(el("div", { class: "np-bar-row" }, [
        el("div", { class: "np-bar-head" }, [
          el("span", { class: "np-bar-name", text: s.ord + ". " + s.title }),
          el("span", { class: "np-bar-num", text: reachedTxt })
        ]),
        el("div", { class: "np-bar-track" }, [
          el("div", { class: "np-bar-fill" + (isDrop ? " drop" : ""), style: "width:" + widthPct + "%" })
        ]),
        s.failRatio && !s.failRatio.suppressed && s.failRatio.n
          ? el("div", { class: "np-hint", text: s.failRatio.n + " failed verification(s) here — check the criterion or the reference, not the users." })
          : null
      ]));
    });

    wrap.appendChild(el("div", { class: "np-note", text: "Aggregates only. No usernames, no per-user tracks, no raw coordinates — an org sees counts and rates, never an identifiable person's movement." }));

    if (api.tier().csv_export) {
      wrap.appendChild(el("button", { class: "np-btn np-btn-ghost np-btn-block", text: "Export CSV (aggregates)", on: { click: function () { toast("Preview: export is mocked"); } } }));
    } else {
      wrap.appendChild(el("div", { class: "np-hint", text: "CSV export of aggregates requires the Institutional tier." }));
    }

    return wrap;
  }

  // ===========================================================================
  // VIEW: OrgInviteCodeView (§7)
  // ===========================================================================

  function viewInvites() {
    var wrap = el("div", { class: "np-wrap" });
    wrap.appendChild(header("Invite codes", S.org.name));

    if (!api.tier().invite_codes) {
      wrap.appendChild(el("div", { class: "np-card" }, [
        el("div", { class: "np-card-title", text: "Not on this plan" }),
        el("div", { class: "np-card-meta", text: "Invite codes and printable QR require a paid tier." })
      ]));
      return wrap;
    }

    wrap.appendChild(el("div", { class: "np-note", text: "A code either grants org membership, or access to one adventure without membership. A tourism board will not accept forced membership to walk a trail; an admissions office will insist on it. Both ship." }));

    var published = api.listAdventures("published");
    wrap.appendChild(el("div", { class: "np-btn-row" }, [
      el("button", {
        class: "np-btn np-btn-sm", text: "Mint membership code",
        on: {
          click: function () {
            var res = api.mintCode(null, null);
            if (res.error) { toast(res.error); return; }
            render(); toast("Code minted");
          }
        }
      }),
      published.length ? el("button", {
        class: "np-btn np-btn-ghost np-btn-sm", text: "Mint adventure code",
        on: {
          click: function () {
            var res = api.mintCode(published[0].id, 200);
            if (res.error) { toast(res.error); return; }
            render(); toast("Adventure code minted");
          }
        }
      }) : null
    ]));

    if (!S.codes.length) wrap.appendChild(el("div", { class: "np-empty", text: "No codes yet." }));

    S.codes.forEach(function (c) {
      var adv = c.org_adventure_id ? api.getAdventure(c.org_adventure_id) : null;
      var card = el("div", { class: "np-card" });
      card.appendChild(el("div", { class: "np-card-head" }, [
        el("div", {}, [
          el("div", { class: "np-card-title np-mono", text: c.code }),
          el("div", {
            class: "np-card-meta",
            text: (adv ? "Adventure: " + adv.title : "Grants org membership") +
              " · " + c.use_count + (c.max_uses ? " of " + c.max_uses : "") + " uses"
          })
        ]),
        el("span", {
          class: "np-pill " + (c.revoked_at ? "np-pill-bad" : "np-pill-ok"),
          text: c.revoked_at ? "revoked" : "active"
        })
      ]));
      card.appendChild(el("div", { class: "np-hint np-mono", text: api.codeLink(c.code) }));
      card.appendChild(el("div", { class: "np-btn-row", style: "margin-top:10px" }, [
        el("button", {
          class: "np-btn np-btn-ghost np-btn-sm", text: "Show QR",
          on: { click: function () { openQrSheet(c); } }
        }),
        !c.revoked_at ? el("button", {
          class: "np-btn np-btn-danger np-btn-sm", text: "Revoke",
          on: {
            click: function () {
              api.revokeCode(c.id);
              render();
              toast("Revoked — existing members keep their access");
            }
          }
        }) : null
      ]));
      wrap.appendChild(card);
    });

    return wrap;
  }

  function openQrSheet(c) {
    var link = api.codeLink(c.code);
    var svg;
    try { svg = qrSvg(link); } catch (e) { svg = null; }
    sheet = {
      title: "Printable QR",
      body: [
        svg ? el("div", { class: "np-qr", html: svg }) : el("div", { class: "np-empty", text: "Could not render QR." }),
        el("div", { class: "np-code", text: c.code }),
        el("div", { class: "np-hint np-mono", text: link }),
        el("div", { class: "np-note", text: "The QR encodes the link, not the raw code, so a fresh install lands in the right place. This is the physical-signage channel — the actual pitch for a tourism buyer." }),
        el("div", { class: "np-hint", text: "This is a real, scannable code generated in-browser. Point a phone at it to check." })
      ]
    };
    render();
  }

  // ===========================================================================
  // VIEW: OrgBillingView (§9) — READ ONLY. Captures nothing, by design.
  // ===========================================================================

  function viewBilling() {
    var wrap = el("div", { class: "np-wrap" });
    wrap.appendChild(header("Billing", S.org.name));

    var t = api.tier();
    wrap.appendChild(el("div", { class: "np-card" }, [
      el("div", { class: "np-card-head" }, [
        el("div", {}, [
          el("div", { class: "np-card-title", text: t.label }),
          el("div", { class: "np-card-meta", text: "Renews " + String(S.subscription.current_period_end).slice(0, 10) })
        ]),
        el("span", {
          class: "np-pill " + (S.subscription.status === "active" ? "np-pill-ok" : "np-pill-bad"),
          text: S.subscription.status
        })
      ])
    ]));

    wrap.appendChild(el("div", { class: "np-section-title", text: "What this plan includes" }));
    wrap.appendChild(el("div", { class: "np-card" }, [
      row("Published adventures", t.adventures === null ? "Unlimited" : String(t.adventures)),
      row("Stops per adventure", t.stops === null ? "Unlimited" : String(t.stops)),
      row("Analytics", t.analytics ? "Yes" : "No"),
      row("Custom branding", t.custom_branding ? "Yes" : "No"),
      row("Invite codes + QR", t.invite_codes ? "Yes" : "No"),
      row("CSV export", t.csv_export ? "Yes" : "No"),
      row("Assist calls / day", String(t.assist_calls_per_day))
    ]));

    // No price is shown anywhere. Price lives in Stripe and is read from config
    // so it can change without a deploy; the spec is explicit that the
    // mechanism ships and the number does not.
    wrap.appendChild(el("div", { class: "np-note", text: "No price is shown because none is set yet. Price and billing interval live in Stripe and are read from config, so changing either needs no deploy." }));

    wrap.appendChild(el("div", { class: "np-section-title", text: "Switch tier (preview only)" }));
    wrap.appendChild(segmented([
      { value: "trial", label: "Trial" },
      { value: "standard", label: "Standard" },
      { value: "institutional", label: "Institutional" }
    ], S.subscription.tier, function (v) {
      S.subscription.tier = v;
      save();
      render();
      toast("Tier set to " + TIERS[v].label + " — watch the gates change");
    }));
    wrap.appendChild(el("div", { class: "np-hint", text: "Flip tiers to see entitlement gates apply across the other screens (stop limits, invite codes, CSV export)." }));

    wrap.appendChild(el("div", { class: "np-section-title", text: "Subscription status (preview only)" }));
    wrap.appendChild(segmented([
      { value: "active", label: "active" },
      { value: "past_due", label: "past due" },
      { value: "canceled", label: "canceled" }
    ], S.subscription.status, function (v) {
      S.subscription.status = v;
      save();
      render();
      toast(v === "active" ? "Active" : "Writes blocked, reads still work — and nothing unpublishes");
    }));
    wrap.appendChild(el("div", { class: "np-hint", text: "A failed card blocks new publishes but never unpublishes live content — that would break a printed QR code in the physical world." }));

    wrap.appendChild(el("div", { class: "np-note", text: "There is deliberately no checkout here and no card field anywhere in this preview. Real purchase happens on the web, outside the app." }));

    return wrap;
  }

  // ===========================================================================
  // Render
  // ===========================================================================

  function render() {
    if (!root) return;
    clear(root);

    root.appendChild(el("div", {
      class: "np-preview-strip",
      text: "Preview · mock data · no backend · nothing is sent anywhere"
    }));

    var body;
    switch (route.name) {
      case "editor":    body = viewEditor(); break;
      case "stop":      body = viewStopEditor(); break;
      case "run":       body = viewRun(); break;
      case "analytics": body = viewAnalytics(); break;
      case "invites":   body = viewInvites(); break;
      case "billing":   body = viewBilling(); break;
      default:          body = viewList(); break;
    }
    root.appendChild(body);
    root.appendChild(tabs());

    if (sheet) {
      var backdrop = el("div", { class: "np-sheet-backdrop" });
      backdrop.addEventListener("click", function (ev) {
        if (ev.target === backdrop) { sheet = null; render(); }
      });
      var panel = el("div", { class: "np-sheet" }, [
        el("div", { class: "np-sheet-title", text: sheet.title })
      ]);
      sheet.body.forEach(function (n) { if (n) panel.appendChild(n); });
      panel.appendChild(el("button", {
        class: "np-btn np-btn-ghost np-btn-block", text: "Cancel",
        style: "margin-top:10px",
        on: { click: function () { sheet = null; render(); } }
      }));
      backdrop.appendChild(panel);
      root.appendChild(backdrop);
    }
  }

  // ===========================================================================
  // Open / close — same lifecycle as MortarMode
  // ===========================================================================

  function open_() {
    if (typeof document === "undefined") return;
    root = document.getElementById("pivot-root");
    if (!root) return;
    S = load();
    route = { name: "list", params: {} };
    sheet = null;
    stopSim();
    root.hidden = false;
    render();
    root.scrollTop = 0;
  }

  function close_() {
    stopSim();
    sheet = null;
    if (root) {
      root.hidden = true;
      clear(root);
    }
    // Quiz state untouched — the overlay just goes away.
  }

  var apiOut = {
    open: open_,
    close: close_,
    // Verification hooks for offline checking in node, the same idea as
    // MortarMode._physics. Not used by the UI.
    _qr: { buildQrMatrix: buildQrMatrix, qrSvg: qrSvg }
  };
  if (typeof window !== "undefined") window.NostiaPivot = apiOut;
  if (typeof module !== "undefined" && module.exports) module.exports = apiOut;
}());
