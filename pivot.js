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
 * mortar.js so the site stays buildless.
 *
 * LAYOUT: three fixed parts. The preview strip and top bar pin to the top, the
 * tab bar (plus an optional sticky action bar) pins to the bottom, and only the
 * middle scrolls. A view returns { title, sub, back, body, action } and never
 * builds its own chrome.
 *
 * LANGUAGE: no view renders a spec term. "geofence", "dwell", "preflight",
 * "corroboration", "small-n" and the raw run-state names all resolve through
 * MODE_COPY / friendlyFail / the status writer into ordinary English. If you
 * add a screen, add the words too — the vocabulary is the feature here.
 *
 * DEMO CONTROLS: anything that only exists because this is a fake — position
 * teleports, the forced judge verdict, tier and subscription switches, data
 * reset — lives inside demoDrawer(). Nothing fake sits loose in the flow. */

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
  // The canonical wire values. Everything an admin actually reads comes from
  // MODE_COPY further down — these names never reach the screen.
  var MODES = ["geo", "photo", "geo_and_photo", "geo_or_photo"];

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
  // Plain-language layer
  // ===========================================================================
  // The spec's vocabulary (geofence, dwell, preflight, corroboration, small-n)
  // is precise and unreadable. Every string an evaluator sees is written in
  // ordinary words here; the technical term appears once, as an aside, where
  // knowing it actually helps.

  var MODE_COPY = {
    geo: {
      chip: "Be there",
      title: "Just be there",
      sub: "Their phone has to sit inside the circle for the whole timer. No photo."
    },
    photo: {
      chip: "Photo only",
      title: "Just a photo",
      sub: "Anywhere. The photo has to match your example. Use this when the place has no reliable signal."
    },
    geo_and_photo: {
      chip: "Be there + photo",
      title: "Be there and take a photo",
      sub: "Strictest. They must stand there for the timer, then the photo has to match. This is the default."
    },
    geo_or_photo: {
      chip: "Be there or photo",
      title: "Be there or take a photo",
      sub: "Either one counts. Forgiving — good for stops where GPS is patchy."
    }
  };

  var TIER_BLURB = {
    trial: "One live adventure, five stops. Enough to prove the idea.",
    standard: "Five live adventures, fifteen stops each, plus invite codes and QR.",
    institutional: "No caps, multiple admins, and CSV export of the aggregates."
  };

  var ICONS = {
    back:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    help:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.2 9.3a2.8 2.8 0 015.4 1c0 1.9-2.6 2.2-2.6 4"/><path d="M12 17.6h.01"/></svg>',
    chev:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
    map:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3L3 5.6v15L9 18l6 3 6-2.6v-15L15 6 9 3z"/><path d="M9 3v15M15 6v15"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    ticket:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M9 5v14"/><path d="M13 9.5h4M13 14.5h4"/></svg>',
    card:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6.5 15h4"/></svg>',
    pin:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.1 7-11a7 7 0 10-14 0c0 4.9 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>',
    walk:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2"/><path d="M11 21l1.5-6L9 12.5 10 8l4 1.5 2.5 2.5"/><path d="M9 21l1.2-4"/><path d="M14.5 15.5L17 21"/></svg>',
    eye:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>',
    caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
    warn:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9.5 16H2.5L12 4z"/><path d="M12 10v4M12 17.5h.01"/></svg>'
  };

  // ===========================================================================
  // Shell / router
  // ===========================================================================

  var root = null;
  var scrollNode = null;
  var route = { name: "list", params: {} };
  var sheet = null;      // open sheet descriptor, or null
  var runSim = null;     // runner simulation state
  var simTimer = null;
  var drawerOpen = false;
  var guideIndex = 0;
  var listScope = "all";
  var lastRouteKey = null;
  var escHandler = null;

  var GUIDE_KEY = "np_preview_guide_seen_v1";

  function guideSeen() {
    try { return localStorage.getItem(GUIDE_KEY) === "1"; } catch (e) { return false; }
  }
  function markGuideSeen() {
    try { localStorage.setItem(GUIDE_KEY, "1"); } catch (e) { /* private mode */ }
  }

  function go(name, params) {
    if (name !== "run") stopSim();
    if (name !== "stop") stopDraftKey = null;
    route = { name: name, params: params || {} };
    sheet = null;
    render();
  }

  function toast(msg, bad) {
    if (!root) return;
    var t = el("div", { class: "np-toast" + (bad ? " bad" : ""), text: msg, role: "status" });
    root.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2400);
  }

  function iconBtn(name, label, onClick, extraClass) {
    return el("button", {
      class: "np-iconbtn" + (extraClass ? " " + extraClass : ""),
      html: ICONS[name],
      "aria-label": label,
      title: label,
      on: { click: onClick }
    });
  }

  function topbar(cfg) {
    var bar = el("div", { class: "np-topbar" });
    if (cfg.back) {
      bar.appendChild(iconBtn("back", "Back", function () { go(cfg.back.name, cfg.back.params); }));
    }
    bar.appendChild(el("div", { class: "np-topbar-title" }, [
      el("strong", { text: cfg.title }),
      cfg.sub ? el("span", { text: cfg.sub }) : null
    ]));
    bar.appendChild(iconBtn("help", "How this works", function () { openGuide(); }));
    bar.appendChild(iconBtn("close", "Close preview", close_));
    return bar;
  }

  function tabs() {
    var items = [
      { id: "list", ico: "map", label: "Adventures" },
      { id: "analytics", ico: "chart", label: "Insights" },
      { id: "invites", ico: "ticket", label: "Invites" },
      { id: "billing", ico: "card", label: "Plan" }
    ];
    var active = route.name;
    if (active === "editor" || active === "stop" || active === "run") active = "list";
    return el("nav", { class: "np-tabs", "aria-label": "Sections" }, items.map(function (it) {
      var on = active === it.id;
      return el("button", {
        class: on ? "on" : "",
        "aria-current": on ? "page" : null,
        on: { click: function () { go(it.id); } }
      }, [
        el("span", { html: ICONS[it.ico] }),
        document.createTextNode(it.label)
      ]);
    }));
  }

  function sectionHead(title, aside) {
    return el("div", { class: "np-section" }, [
      el("h2", { class: "np-section-title", text: title }),
      aside ? el("span", { class: "np-section-aside", text: aside }) : null
    ]);
  }

  function statusPill(status) {
    var map = { draft: ["np-pill-warn", "In progress"], published: ["np-pill-ok", "Live"], archived: ["", "Retired"] };
    var m = map[status] || ["", status];
    return el("span", { class: "np-pill " + m[0], text: m[1] });
  }

  function field(labelText, control, hint, counterNode) {
    return el("div", { class: "np-field" }, [
      el("label", { class: "np-label" }, [
        document.createTextNode(labelText),
        counterNode || null
      ]),
      hint ? el("div", { class: "np-label-hint", text: hint }) : null,
      control
    ]);
  }

  function row(label, value, sub) {
    return el("div", { class: "np-row" }, [
      el("span", { class: "np-row-label" }, [
        document.createTextNode(label),
        sub ? el("span", { class: "np-row-sub", text: sub }) : null
      ]),
      el("span", { class: "np-row-value", text: value })
    ]);
  }

  function segmented(options, current, onPick) {
    return el("div", { class: "np-seg", role: "tablist" }, options.map(function (o) {
      var on = o.value === current;
      return el("button", {
        class: on ? "on" : "",
        text: o.label,
        role: "tab",
        "aria-selected": on ? "true" : "false",
        on: { click: function () { onPick(o.value); } }
      });
    }));
  }

  function toggle(offLabel, onLabel, isOn, onPick) {
    return el("div", { class: "np-toggle" }, [
      el("button", { class: isOn ? "" : "on", text: offLabel, on: { click: function () { onPick(false); } } }),
      el("button", { class: isOn ? "on" : "", text: onLabel, on: { click: function () { onPick(true); } } })
    ]);
  }

  function choiceCard(title, sub, on, onPick) {
    return el("button", {
      class: "np-choice" + (on ? " on" : ""),
      role: "radio",
      "aria-checked": on ? "true" : "false",
      on: { click: onPick }
    }, [
      el("span", { class: "np-choice-dot" }),
      el("span", { class: "np-choice-body" }, [
        el("span", { class: "np-choice-title", text: title }),
        el("span", { class: "np-choice-sub", text: sub })
      ])
    ]);
  }

  /* A collapsible home for every control that only exists because this is a
     fake. Keeping them out of the flow is the difference between "a product"
     and "a debug console". */
  function demoDrawer(note, controls) {
    var body = el("div", { class: "np-drawer-body" });
    var head = el("button", {
      class: "np-drawer-head" + (drawerOpen ? " open" : ""),
      "aria-expanded": drawerOpen ? "true" : "false",
      on: {
        click: function () {
          drawerOpen = !drawerOpen;
          render();
        }
      }
    }, [
      el("span", { html: ICONS.caret }),
      document.createTextNode("Demo controls")
    ]);

    var wrap = el("div", { class: "np-drawer" }, [head]);
    if (drawerOpen) {
      body.appendChild(el("div", { class: "np-drawer-note", text: note }));
      controls.forEach(function (c) { if (c) body.appendChild(c); });
      wrap.appendChild(body);
    }
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Mock map. No tiles, no network — a CSS grid with projected pins. Enough to
  // place a coordinate and see a geofence radius, which is all §11's
  // "map pin + radius slider" needs for a design review.
  // ---------------------------------------------------------------------------

  var MAP_SPAN = 0.010; // degrees of latitude across the box

  function mapBox(opts) {
    var box = el("div", {
      class: "np-map",
      role: opts.onPick ? "application" : "img",
      "aria-label": opts.note || "Schematic map"
    });
    var w = 0, h = 190;
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

    box.appendChild(el("div", { class: "np-map-note", text: opts.note || "Sketch, not a real map — tap to move the pin" }));

    function paint() {
      w = box.clientWidth || 320;
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
          class: "np-map-pin" + (p.done ? " done" : ""),
          style: "left:" + pt.x + "px;top:" + pt.y + "px" + (p.dim ? ";opacity:.4" : "")
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
  // Publish checklist — the old UI dumped raw preflight strings into a red box
  // and only ever showed what was WRONG. This shows the whole list, ticked and
  // unticked, so an admin can see how close they are.
  // ===========================================================================

  function friendlyFail(text) {
    if (text.indexOf("not approved") !== -1) return "needs your sign-off";
    if (text.indexOf("missing reference") !== -1) return "needs an example photo";
    if (text.indexOf("missing coordinate") !== -1) return "needs a spot on the map";
    if (text.indexOf("radius out of bounds") !== -1) return "circle size is out of range";
    if (text.indexOf("dwell out of bounds") !== -1) return "time on the spot is out of range";
    return text;
  }

  function friendlyGeneral(text) {
    if (text.indexOf("Subscription is") !== -1) {
      return { text: "Sort out billing", sub: "Your plan is " + S.subscription.status.replace("_", " ") + ". You can keep editing, but publishing is paused." };
    }
    if (text.indexOf("Too many stops") !== -1) {
      return { text: "Too many stops for this plan", sub: text };
    }
    if (text.indexOf("limit reached") !== -1) {
      return { text: "No room for another live adventure", sub: "Retire one, or move up a plan." };
    }
    if (text.indexOf("Already") !== -1) {
      return { text: "This one is already live", sub: null };
    }
    return { text: text, sub: null };
  }

  /* Returns { items, blocking }. `blocking` is api.preflight()'s own count, so
     the Publish button can never disagree with what api.publish() will do. */
  function buildChecklist(adv) {
    var fails = api.preflight(adv.id);
    var steps = api.listSteps(adv.id);
    var byStep = {}, general = [];

    fails.forEach(function (f) {
      if (f.stepId) (byStep[f.stepId] = byStep[f.stepId] || []).push(f.text);
      else if (f.text.indexOf("Add at least one stop") === -1) general.push(f.text);
    });

    var items = [];
    items.push({
      done: steps.length > 0,
      text: "Add at least one stop",
      sub: steps.length ? steps.length + (steps.length === 1 ? " stop added" : " stops added") : "A tour needs somewhere to go."
    });

    steps.forEach(function (s) {
      var probs = byStep[s.id] || [];
      items.push({
        done: probs.length === 0,
        text: "Stop " + s.ord + " · " + (s.title || "Untitled"),
        sub: probs.length
          ? probs.map(friendlyFail).join(" · ")
          : "Ready to go",
        stepId: s.id
      });
    });

    general.forEach(function (t) {
      var g = friendlyGeneral(t);
      items.push({ done: false, text: g.text, sub: g.sub });
    });

    return { items: items, blocking: fails.length };
  }

  function checklistCard(adv, chk) {
    var left = 0;
    chk.items.forEach(function (i) { if (!i.done) left++; });
    var ready = chk.blocking === 0;

    var card = el("div", { class: "np-checklist" + (ready ? " ready" : "") });
    card.appendChild(el("div", { class: "np-checklist-head" }, [
      el("strong", { text: ready ? "Ready to publish" : left + (left === 1 ? " thing left" : " things left") }),
      el("span", {
        class: "np-pill " + (ready ? "np-pill-ok" : "np-pill-warn"),
        text: (chk.items.length - left) + " / " + chk.items.length
      })
    ]));

    chk.items.forEach(function (it) {
      card.appendChild(el("div", { class: "np-check " + (it.done ? "done" : "todo") }, [
        el("span", { class: "np-check-mark", text: it.done ? "✓" : "", "aria-hidden": "true" }),
        el("span", { class: "np-check-body" }, [
          document.createTextNode(it.text),
          it.sub ? el("span", { class: "np-check-sub", text: it.sub }) : null
        ]),
        (!it.done && it.stepId) ? el("button", {
          class: "np-btn np-btn-ghost np-btn-sm", text: "Open",
          on: { click: function () { go("stop", { advId: adv.id, stepId: it.stepId }); } }
        }) : null
      ]));
    });

    return card;
  }

  // ===========================================================================
  // GUIDE — first-run orientation. The single biggest gap in the old preview:
  // it opened straight into a list of "adventures" with a tier card and no
  // explanation of what any of it was.
  // ===========================================================================

  var GUIDE = [
    {
      art: "map",
      h: "Sponsored Adventures",
      p: [
        "An organisation — a museum, a town, a school — builds a walking tour of real places.",
        "People follow it on their phone, one stop at a time. This screen is the organisation's side of it."
      ]
    },
    {
      art: "pin",
      h: "The app proves they actually went",
      p: [
        "At each stop the phone checks two things: that it is inside a small circle you drew on the map, and that it stayed there for a moment rather than driving past.",
        "You can also ask for a photo. It gets compared against an example picture you upload, so a screenshot from the internet will not pass."
      ]
    },
    {
      art: "chart",
      h: "You find out where people give up",
      p: [
        "The numbers come back as counts and rates — how many started, how many finished, and which stop people stop at.",
        "Never a name, never a route, never one person's movements. If too few people have walked it, the figure is withheld rather than shown."
      ]
    },
    {
      art: "eye",
      h: "This is a preview",
      p: [
        "Everything here is invented and lives only in this browser. There is no server, no payment, and nothing is ever sent anywhere.",
        "Anything that only exists because this is a demo is tucked under a “Demo controls” heading, so the rest reads as the real thing would."
      ]
    }
  ];

  function openGuide() {
    guideIndex = 0;
    go("guide");
  }

  function viewGuide() {
    var page = GUIDE[guideIndex];
    var wrap = el("div", { class: "np-guide" });

    wrap.appendChild(el("div", { class: "np-guide-art" }, [el("span", { html: ICONS[page.art] })]));
    wrap.appendChild(el("h2", { text: page.h }));
    page.p.forEach(function (t) { wrap.appendChild(el("p", { text: t })); });

    wrap.appendChild(el("div", { class: "np-guide-dots", "aria-hidden": "true" },
      GUIDE.map(function (_, i) { return el("i", { class: i === guideIndex ? "on" : "" }); })));

    var last = guideIndex === GUIDE.length - 1;
    var actions = el("div", { class: "np-btn-row" }, [
      guideIndex > 0 ? el("button", {
        class: "np-btn np-btn-ghost", text: "Back",
        on: { click: function () { guideIndex--; render(); } }
      }) : null,
      el("button", {
        class: "np-btn", text: last ? "Start exploring" : "Next",
        on: {
          click: function () {
            if (last) { markGuideSeen(); go("list"); }
            else { guideIndex++; render(); }
          }
        }
      })
    ]);
    wrap.appendChild(actions);

    if (!last) {
      wrap.appendChild(el("button", {
        class: "np-btn np-btn-ghost np-btn-block", text: "Skip",
        style: "margin-top:8px",
        on: { click: function () { markGuideSeen(); go("list"); } }
      }));
    }

    return { chrome: false, body: wrap };
  }

  // ===========================================================================
  // VIEW: adventure list — now an orienting home rather than a bare list.
  // ===========================================================================

  function adventureCard(adv) {
    var steps = api.listSteps(adv.id);
    var meta, badge = null;

    if (adv.status === "draft") {
      var chk = buildChecklist(adv);
      var left = 0;
      chk.items.forEach(function (i) { if (!i.done) left++; });
      meta = steps.length + (steps.length === 1 ? " stop" : " stops") + " · " +
        (left ? left + (left === 1 ? " thing left" : " things left") : "ready to publish");
      badge = el("span", {
        class: "np-pill " + (left ? "np-pill-warn" : "np-pill-ok"),
        text: left ? "In progress" : "Ready"
      });
    } else {
      meta = steps.length + (steps.length === 1 ? " stop" : " stops") + " · " +
        adv.estimated_minutes + " min · " + adv.points_award + " points" +
        (adv.status === "published" ? " · version " + adv.version : "");
      badge = statusPill(adv.status);
    }

    return el("button", {
      class: "np-card np-card-tap",
      on: { click: function () { go("editor", { id: adv.id }); } }
    }, [
      el("div", { class: "np-card-head" }, [
        el("div", { style: "min-width:0" }, [
          el("div", { class: "np-card-title", text: adv.title }),
          el("div", { class: "np-card-meta", text: meta })
        ]),
        badge
      ])
    ]);
  }

  function viewList() {
    var wrap = el("div", { class: "np-wrap" });
    var limits = api.tier();
    var used = api.publishedCount();

    // --- Hero: says what this is, every time, without being a wall of text.
    wrap.appendChild(el("div", { class: "np-hero" }, [
      el("div", { class: "np-hero-eyebrow", text: "Sponsored adventures" }),
      el("p", { text: "Build a walking tour of real places. People follow it on their phone, the app checks they actually turned up, and you see where they drop off." }),
      el("div", { class: "np-btn-row" }, [
        el("button", {
          class: "np-btn np-btn-ghost np-btn-sm", text: "How it works",
          on: { click: openGuide }
        })
      ])
    ]));

    var drafts = [], live = [], retired = [];
    S.adventures.forEach(function (a) {
      if (a.status === "draft") drafts.push(a);
      else if (a.status === "published") live.push(a);
      else retired.push(a);
    });

    if (!S.adventures.length) {
      wrap.appendChild(el("div", { class: "np-empty", text: "No adventures yet. Start with the button below." }));
    }

    if (drafts.length) {
      wrap.appendChild(sectionHead("Still being built", drafts.length + " draft" + (drafts.length === 1 ? "" : "s")));
      drafts.forEach(function (a) { wrap.appendChild(adventureCard(a)); });
    }

    if (live.length) {
      wrap.appendChild(sectionHead("Live now", used + " of " +
        (limits.adventures === null ? "unlimited" : limits.adventures) + " allowed"));
      live.forEach(function (a) { wrap.appendChild(adventureCard(a)); });
    }

    if (retired.length) {
      wrap.appendChild(sectionHead("Retired"));
      retired.forEach(function (a) { wrap.appendChild(adventureCard(a)); });
    }

    // --- Plan summary, demoted to a quiet row now that it is not the headline.
    wrap.appendChild(sectionHead("Your plan"));
    wrap.appendChild(el("div", { class: "np-rows" }, [
      row("Plan", limits.label, TIER_BLURB[S.subscription.tier]),
      row("Live adventures", used + " of " + (limits.adventures === null ? "∞" : limits.adventures)),
      row("Stops allowed", limits.stops === null ? "No limit" : "Up to " + limits.stops)
    ]));

    if (S.subscription.status !== "active") {
      wrap.appendChild(el("div", { class: "np-note" }, [
        el("strong", { text: "Billing needs attention. " }),
        document.createTextNode("You can still edit and people can still walk what is already live — nothing goes dark because a card failed. New publishing is paused until it is sorted.")
      ]));
    }

    wrap.appendChild(demoDrawer(
      "None of this exists in the real product. It is here so you can push the preview into states that would otherwise take weeks to reach.",
      [
        el("button", {
          class: "np-btn np-btn-ghost np-btn-block", text: "Reset preview data",
          on: { click: function () { resetData(); go("list"); toast("Preview data reset"); } }
        }),
        el("button", {
          class: "np-btn np-btn-ghost np-btn-block", text: "Replay the intro",
          style: "margin-top:8px",
          on: { click: openGuide }
        })
      ]
    ));

    return {
      title: S.org.name,
      sub: "Adventure builder",
      body: wrap,
      action: el("button", {
        class: "np-btn np-btn-block", text: "New adventure",
        on: { click: openCreateSheet }
      })
    };
  }

  function openCreateSheet() {
    var titleIn = el("input", { class: "np-input", placeholder: "Riverside history walk", maxlength: 80 });
    var descIn = el("textarea", { class: "np-textarea", placeholder: "One or two lines a walker will read before they set off." });
    var diff = "easy";
    var diffHolder = el("div");

    function paintDiff() {
      clear(diffHolder);
      diffHolder.appendChild(el("div", { class: "np-choices", role: "radiogroup" }, [
        choiceCard("Easy · 25 points", "A short stroll. Two or three stops.", diff === "easy",
          function () { diff = "easy"; paintDiff(); }),
        choiceCard("Medium · 50 points", "Half an hour or so of walking.", diff === "medium",
          function () { diff = "medium"; paintDiff(); }),
        choiceCard("Hard · 100 points", "A proper outing. Worth the most.", diff === "advanced",
          function () { diff = "advanced"; paintDiff(); })
      ]));
    }
    paintDiff();

    sheet = {
      title: "New adventure",
      sub: "You can change all of this later. Nothing goes live until you publish it.",
      body: [
        field("What is it called?", titleIn),
        field("Describe it", descIn, "Shown to people before they start."),
        field("How much work is it?", diffHolder, "This sets the points. The app only ever awards 25, 50 or 100."),
        el("button", {
          class: "np-btn np-btn-block", text: "Create it",
          style: "margin-top:4px",
          on: {
            click: function () {
              var t = titleIn.value.trim();
              if (!t) { toast("Give it a name first", true); titleIn.focus(); return; }
              var res = api.createAdventure({
                title: t, description: descIn.value.trim(),
                difficulty: diff, points_award: DIFFICULTY_POINTS[diff]
              });
              if (res.error) { toast(res.error, true); return; }
              go("editor", { id: res.adventure.id });
              toast("Created — now add some stops");
            }
          }
        })
      ]
    };
    render();
    setTimeout(function () { titleIn.focus(); }, 60);
  }

  // ===========================================================================
  // VIEW: adventure editor — the workflow is now stated up front instead of
  // being discovered by hitting a wall of red text.
  // ===========================================================================

  function phaseStrip(adv, steps, chk) {
    var described = !!(adv.title && adv.description);
    var hasStops = steps.length > 0;
    var isLive = adv.status === "published";
    var phases = [
      { n: "Step 1", label: "Describe", done: described },
      { n: "Step 2", label: "Add stops", done: hasStops },
      { n: "Step 3", label: "Publish", done: isLive }
    ];
    var nowIdx = -1;
    for (var i = 0; i < phases.length; i++) { if (!phases[i].done) { nowIdx = i; break; } }
    if (isLive) nowIdx = -1;

    return el("div", { class: "np-steps" }, phases.map(function (p, i) {
      return el("div", {
        class: "np-steps-item" + (p.done ? " done" : (i === nowIdx ? " now" : ""))
      }, [
        el("div", { class: "np-steps-n", text: p.done ? "Done" : p.n }),
        el("div", { class: "np-steps-label", text: p.label })
      ]);
    }));
  }

  function stopRow(adv, s, isDraft) {
    var needsPhoto = requiresPhoto(s.verification_mode);
    var needsGeo = requiresGeo(s.verification_mode);
    var dots = [];

    if (needsGeo) {
      var hasCoord = s.lat !== null && isFinite(s.lat);
      dots.push(el("span", { class: "np-ready-dot " + (hasCoord ? "ok" : "no"), text: hasCoord ? "On the map" : "No location" }));
    }
    if (needsPhoto) {
      dots.push(el("span", {
        class: "np-ready-dot " + (s.reference_image_url ? "ok" : "no"),
        text: s.reference_image_url ? "Example photo" : "No example photo"
      }));
    }
    dots.push(el("span", {
      class: "np-ready-dot " + (s.approved_at ? "ok" : "no"),
      text: s.approved_at ? "Signed off" : "Not signed off"
    }));

    var meta = MODE_COPY[s.verification_mode].chip;
    if (needsGeo && s.geofence_radius_m) meta += " · " + s.geofence_radius_m + " m circle";
    meta += " · " + s.dwell_seconds + "s on the spot";

    return el("button", {
      class: "np-stop",
      on: { click: function () { go("stop", { advId: adv.id, stepId: s.id }); } }
    }, [
      el("div", { class: "np-stop-ord " + (s.approved_at ? "done" : ""), text: s.approved_at ? "✓" : String(s.ord) }),
      el("div", { class: "np-stop-body" }, [
        el("div", { class: "np-stop-title", text: s.title || "Untitled stop" }),
        el("div", { class: "np-stop-meta", text: meta }),
        isDraft ? el("div", { class: "np-ready" }, dots) : null
      ]),
      el("span", { class: "np-stop-chev", html: ICONS.chev })
    ]);
  }

  function viewEditor() {
    var adv = api.getAdventure(route.params.id);
    if (!adv) { go("list"); return { title: "", body: el("div") }; }

    var isDraft = adv.status === "draft";
    var steps = api.listSteps(adv.id);
    var chk = isDraft ? buildChecklist(adv) : null;
    var wrap = el("div", { class: "np-wrap" });

    if (isDraft) {
      wrap.appendChild(phaseStrip(adv, steps, chk));
      wrap.appendChild(checklistCard(adv, chk));
    } else if (adv.status === "published") {
      wrap.appendChild(el("div", { class: "np-note" }, [
        el("strong", { text: "This one is live. " }),
        document.createTextNode("Live adventures cannot be edited — someone may be halfway through one right now, and a printed QR code out in the world points at this version. Make a new draft instead; walkers already under way keep the version they started.")
      ]));
    }

    // --- Details
    wrap.appendChild(sectionHead("The basics"));

    if (isDraft) {
      var titleIn = el("input", { class: "np-input", value: adv.title, maxlength: 80 });
      var descIn = el("textarea", { class: "np-textarea" });
      descIn.value = adv.description || "";
      var minsIn = el("input", { class: "np-input", type: "number", value: adv.estimated_minutes, min: 5, max: 600 });

      wrap.appendChild(field("Name", titleIn));
      wrap.appendChild(field("Description", descIn, "Shown to people before they start."));
      wrap.appendChild(field("Roughly how long?", minsIn, "In minutes. A guide, not a limit."));

      var diffHolder = el("div");
      function paintDiff2() {
        clear(diffHolder);
        diffHolder.appendChild(el("div", { class: "np-choices", role: "radiogroup" }, [
          choiceCard("Easy · 25 points", "A short stroll.", adv.difficulty === "easy", function () { setDiff("easy"); }),
          choiceCard("Medium · 50 points", "Half an hour or so.", adv.difficulty === "medium", function () { setDiff("medium"); }),
          choiceCard("Hard · 100 points", "A proper outing.", adv.difficulty === "advanced", function () { setDiff("advanced"); })
        ]));
      }
      function setDiff(v) {
        api.updateAdventure(adv.id, { difficulty: v, points_award: DIFFICULTY_POINTS[v] });
        render();
      }
      paintDiff2();
      wrap.appendChild(field("How much work is it?", diffHolder, "Sets the points. Saved as soon as you pick."));

      wrap.appendChild(el("div", { class: "np-rows" }, [
        el("div", { class: "np-row" }, [
          el("span", { class: "np-row-label" }, [
            document.createTextNode("Who can walk it"),
            el("span", { class: "np-row-sub", text: adv.requires_membership ? "Members of your organisation only" : "Anyone who finds it" })
          ]),
          toggle("Anyone", "Members", !!adv.requires_membership, function (on) {
            api.updateAdventure(adv.id, { requires_membership: on ? 1 : 0 });
            render();
          })
        ]),
        el("div", { class: "np-row" }, [
          el("span", { class: "np-row-label" }, [
            document.createTextNode("Stop order"),
            el("span", { class: "np-row-sub", text: adv.unordered ? "Any stop, any time" : "Must be done front to back" })
          ]),
          toggle("In order", "Any order", !!adv.unordered, function (on) {
            api.updateAdventure(adv.id, { unordered: on ? 1 : 0 });
            render();
          })
        ])
      ]));

      wrap.appendChild(el("button", {
        class: "np-btn np-btn-ghost np-btn-block", text: "Save the basics",
        on: {
          click: function () {
            var res = api.updateAdventure(adv.id, {
              title: titleIn.value.trim() || adv.title,
              description: descIn.value.trim(),
              estimated_minutes: parseInt(minsIn.value, 10) || adv.estimated_minutes
            });
            if (res.error) { toast(res.error, true); return; }
            render();
            toast("Saved");
          }
        }
      }));
    } else {
      wrap.appendChild(el("div", { class: "np-rows" }, [
        row("Effort", adv.difficulty === "advanced" ? "Hard" : (adv.difficulty === "medium" ? "Medium" : "Easy"), adv.points_award + " points"),
        row("Roughly", adv.estimated_minutes + " min"),
        row("Who can walk it", adv.requires_membership ? "Members only" : "Anyone"),
        row("Stop order", adv.unordered ? "Any order" : "In order"),
        row("Version", "v" + adv.version)
      ]));
    }

    // --- Stops
    wrap.appendChild(sectionHead("Stops", steps.length ? steps.length + " on the route" : null));
    if (!steps.length) {
      wrap.appendChild(el("div", { class: "np-empty", text: "No stops yet. A stop is one place someone has to physically go." }));
    }
    steps.forEach(function (s) { wrap.appendChild(stopRow(adv, s, isDraft)); });

    if (isDraft) {
      wrap.appendChild(el("div", { class: "np-btn-row", style: "margin-top:10px" }, [
        el("button", {
          class: "np-btn np-btn-ghost", text: "Add a stop",
          on: { click: function () { go("stop", { advId: adv.id, stepId: null }); } }
        }),
        el("button", {
          class: "np-btn np-btn-ghost", text: "✦ Draft some for me",
          on: { click: function () { openAssistSheet(adv.id); } }
        })
      ]));
    }

    // --- Secondary actions for a live adventure
    if (adv.status === "published") {
      wrap.appendChild(sectionHead("What you can do"));
      wrap.appendChild(el("button", {
        class: "np-btn np-btn-ghost np-btn-block", text: "See the numbers",
        style: "margin-bottom:8px",
        on: { click: function () { go("analytics", { id: adv.id }); } }
      }));
      wrap.appendChild(el("button", {
        class: "np-btn np-btn-ghost np-btn-block", text: "Make a new draft from this",
        style: "margin-bottom:8px",
        on: {
          click: function () {
            var res = api.revise(adv.id);
            if (res.error) { toast(res.error, true); return; }
            go("editor", { id: res.adventure.id });
            toast("New draft made — every stop needs signing off again");
          }
        }
      }));
      wrap.appendChild(el("button", {
        class: "np-btn np-btn-danger np-btn-block", text: "Retire it",
        on: {
          click: function () {
            api.archive(adv.id);
            render();
            toast("Retired — anyone mid-walk can still finish");
          }
        }
      }));
      wrap.appendChild(el("div", { class: "np-hint", text: "Retiring hides it from new walkers. It does not interrupt anyone already out there." }));
    }

    if (adv.status === "archived") {
      wrap.appendChild(el("div", { class: "np-note", text: "This adventure is retired. It no longer appears to walkers." }));
    }

    // --- Sticky action
    var action = null;
    if (isDraft) {
      var clean = chk.blocking === 0;
      action = el("div", {}, [
        el("button", {
          class: "np-btn np-btn-block", text: "Publish it", disabled: !clean,
          on: {
            click: function () {
              var res = api.publish(adv.id);
              if (res.error) { toast(res.error, true); render(); return; }
              render();
              toast("Live now, as version " + res.adventure.version);
            }
          }
        }),
        !clean ? el("div", { class: "np-hint", text: "Publishing unlocks when the checklist at the top is clear." }) : null
      ]);
    } else if (adv.status === "published") {
      action = el("button", {
        class: "np-btn np-btn-block", text: "Try it as a walker",
        on: { click: function () { go("run", { id: adv.id }); } }
      });
    }

    return {
      title: adv.title,
      sub: isDraft ? "Draft" : (adv.status === "published" ? "Live · version " + adv.version : "Retired"),
      back: { name: "list" },
      body: wrap,
      action: action
    };
  }

  // ===========================================================================
  // VIEW: stop editor
  // ===========================================================================
  // The draft lives outside the render cycle so that typing survives a
  // re-render. In the old version, hitting Approve rebuilt the view from the
  // saved record and silently threw away whatever was in the fields.

  var stopDraft = null;
  var stopDraftKey = null;

  function ensureStopDraft(advId, existing) {
    var key = advId + ":" + (existing ? existing.id : "new");
    if (stopDraftKey === key && stopDraft) return stopDraft;
    stopDraftKey = key;
    stopDraft = existing ? {
      title: existing.title, text: existing.text, verify_criterion: existing.verify_criterion,
      verification_mode: existing.verification_mode, lat: existing.lat, lng: existing.lng,
      geofence_radius_m: existing.geofence_radius_m || 60, dwell_seconds: existing.dwell_seconds
    } : {
      title: "", text: "", verify_criterion: "", verification_mode: "geo_and_photo",
      lat: BASE_LAT, lng: BASE_LNG, geofence_radius_m: 60, dwell_seconds: 90
    };
    return stopDraft;
  }

  function countedField(labelText, hint, value, maxChars, onInput) {
    var counter = el("span", { class: "np-counter", text: value.length + "/" + maxChars });
    var ta = el("textarea", { class: "np-textarea", maxlength: maxChars });
    ta.value = value;
    ta.addEventListener("input", function () {
      counter.textContent = ta.value.length + "/" + maxChars;
      onInput(ta.value);
    });
    return field(labelText, ta, hint, counter);
  }

  function viewStopEditor() {
    var advId = route.params.advId;
    var adv = api.getAdventure(advId);
    if (!adv) { go("list"); return { title: "", body: el("div") }; }

    var existing = route.params.stepId ? api.getStep(route.params.stepId) : null;
    var draft = ensureStopDraft(advId, existing);
    var wrap = el("div", { class: "np-wrap" });

    if (existing && existing.approved_at) {
      wrap.appendChild(el("div", { class: "np-note" }, [
        el("strong", { text: "Signed off. " }),
        document.createTextNode("Change anything here and the sign-off comes off again. That is on purpose — a sign-off means a person read this exact wording, so it cannot survive an edit.")
      ]));
    }

    // --- 1. What people do here
    wrap.appendChild(sectionHead("1 · What people do here"));

    var titleIn = el("input", { class: "np-input", value: draft.title, maxlength: BOUNDS.titleChars, placeholder: "The old mill" });
    titleIn.addEventListener("input", function () { draft.title = titleIn.value; });
    wrap.appendChild(field("Name of this stop", titleIn));

    wrap.appendChild(countedField(
      "What should they do?",
      "The instruction they read when they get near. Keep it to a sentence.",
      draft.text, BOUNDS.textChars,
      function (v) { draft.text = v; }
    ));

    // --- 2. How it gets proved
    wrap.appendChild(sectionHead("2 · How you know they went"));

    var modeHolder = el("div", { class: "np-field" });
    var geoHolder = el("div");
    var photoHolder = el("div");

    function paintMode() {
      clear(modeHolder);
      modeHolder.appendChild(el("div", { class: "np-label", text: "Proof required" }));
      var group = el("div", { class: "np-choices", role: "radiogroup" });
      ["geo_and_photo", "geo", "photo", "geo_or_photo"].forEach(function (m) {
        var c = MODE_COPY[m];
        group.appendChild(choiceCard(c.title, c.sub, draft.verification_mode === m, function () {
          draft.verification_mode = m;
          paintMode(); paintGeo(); paintPhoto();
        }));
      });
      modeHolder.appendChild(group);
    }

    function paintGeo() {
      clear(geoHolder);
      if (!requiresGeo(draft.verification_mode)) return;

      geoHolder.appendChild(el("div", { class: "np-label", text: "Where is it?" }));
      geoHolder.appendChild(el("div", { class: "np-label-hint", text: "Tap the sketch to drop the pin. The shaded circle is the area that counts as “here”." }));
      geoHolder.appendChild(mapBox({
        centerLat: draft.lat || BASE_LAT, centerLng: draft.lng || BASE_LNG,
        pins: [{ lat: draft.lat, lng: draft.lng, radius: draft.geofence_radius_m }],
        onPick: function (lat, lng) { draft.lat = lat; draft.lng = lng; paintGeo(); }
      }));
      geoHolder.appendChild(el("div", {
        class: "np-hint np-mono",
        text: draft.lat.toFixed(5) + ", " + draft.lng.toFixed(5)
      }));

      // Circle size
      var rIn = el("input", {
        class: "np-range", type: "range", "aria-label": "Circle size in metres",
        min: BOUNDS.radiusMin, max: BOUNDS.radiusMax, value: draft.geofence_radius_m, step: 5
      });
      var rVal = el("span", { class: "np-rangeval", text: draft.geofence_radius_m + " m" });
      rIn.addEventListener("input", function () {
        draft.geofence_radius_m = parseInt(rIn.value, 10);
        rVal.textContent = draft.geofence_radius_m + " m";
        paintGeo();
      });
      geoHolder.appendChild(el("div", { class: "np-field", style: "margin-top:16px" }, [
        el("div", { class: "np-rangerow" }, [
          el("span", { class: "np-label", style: "margin:0", text: "How close do they have to be?" }), rVal
        ]),
        rIn,
        el("div", { class: "np-hint", text: "Tighter is stronger proof, but a phone in a narrow street can be 30 m out. Under about 25 m people get stuck." })
      ]));

      // Dwell
      var dIn = el("input", {
        class: "np-range", type: "range", "aria-label": "Seconds they must stay",
        min: BOUNDS.dwellMin, max: 300, value: draft.dwell_seconds, step: 5
      });
      var dVal = el("span", { class: "np-rangeval", text: draft.dwell_seconds + " s" });
      dIn.addEventListener("input", function () {
        draft.dwell_seconds = parseInt(dIn.value, 10);
        dVal.textContent = draft.dwell_seconds + " s";
      });
      geoHolder.appendChild(el("div", { class: "np-field" }, [
        el("div", { class: "np-rangerow" }, [
          el("span", { class: "np-label", style: "margin:0", text: "How long do they have to stay?" }), dVal
        ]),
        dIn,
        el("div", { class: "np-hint", text: "Stepping outside the circle resets it to zero. This is what stops someone driving past and collecting the stop." })
      ]));
    }

    function paintPhoto() {
      clear(photoHolder);
      if (!requiresPhoto(draft.verification_mode)) return;

      photoHolder.appendChild(countedField(
        "What must the photo show?",
        "Describe something concrete an outsider could check — “the carved crest above the door”, not “the atmosphere”.",
        draft.verify_criterion, BOUNDS.criterionChars,
        function (v) { draft.verify_criterion = v; }
      ));

      if (!existing) {
        photoHolder.appendChild(el("div", { class: "np-note", text: "Save this stop first, then you can upload the example photo it gets compared against." }));
        return;
      }

      var has = !!existing.reference_image_url;
      var card = el("div", { class: "np-card" }, [
        el("div", { class: "np-card-head" }, [
          el("div", { style: "min-width:0" }, [
            el("div", { class: "np-card-title", text: "Your example photo" }),
            el("div", { class: "np-card-meta", text: has ? "Uploaded. This is what walkers' photos get checked against." : "Needed before this stop can be signed off." })
          ]),
          el("span", { class: "np-pill " + (has ? "np-pill-ok" : "np-pill-warn"), text: has ? "Uploaded" : "Missing" })
        ])
      ]);

      var fileIn = el("input", { type: "file", accept: "image/*", style: "display:none" });
      fileIn.addEventListener("change", function () {
        var name = fileIn.files && fileIn.files[0] ? fileIn.files[0].name : "reference.jpg";
        // Nothing is uploaded or read — the preview records the filename only.
        var res = api.attachReference(existing.id, name);
        render();
        toast(res.approvalCleared ? "Added — sign-off cleared" : "Example photo added");
      });
      card.appendChild(fileIn);
      card.appendChild(el("button", {
        class: "np-btn np-btn-ghost np-btn-sm", text: has ? "Replace it" : "Upload one",
        style: "margin-top:12px",
        on: { click: function () { fileIn.click(); } }
      }));
      card.appendChild(el("div", { class: "np-hint", text: "It stays on the server and is never sent to anyone's phone — otherwise a walker could just re-submit your own picture." }));
      photoHolder.appendChild(card);
    }

    paintMode(); paintGeo(); paintPhoto();
    wrap.appendChild(modeHolder);
    wrap.appendChild(geoHolder);
    wrap.appendChild(photoHolder);

    // --- 3. Sign off
    if (existing) {
      wrap.appendChild(sectionHead("3 · Sign it off"));
      wrap.appendChild(el("div", { class: "np-card" }, [
        el("div", { class: "np-card-head" }, [
          el("div", { style: "min-width:0" }, [
            el("div", { class: "np-card-title", text: existing.approved_at ? "Signed off" : "Not signed off yet" }),
            el("div", { class: "np-card-meta", text: "Someone has to put their name to every stop before the adventure can go live. Save your changes first — signing off does not save them." })
          ]),
          el("span", { class: "np-pill " + (existing.approved_at ? "np-pill-ok" : "np-pill-warn"), text: existing.approved_at ? "Done" : "Waiting" })
        ])
      ]));
      wrap.appendChild(el("button", {
        class: "np-btn np-btn-ghost np-btn-block",
        text: existing.approved_at ? "Sign off again" : "Sign off on this stop",
        on: {
          click: function () {
            var res = api.approveStep(existing.id);
            if (res.error) { toast(res.error, true); return; }
            render();
            toast("Signed off");
          }
        }
      }));

      wrap.appendChild(sectionHead("Danger zone"));
      wrap.appendChild(el("button", {
        class: "np-btn np-btn-danger np-btn-block", text: "Delete this stop",
        on: {
          click: function () {
            api.deleteStep(existing.id);
            stopDraftKey = null;
            go("editor", { id: advId });
            toast("Stop deleted");
          }
        }
      }));
    }

    var action = el("button", {
      class: "np-btn np-btn-block", text: existing ? "Save this stop" : "Add this stop",
      on: {
        click: function () {
          var payload = {
            title: (draft.title || "").trim(),
            text: (draft.text || "").trim(),
            verify_criterion: (draft.verify_criterion || "").trim(),
            verification_mode: draft.verification_mode,
            lat: draft.lat, lng: draft.lng,
            geofence_radius_m: draft.geofence_radius_m,
            dwell_seconds: draft.dwell_seconds
          };
          if (!requiresGeo(payload.verification_mode)) { payload.lat = null; payload.lng = null; }

          var res = existing ? api.updateStep(existing.id, payload) : api.addStep(advId, payload);
          if (res.error) { toast(res.error, true); return; }
          stopDraftKey = null;
          if (existing) {
            go("stop", { advId: advId, stepId: existing.id });
            toast(res.approvalCleared ? "Saved — sign-off cleared" : "Saved");
          } else {
            go("editor", { id: advId });
            toast("Stop added");
          }
        }
      }
    });

    return {
      title: existing ? "Stop " + existing.ord : "New stop",
      sub: adv.title,
      back: { name: "editor", params: { id: advId } },
      body: wrap,
      action: action
    };
  }

  // ===========================================================================
  // VIEW: authoring assistant sheet (§4.1) — dummy model
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
    var runBtn = el("button", { class: "np-btn np-btn-block", text: "Draft the stops" });

    runBtn.addEventListener("click", function () {
      runBtn.disabled = true;
      runBtn.textContent = "Thinking…";
      status.textContent = "";
      api.assist(briefIn.value.trim(), count, function (res) {
        runBtn.disabled = false;
        runBtn.textContent = "Draft the stops";
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
        toast(added + " stops drafted — read each one, then sign it off");
      });
    });

    sheet = {
      title: "Draft some stops for me",
      sub: "A starting point, not a finished tour. You still read and sign off every stop.",
      body: [
        field("Describe the walk you want", briefIn),
        field("Where", el("div", { class: "np-rows" }, [row("Area", "Exeter, NH"), row("Within", "1.5 km")]),
          "It can only choose from real places already on file for this area. It is not allowed to name a venue of its own invention."),
        field("How many stops", countHolder),
        runBtn,
        status,
        el("div", { class: "np-note", text: "In this preview the answer is canned and nothing leaves your browser." })
      ]
    };
    render();
  }

  // ===========================================================================
  // VIEW: walker preview (§6 / §13.2 / §13.3)
  // ===========================================================================
  // The state machine is the real one: outside -> dwelling -> arrived ->
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
    if (runSim.accuracy > st.radius) { st.state = "low_accuracy"; paintRun(); return; }

    if (d > st.radius) {
      // Leaving the circle clears the timer — presence must be CONTINUOUS.
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
    if (all) toast("Finished — points added to their organisation total");
  }

  function submitPhoto() {
    var st = activeStep();
    if (!st || runSim.busy) return;
    if (st.attempts >= BOUNDS.attemptsPerStep) { toast("No attempts left on this stop", true); return; }
    runSim.busy = true;
    paintRun();

    api.judge(runSim.verdict, function (res) {
      runSim.busy = false;
      if (res.verdict === "inconclusive") {
        // §5: a vendor outage must never cost the user an attempt.
        st.lastReason = res.reason;
        st.state = "capture_unlocked";
        paintRun();
        toast("Could not check it — that attempt did not count");
        return;
      }
      if (res.verdict === "unsafe") {
        st.lastReason = res.reason;
        paintRun();
        toast("Photo refused by the safety check", true);
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
        toast("Not a match — " + (BOUNDS.attemptsPerStep - st.attempts) + " tries left");
      }
    });
  }

  var runBody = null;

  var VERDICT_LABEL = {
    pass: "a match", fail: "not a match",
    inconclusive: "no answer (outage)", unsafe: "refused by safety check"
  };

  function paintRun() {
    if (!runBody || !runSim) return;
    clear(runBody);
    var adv = api.getAdventure(runSim.advId);
    var st = activeStep();

    runBody.appendChild(mapBox({
      centerLat: runSim.steps[0].lat, centerLng: runSim.steps[0].lng,
      note: "Blue dot is the walker — tap to move them",
      me: runSim.me,
      pins: runSim.steps.map(function (s) {
        return { lat: s.lat, lng: s.lng, radius: s.radius, done: s.verified, dim: s.verified || (st && s.id !== st.id) };
      }),
      onPick: function (lat, lng) { runSim.me = { lat: lat, lng: lng }; tickSim(); paintRun(); }
    }));

    if (!st) {
      runBody.appendChild(el("div", { class: "np-status done", style: "margin-top:12px" }, [
        el("div", { class: "np-status-head", text: "Finished" }),
        el("div", { class: "np-status-sub", text: "Every stop proved. The server decides this, not the phone — there is no “I'm done” button a walker could press." })
      ]));
    } else {
      var d = Math.round(haversine(runSim.me.lat, runSim.me.lng, st.lat, st.lng));
      var tone = "away", head = null, big = null, sub = "";

      if (st.state === "dwelling") {
        tone = "hold";
        big = st.dwellLeft + "s";
        sub = "Inside the circle. Stay put — walking out sets this back to " + st.dwell + "s.";
      } else if (st.state === "outside") {
        tone = "away";
        big = d + "m";
        sub = "Too far. The timer starts once they are inside the " + st.radius + " m circle.";
      } else if (st.state === "low_accuracy") {
        tone = "warn";
        head = "Signal too poor to count";
        sub = "The phone only knows where it is to within " + runSim.accuracy + " m, which is wider than the " + st.radius + " m circle. That is not proof of anything, so it is ignored.";
      } else if (st.state === "capture_unlocked") {
        tone = "ready";
        head = "They're here";
        sub = requiresGeo(st.mode)
          ? ("Stood still long enough. Now the photo." + (st.hasRef ? " It gets compared to your example." : ""))
          : ("This stop just needs the photo." + (st.hasRef ? " It gets compared to your example." : ""));
      }

      var card = el("div", { class: "np-status " + tone, style: "margin-top:12px" });
      card.appendChild(el("div", { class: "np-status-where", text: "Stop " + st.ord + " · " + (st.title || "Untitled") }));
      if (big) card.appendChild(el("div", { class: "np-status-big", text: big }));
      if (head) card.appendChild(el("div", { class: "np-status-head", text: head }));
      if (sub) card.appendChild(el("div", { class: "np-status-sub", text: sub }));

      if (st.lastReason) {
        card.appendChild(el("div", { class: "np-status-judge", text: "What the checker said: " + st.lastReason }));
      }
      if (st.attempts) {
        card.appendChild(el("div", { class: "np-hint", text: (BOUNDS.attemptsPerStep - st.attempts) + " of " + BOUNDS.attemptsPerStep + " attempts left" }));
      }
      runBody.appendChild(card);

      if (st.state === "capture_unlocked") {
        runBody.appendChild(el("button", {
          class: "np-btn np-btn-block",
          text: runSim.busy ? "Checking…" : "Take the photo",
          disabled: runSim.busy,
          on: { click: submitPhoto }
        }));
        runBody.appendChild(el("div", {
          class: "np-hint",
          style: "text-align:center",
          text: "Demo: the checker will say “" + VERDICT_LABEL[runSim.verdict] + "”. Change that under Demo controls."
        }));
      }
    }

    runBody.appendChild(sectionHead("The route"));
    runSim.steps.forEach(function (s) {
      var isActive = st && s.id === st.id;
      var state = s.verified ? "Proved"
        : (isActive ? "Working on this one"
          : (adv.unordered ? "Can be done any time" : "Locked until the earlier stops are done"));
      runBody.appendChild(el("div", { class: "np-stop static" + (isActive ? " active" : "") }, [
        el("div", { class: "np-stop-ord " + (s.verified ? "done" : (isActive ? "active" : "")), text: s.verified ? "✓" : String(s.ord) }),
        el("div", { class: "np-stop-body" }, [
          el("div", { class: "np-stop-title", text: s.title || "Untitled" }),
          el("div", { class: "np-stop-meta", text: state })
        ])
      ]));
    });

    // Everything that only exists because the walker is fake.
    var stNow = st;
    runBody.appendChild(demoDrawer(
      "A real walker's phone reports its own position. Here you drive it by hand, and you choose what the photo checker will say so every outcome is reachable on demand.",
      [
        el("div", { class: "np-btn-row", style: "margin-bottom:12px" }, [
          stNow ? el("button", {
            class: "np-btn np-btn-ghost np-btn-sm", text: "Jump to the stop",
            on: { click: function () { runSim.me = { lat: stNow.lat, lng: stNow.lng }; tickSim(); paintRun(); } }
          }) : null,
          stNow ? el("button", {
            class: "np-btn np-btn-ghost np-btn-sm", text: "Walk away",
            on: { click: function () { runSim.me = { lat: stNow.lat + 0.0022, lng: stNow.lng + 0.0022 }; tickSim(); paintRun(); } }
          }) : null,
          el("button", {
            class: "np-btn np-btn-ghost np-btn-sm",
            text: runSim.accuracy > 100 ? "Restore good signal" : "Wreck the GPS signal",
            on: {
              click: function () {
                runSim.accuracy = runSim.accuracy > 100 ? 8 : 500;
                tickSim(); paintRun();
              }
            }
          })
        ]),
        el("div", { class: "np-label", text: "What the photo checker will say" }),
        segmented([
          { value: "pass", label: "Match" },
          { value: "fail", label: "No match" },
          { value: "inconclusive", label: "Outage" },
          { value: "unsafe", label: "Unsafe" }
        ], runSim.verdict, function (v) { runSim.verdict = v; paintRun(); }),
        el("div", { class: "np-hint", text: "“Outage” is the one worth trying: when the checker cannot answer, the attempt is refunded rather than spent." }),
        el("button", {
          class: "np-btn np-btn-ghost np-btn-block", text: "Start the walk over",
          style: "margin-top:12px",
          on: { click: function () { startSim(runSim.advId); paintRun(); toast("Back to the beginning"); } }
        })
      ]
    ));
  }

  function viewRun() {
    var adv = api.getAdventure(route.params.id);
    if (!adv) { go("list"); return { title: "", body: el("div") }; }
    if (!runSim || runSim.advId !== adv.id) startSim(adv.id);

    var wrap = el("div", { class: "np-wrap" });
    wrap.appendChild(el("div", { class: "np-note" }, [
      el("strong", { text: "This is what a walker sees. " }),
      document.createTextNode("Their position is faked so you can test it from a desk, and the timers run " + SIM_SPEED + "× faster. Everything else — the circle, the wait, the order, the signal check — behaves exactly as it would in the field.")
    ]));

    runBody = el("div");
    wrap.appendChild(runBody);
    paintRun();

    return {
      title: adv.title,
      sub: "Walker's view · version " + adv.version,
      back: { name: "editor", params: { id: adv.id } },
      body: wrap
    };
  }

  // ===========================================================================
  // VIEW: insights (§8)
  // ===========================================================================

  function metricTile(label, value, denomText, help) {
    var valNode;
    if (value === null || value === undefined) {
      valNode = el("div", { class: "np-metric-value suppressed", text: "no data yet" });
    } else if (value.suppressed) {
      valNode = el("div", { class: "np-metric-value suppressed", text: "too few walkers to show" });
    } else {
      valNode = el("div", { class: "np-metric-value", text: String(value) });
    }
    return el("div", { class: "np-metric" }, [
      el("div", { class: "np-metric-label", text: label }),
      valNode,
      denomText ? el("div", { class: "np-metric-denom", text: denomText }) : null,
      (!denomText && help) ? el("div", { class: "np-metric-denom", text: help }) : null
    ]);
  }

  function pct(obj) {
    if (!obj || obj.suppressed) return obj;
    if (!obj.denom) return "—";
    return Math.round((obj.n / obj.denom) * 100) + "%";
  }

  function viewAnalytics() {
    var wrap = el("div", { class: "np-wrap" });

    var measurable = S.adventures.filter(function (a) { return a.status !== "draft"; });
    if (!measurable.length) {
      wrap.appendChild(el("div", { class: "np-empty", text: "Nothing to measure yet. Publish an adventure and the numbers start here." }));
      return { title: "Insights", sub: S.org.name, body: wrap };
    }

    var chosenId = route.params.id || measurable[0].id;
    if (!api.getAdventure(chosenId)) chosenId = measurable[0].id;

    if (measurable.length > 1) {
      wrap.appendChild(el("div", { class: "np-seg-scroll", style: "margin-bottom:14px" }, [
        segmented(measurable.map(function (a) {
          return { value: a.id, label: a.title };
        }), chosenId, function (v) { go("analytics", { id: v }); })
      ]));
    }

    var a = api.analytics(chosenId);
    var comp = a.completion;

    wrap.appendChild(el("h1", { class: "np-h1", text: a.adventure.title }));
    wrap.appendChild(el("p", { class: "np-lede", text: "Version " + a.adventure.version + ". Each version is counted separately — change the route and the old numbers stay with the old route." }));

    wrap.appendChild(sectionHead("The walk overall"));
    wrap.appendChild(el("div", { class: "np-metrics" }, [
      metricTile("Looked at it", a.views, null, "distinct people"),
      metricTile("Set off", a.starts, null, "distinct people"),
      metricTile("Got to the end", pct(comp),
        comp && !comp.suppressed ? comp.n + " of " + comp.denom + " walks" : null),
      metricTile("Walked with someone", a.corroborated, null, "two or more phones together"),
      metricTile("Typical rating", a.medianRating, null, "out of 5")
    ]));

    wrap.appendChild(sectionHead("Where people give up"));
    wrap.appendChild(el("p", { class: "np-lede", text: "The most useful thing on this page. A sharp fall between two stops names the stop that is broken." }));

    var maxReached = 0;
    a.perStop.forEach(function (s) { if (s.reachedRaw > maxReached) maxReached = s.reachedRaw; });

    a.perStop.forEach(function (s) {
      var reachedTxt, widthPct = 0, isDrop = false;
      if (s.reached && s.reached.suppressed) {
        reachedTxt = "withheld";
      } else {
        reachedTxt = s.reached + " got here";
        widthPct = maxReached ? (s.reachedRaw / maxReached) * 100 : 0;
      }
      if (s.dropOff && !s.dropOff.suppressed && s.dropOff.denom) {
        var keep = s.dropOff.n / s.dropOff.denom;
        if (keep < 0.75) isDrop = true;
        reachedTxt += " · " + Math.round(keep * 100) + "% of the stop before";
      }
      wrap.appendChild(el("div", { class: "np-bar-row" + (isDrop ? " drop" : "") }, [
        el("div", { class: "np-bar-head" }, [
          el("span", { class: "np-bar-name", text: s.ord + ". " + s.title }),
          el("span", { class: "np-bar-num", text: reachedTxt })
        ]),
        el("div", { class: "np-bar-track" }, [
          el("div", { class: "np-bar-fill" + (isDrop ? " drop" : ""), style: "width:" + widthPct + "%" })
        ]),
        s.failRatio && !s.failRatio.suppressed && s.failRatio.n
          ? el("div", { class: "np-bar-flag" }, [
              el("span", { html: ICONS.warn, style: "flex:0 0 14px" }),
              el("span", { text: s.failRatio.n + " photo" + (s.failRatio.n === 1 ? "" : "s") + " rejected here. Usually the wording or your example photo, not the walkers." })
            ])
          : null
      ]));
    });

    wrap.appendChild(sectionHead("What you cannot see"));
    wrap.appendChild(el("div", { class: "np-note" }, [
      el("strong", { text: "Counts and rates only. " }),
      document.createTextNode("No names, no paths, no coordinates. Where fewer than " + a.threshold +
        " people have walked a stop, the figure is withheld instead of shown — on a small campus a number that low identifies the person it came from.")
    ]));

    if (api.tier().csv_export) {
      wrap.appendChild(el("button", {
        class: "np-btn np-btn-ghost np-btn-block", text: "Download as CSV",
        on: { click: function () { toast("Preview only — no file is generated"); } }
      }));
    } else {
      wrap.appendChild(el("div", { class: "np-hint", text: "Downloading these figures as a spreadsheet is an Institutional-plan feature." }));
    }

    return { title: "Insights", sub: S.org.name, body: wrap };
  }

  // ===========================================================================
  // VIEW: invite codes (§7)
  // ===========================================================================

  function viewInvites() {
    var wrap = el("div", { class: "np-wrap" });

    if (!api.tier().invite_codes) {
      wrap.appendChild(el("div", { class: "np-card" }, [
        el("div", { class: "np-card-title", text: "Not on your plan" }),
        el("div", { class: "np-card-meta", text: "Codes and printable QR posters come with Standard and above. You are on " + api.tier().label + "." })
      ]));
      wrap.appendChild(el("button", {
        class: "np-btn np-btn-ghost np-btn-block", text: "See plans",
        on: { click: function () { go("billing"); } }
      }));
      return { title: "Invites", sub: S.org.name, body: wrap };
    }

    wrap.appendChild(el("div", { class: "np-hero" }, [
      el("div", { class: "np-hero-eyebrow", text: "Getting people in" }),
      el("p", { text: "A code is how someone goes from a poster on a wall to walking your tour. Print the QR, stick it up, and a phone that has never heard of Nostia lands in the right place." })
    ]));

    wrap.appendChild(el("div", { class: "np-card" }, [
      el("div", { class: "np-card-title", text: "Two kinds of code" }),
      el("div", { class: "np-card-meta", text: "A membership code makes someone part of your organisation — an admissions office will want that. An adventure code unlocks one walk without joining anything — a tourist board would never accept forced sign-up. Both work." })
    ]));

    var published = api.listAdventures("published");
    wrap.appendChild(el("div", { class: "np-btn-row" }, [
      el("button", {
        class: "np-btn np-btn-sm", text: "New membership code",
        on: {
          click: function () {
            var res = api.mintCode(null, null);
            if (res.error) { toast(res.error, true); return; }
            render(); toast("Code created");
          }
        }
      }),
      published.length ? el("button", {
        class: "np-btn np-btn-ghost np-btn-sm", text: "New code for one adventure",
        on: {
          click: function () {
            var res = api.mintCode(published[0].id, 200);
            if (res.error) { toast(res.error, true); return; }
            render(); toast("Code created");
          }
        }
      }) : null
    ]));

    wrap.appendChild(sectionHead("Your codes", S.codes.length ? String(S.codes.length) : null));
    if (!S.codes.length) wrap.appendChild(el("div", { class: "np-empty", text: "No codes yet." }));

    S.codes.forEach(function (c) {
      var adv = c.org_adventure_id ? api.getAdventure(c.org_adventure_id) : null;
      var uses = c.use_count + (c.max_uses ? " of " + c.max_uses + " uses" : (c.use_count === 1 ? " use" : " uses"));
      var card = el("div", { class: "np-card" });
      card.appendChild(el("div", { class: "np-card-head" }, [
        el("div", { style: "min-width:0" }, [
          el("div", { class: "np-card-title np-mono", text: c.code }),
          el("div", {
            class: "np-card-meta",
            text: (adv ? "Unlocks “" + adv.title + "”" : "Joins your organisation") + " · " + uses
          })
        ]),
        el("span", {
          class: "np-pill " + (c.revoked_at ? "np-pill-bad" : "np-pill-ok"),
          text: c.revoked_at ? "Turned off" : "Working"
        })
      ]));
      card.appendChild(el("div", { class: "np-btn-row", style: "margin-top:12px" }, [
        el("button", {
          class: "np-btn np-btn-ghost np-btn-sm", text: "Poster / QR",
          on: { click: function () { openQrSheet(c); } }
        }),
        !c.revoked_at ? el("button", {
          class: "np-btn np-btn-danger np-btn-sm", text: "Turn it off",
          on: {
            click: function () {
              api.revokeCode(c.id);
              render();
              toast("Turned off — anyone who already used it keeps their access");
            }
          }
        }) : null
      ]));
      wrap.appendChild(card);
    });

    return { title: "Invites", sub: S.org.name, body: wrap };
  }

  function openQrSheet(c) {
    var link = api.codeLink(c.code);
    var svg;
    try { svg = qrSvg(link); } catch (e) { svg = null; }
    sheet = {
      title: "Print this",
      sub: "Stick it on a wall, a plaque, or the bottom of a leaflet.",
      body: [
        svg ? el("div", { class: "np-qr", html: svg }) : el("div", { class: "np-empty", text: "Could not draw the QR." }),
        el("div", { class: "np-code", text: c.code }),
        el("div", { class: "np-hint np-mono", style: "text-align:center", text: link }),
        el("div", { class: "np-note", text: "The square holds the web address rather than the bare code, so a phone with no app installed still ends up in the right place instead of nowhere." }),
        el("div", { class: "np-note", text: "This one is real and scannable — it was drawn here in the browser. Point a phone at it if you want to check." })
      ]
    };
    render();
  }

  // ===========================================================================
  // VIEW: plan & billing (§9) — READ ONLY. Captures nothing, by design.
  // ===========================================================================

  function viewBilling() {
    var wrap = el("div", { class: "np-wrap" });
    var t = api.tier();
    var active = S.subscription.status === "active";

    wrap.appendChild(el("div", { class: "np-hero" }, [
      el("div", { class: "np-hero-eyebrow", text: "Current plan" }),
      el("div", { class: "np-card-head" }, [
        el("div", { style: "min-width:0" }, [
          el("div", { class: "np-h1", style: "margin-bottom:2px", text: t.label }),
          el("div", { class: "np-card-meta", text: active ? "Renews " + String(S.subscription.current_period_end).slice(0, 10) : "Needs attention" })
        ]),
        el("span", { class: "np-pill " + (active ? "np-pill-ok" : "np-pill-bad"), text: active ? "Active" : S.subscription.status.replace("_", " ") })
      ])
    ]));

    wrap.appendChild(sectionHead("What you get"));
    wrap.appendChild(el("div", { class: "np-rows" }, [
      row("Live adventures", t.adventures === null ? "No limit" : String(t.adventures)),
      row("Stops in each", t.stops === null ? "No limit" : "Up to " + t.stops),
      row("Numbers and drop-off", t.analytics ? "Yes" : "No"),
      row("Your logo and colour", t.custom_branding ? "Yes" : "No"),
      row("Invite codes and QR", t.invite_codes ? "Yes" : "No"),
      row("Spreadsheet export", t.csv_export ? "Yes" : "No"),
      row("Assistant drafts a day", String(t.assist_calls_per_day))
    ]));

    // No price is shown anywhere. Price lives in Stripe and is read from config
    // so it can change without a deploy; the spec is explicit that the
    // mechanism ships and the number does not.
    wrap.appendChild(el("div", { class: "np-note" }, [
      el("strong", { text: "There is no price here yet. " }),
      document.createTextNode("Nobody has been asked to pay one. When there is a number it will live with the payment provider, not in the app, so it can change without shipping a new version.")
    ]));

    wrap.appendChild(sectionHead("If a payment fails"));
    wrap.appendChild(el("div", { class: "np-note", text: "Publishing something new stops. Nothing already live goes dark, and nobody mid-walk is interrupted. A QR code screwed to a wall outside a museum has to keep working even on the day a card expires." }));

    wrap.appendChild(el("div", { class: "np-note", text: "There is no card field anywhere in this preview and no way to pay from inside the app. Buying happens on the web." }));

    wrap.appendChild(demoDrawer(
      "Switch these and watch the rest of the preview change — stop limits, the invites tab, spreadsheet export and the publish checklist all react.",
      [
        el("div", { class: "np-label", text: "Pretend we are on" }),
        segmented([
          { value: "trial", label: "Trial" },
          { value: "standard", label: "Standard" },
          { value: "institutional", label: "Institutional" }
        ], S.subscription.tier, function (v) {
          S.subscription.tier = v;
          save(); render();
          toast("Now on " + TIERS[v].label);
        }),
        el("div", { class: "np-hint", style: "margin-bottom:14px", text: TIER_BLURB[S.subscription.tier] }),
        el("div", { class: "np-label", text: "Pretend the payment is" }),
        segmented([
          { value: "active", label: "Fine" },
          { value: "past_due", label: "Past due" },
          { value: "canceled", label: "Cancelled" }
        ], S.subscription.status, function (v) {
          S.subscription.status = v;
          save(); render();
          toast(v === "active" ? "Payment fine" : "Publishing paused — nothing went dark");
        })
      ]
    ));

    return { title: "Plan", sub: S.org.name, body: wrap };
  }

  // ===========================================================================
  // Render
  // ===========================================================================

  function routeKey() {
    return route.name + ":" + (route.params.id || route.params.advId || "") + ":" + (route.params.stepId || "");
  }

  function viewFor(name) {
    switch (name) {
      case "guide":     return viewGuide();
      case "editor":    return viewEditor();
      case "stop":      return viewStopEditor();
      case "run":       return viewRun();
      case "analytics": return viewAnalytics();
      case "invites":   return viewInvites();
      case "billing":   return viewBilling();
      default:          return viewList();
    }
  }

  function render() {
    if (!root) return;

    // Scrolling back to the top on every keystroke-triggered re-render made the
    // old editor unusable. Keep the offset whenever the route has not changed.
    var key = routeKey();
    var keep = (key === lastRouteKey && scrollNode) ? scrollNode.scrollTop : 0;

    clear(root);
    root.appendChild(el("div", {
      class: "np-preview-strip",
      text: "Preview · made-up data · no server · nothing is sent anywhere"
    }));

    var view = viewFor(route.name);

    scrollNode = el("div", { class: "np-scroll" }, [view.body]);

    if (view.chrome === false) {
      root.appendChild(scrollNode);
    } else {
      root.appendChild(topbar({ title: view.title, sub: view.sub, back: view.back }));
      root.appendChild(scrollNode);
      if (view.action) {
        root.appendChild(el("div", { class: "np-actionbar" }, [
          el("div", { class: "np-actionbar-inner" }, [view.action])
        ]));
      }
      root.appendChild(tabs());
    }

    scrollNode.scrollTop = keep;
    lastRouteKey = key;

    if (sheet) renderSheet();
  }

  function renderSheet() {
    var backdrop = el("div", { class: "np-sheet-backdrop" });
    backdrop.addEventListener("click", function (ev) {
      if (ev.target === backdrop) closeSheet();
    });

    var panel = el("div", {
      class: "np-sheet", role: "dialog", "aria-modal": "true", "aria-label": sheet.title, tabindex: "-1"
    }, [
      el("div", { class: "np-sheet-grip", "aria-hidden": "true" }),
      el("div", { class: "np-sheet-title", text: sheet.title }),
      sheet.sub ? el("div", { class: "np-sheet-sub", text: sheet.sub }) : null
    ]);

    sheet.body.forEach(function (n) { if (n) panel.appendChild(n); });
    // "Close", not "Cancel" — the invites screen already uses "cancel" to mean
    // revoking a code, and one word must not mean two things on one screen.
    panel.appendChild(el("button", {
      class: "np-btn np-btn-ghost np-btn-block", text: sheet.dismiss || "Close",
      style: "margin-top:12px",
      on: { click: closeSheet }
    }));

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    setTimeout(function () { panel.focus(); }, 0);
  }

  function closeSheet() { sheet = null; render(); }

  // ===========================================================================
  // Open / close — same lifecycle as MortarMode
  // ===========================================================================

  /* opts.tour forces the walkthrough even for someone who has already seen it.
     The visible button on the host site passes it, because a button that says
     "walkthrough" must always give you one. The hidden tap gesture passes
     nothing and keeps the show-it-once behaviour. */
  function open_(opts) {
    if (typeof document === "undefined") return;
    root = document.getElementById("pivot-root");
    if (!root) return;
    S = load();
    drawerOpen = false;
    lastRouteKey = null;
    stopDraftKey = null;
    sheet = null;
    stopSim();

    // First time in, explain the thing before showing a dashboard of it.
    if (!(opts && opts.tour) && guideSeen()) route = { name: "list", params: {} };
    else { guideIndex = 0; route = { name: "guide", params: {} }; }

    root.hidden = false;
    render();

    escHandler = function (ev) {
      if (ev.key !== "Escape" && ev.keyCode !== 27) return;
      if (sheet) { closeSheet(); return; }
      close_();
    };
    document.addEventListener("keydown", escHandler);
  }

  function close_() {
    stopSim();
    sheet = null;
    if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
    if (root) {
      root.hidden = true;
      clear(root);
    }
    scrollNode = null;
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
