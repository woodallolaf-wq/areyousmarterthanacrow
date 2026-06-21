/* Smarter Than A Crow — all logic.
 * Zero backend. localStorage only. Never assume it is reliable. */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  var STORAGE_KEY = "stac_state";
  var WIN_SCORE = 10; // beating = perfect. Anything less = did not beat.
  // Known opponent ids. Used only as a fallback so state is well-formed even
  // before questions.json loads. The source of truth for play is questions.json.
  var KNOWN_IDS = ["crow", "timmy", "parrot", "bob", "einstein", "claude"];

  // Human-readable labels for trophy ids. Unknown ids fall back to the raw id
  // so new trophies can be added in data without touching this file.
  var TROPHY_LABELS = {
    beat_crow: "Smarter than a crow",
    beat_timmy: "Smarter than Timmy",
    beat_parrot: "Smarter than a parrot",
    beat_bob: "Smarter than Bob",
    beat_einstein: "Smarter than Einstein",
    beat_claude: "Smarter than Claude",
    lost_to_timmy: "Dumber than Timmy"
  };

  // ---------------------------------------------------------------------------
  // Runtime data (not persisted)
  // ---------------------------------------------------------------------------
  var opponents = []; // loaded from questions.json
  var opponentsById = {}; // id -> opponent

  // Active test session
  var session = null; // { id, questions, index, correct }

  // ---------------------------------------------------------------------------
  // State (persisted)
  // ---------------------------------------------------------------------------
  function defaultState() {
    var streaks = {};
    var lastPlayed = {};
    KNOWN_IDS.forEach(function (id) {
      streaks[id] = 0;
      lastPlayed[id] = null;
    });
    return { streaks: streaks, lastPlayed: lastPlayed, trophies: [] };
  }

  function loadState() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      // localStorage unavailable (private mode, blocked). Run in-memory.
      return defaultState();
    }

    if (raw === null) {
      var fresh = defaultState();
      saveState(fresh);
      return fresh;
    }

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = null;
    }
    return backfill(parsed);
  }

  // Guarantee shape. Never assume any sub-key exists.
  function backfill(state) {
    if (!state || typeof state !== "object") {
      state = {};
    }
    if (!state.streaks || typeof state.streaks !== "object") {
      state.streaks = {};
    }
    if (!state.lastPlayed || typeof state.lastPlayed !== "object") {
      state.lastPlayed = {};
    }
    if (!Array.isArray(state.trophies)) {
      state.trophies = [];
    }
    // Ensure known ids exist with sane defaults. Unknown ids already present in
    // storage are left untouched (forward-compatible).
    KNOWN_IDS.forEach(function (id) {
      if (typeof state.streaks[id] !== "number") state.streaks[id] = 0;
      if (!(id in state.lastPlayed)) state.lastPlayed[id] = null;
    });
    return state;
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // Storage may be full or blocked. Fail silently; app stays usable.
    }
  }

  // Read a streak for any id, defaulting to 0 if absent (json-only opponent).
  function streakFor(state, id) {
    return typeof state.streaks[id] === "number" ? state.streaks[id] : 0;
  }

  // ---------------------------------------------------------------------------
  // Dates / locking
  // ---------------------------------------------------------------------------
  function today() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function isLocked(state, id) {
    return state.lastPlayed[id] === today();
  }

  // ---------------------------------------------------------------------------
  // Trophies
  // ---------------------------------------------------------------------------
  function awardTrophy(state, trophyId) {
    if (state.trophies.indexOf(trophyId) === -1) {
      state.trophies.push(trophyId);
      return true; // newly awarded
    }
    return false;
  }

  function trophyLabel(trophyId) {
    return TROPHY_LABELS[trophyId] || trophyId;
  }

  // ---------------------------------------------------------------------------
  // Screen routing
  // ---------------------------------------------------------------------------
  var SCREENS = [
    "intro",
    "home",
    "opponents",
    "test",
    "result",
    "rewards",
    "error"
  ];

  function show(name) {
    SCREENS.forEach(function (s) {
      var el = document.getElementById("screen-" + s);
      if (el) el.hidden = s !== name;
    });
    window.scrollTo(0, 0);
  }

  function $(id) {
    return document.getElementById(id);
  }

  // ---------------------------------------------------------------------------
  // SCREEN: Opponents
  // ---------------------------------------------------------------------------
  function renderOpponents() {
    var state = loadState();
    var list = $("opponents-list");
    list.innerHTML = "";

    if (!opponents.length) {
      var note = document.createElement("li");
      note.className = "empty-note";
      note.textContent = "No opponents available.";
      list.appendChild(note);
      return;
    }

    opponents.forEach(function (op) {
      var li = document.createElement("li");
      var locked = isLocked(state, op.id);
      var streak = streakFor(state, op.id);

      var btn = document.createElement("button");
      btn.className = "opponent-row";
      btn.disabled = locked;

      var left = document.createElement("span");
      left.className = "op-name";
      left.textContent = op.name;

      var right = document.createElement("span");
      right.className = "op-meta";
      if (locked) {
        right.innerHTML =
          '<span class="op-locked">Played today</span>';
      } else {
        right.innerHTML =
          "IQ " + op.iq + "<br>Streak: " + streak;
      }

      btn.appendChild(left);
      btn.appendChild(right);

      if (!locked) {
        btn.addEventListener("click", function () {
          startTest(op.id);
        });
      }

      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  // ---------------------------------------------------------------------------
  // SCREEN: Test
  // ---------------------------------------------------------------------------
  function startTest(id) {
    var state = loadState();
    if (isLocked(state, id)) {
      // Guard: should be unreachable from UI. Bounce home.
      goHome();
      return;
    }

    var op = opponentsById[id];
    if (!op || !Array.isArray(op.questions) || op.questions.length === 0) {
      // Opponent missing or has no questions — don't crash.
      showError("This opponent has no questions today.");
      return;
    }

    session = {
      id: id,
      name: op.name,
      questions: op.questions,
      index: 0,
      correct: 0
    };

    $("test-opponent").textContent = "vs " + op.name;
    show("test");
    renderQuestion();
  }

  function renderQuestion() {
    var q = session.questions[session.index];
    var total = session.questions.length;

    $("test-progress").textContent =
      "Question " + (session.index + 1) + " / " + total;

    // Guard against malformed question objects.
    var text = q && typeof q.q === "string" ? q.q : "(question unavailable)";
    var choices = q && Array.isArray(q.choices) ? q.choices : [];

    $("test-question").textContent = text;

    var box = $("test-choices");
    box.innerHTML = "";

    if (!choices.length) {
      // Malformed question — let the user skip it as incorrect.
      var skip = document.createElement("button");
      skip.className = "choice";
      skip.textContent = "Skip (no answer available)";
      skip.addEventListener("click", function () {
        answer(-1);
      });
      box.appendChild(skip);
      return;
    }

    choices.forEach(function (choice, i) {
      var btn = document.createElement("button");
      btn.className = "choice";
      btn.textContent = choice;
      btn.addEventListener("click", function () {
        answer(i);
      });
      box.appendChild(btn);
    });
  }

  function answer(choiceIndex) {
    var q = session.questions[session.index];
    if (q && choiceIndex === q.answer) {
      session.correct += 1;
    }
    session.index += 1;

    if (session.index >= session.questions.length) {
      finishTest(session.id, session.correct);
    } else {
      renderQuestion();
    }
  }

  function finishTest(id, correctCount) {
    var state = loadState();
    state.lastPlayed[id] = today();

    var didBeat = correctCount === WIN_SCORE;

    if (didBeat) {
      state.streaks[id] = streakFor(state, id) + 1;
    } else {
      state.streaks[id] = 0;
    }

    var newTrophy = null;
    if (didBeat) {
      if (awardTrophy(state, "beat_" + id)) newTrophy = "beat_" + id;
    }
    if (id === "timmy" && !didBeat) {
      if (awardTrophy(state, "lost_to_timmy")) newTrophy = "lost_to_timmy";
    }

    saveState(state);
    renderResult(id, correctCount, didBeat, newTrophy, state);
  }

  // ---------------------------------------------------------------------------
  // SCREEN: Result
  // ---------------------------------------------------------------------------
  function renderResult(id, correctCount, didBeat, newTrophy, state) {
    var op = opponentsById[id];
    var name = op ? op.name : id;
    var total = op && Array.isArray(op.questions) ? op.questions.length : WIN_SCORE;

    $("result-headline").textContent = didBeat
      ? "You beat " + name + "."
      : "You did not beat " + name + ".";

    $("result-score").textContent = correctCount + " / " + total;

    $("result-verdict").textContent = didBeat
      ? "Smarter than " + name + "."
      : "Not smart enough. Come back tomorrow.";

    $("result-streak").textContent =
      "Current " + name + " streak: " + streakFor(state, id);

    var trophyEl = $("result-trophy");
    if (newTrophy) {
      trophyEl.hidden = false;
      trophyEl.innerHTML =
        '<div class="trophy-title">New trophy</div>' +
        '<div class="trophy-name"></div>';
      trophyEl.querySelector(".trophy-name").textContent =
        trophyLabel(newTrophy);
    } else {
      trophyEl.hidden = true;
      trophyEl.innerHTML = "";
    }

    show("result");
  }

  // ---------------------------------------------------------------------------
  // SCREEN: Rewards
  // ---------------------------------------------------------------------------
  function renderRewards() {
    var state = loadState();

    // Streaks — show all opponents from questions.json (json is source of truth).
    var streaksList = $("rewards-streaks");
    streaksList.innerHTML = "";

    if (opponents.length) {
      opponents.forEach(function (op) {
        var li = document.createElement("li");
        var row = document.createElement("div");
        row.className = "info-row";
        var label = document.createElement("span");
        label.className = "label";
        label.textContent = op.name;
        var val = document.createElement("span");
        val.textContent = streakFor(state, op.id);
        row.appendChild(label);
        row.appendChild(val);
        li.appendChild(row);
        streaksList.appendChild(li);
      });
    } else {
      var sNote = document.createElement("li");
      sNote.className = "empty-note";
      sNote.textContent = "No opponents loaded.";
      streaksList.appendChild(sNote);
    }

    // Trophies
    var trophyList = $("rewards-trophies");
    trophyList.innerHTML = "";

    if (state.trophies.length) {
      state.trophies.forEach(function (tid) {
        var li = document.createElement("li");
        var row = document.createElement("div");
        row.className = "info-row";
        var label = document.createElement("span");
        label.className = "label";
        label.textContent = trophyLabel(tid);
        row.appendChild(label);
        li.appendChild(row);
        trophyList.appendChild(li);
      });
    } else {
      var tNote = document.createElement("li");
      tNote.className = "empty-note";
      tNote.textContent = "No trophies yet.";
      trophyList.appendChild(tNote);
    }

    show("rewards");
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------
  function goHome() {
    show("home");
  }

  function showError(msg) {
    if (msg) $("error-message").textContent = msg;
    show("error");
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  // Has the user ever used the site before? Any recorded attempt, any streak,
  // or any trophy counts as prior use. Robust to which opponent was played
  // first and to future opponents — not tied specifically to the crow.
  function hasPlayedBefore(state) {
    var anyPlayed = Object.keys(state.lastPlayed).some(function (id) {
      return state.lastPlayed[id] !== null;
    });
    var anyStreak = Object.keys(state.streaks).some(function (id) {
      return state.streaks[id] > 0;
    });
    return anyPlayed || anyStreak || state.trophies.length > 0;
  }

  function decideEntryScreen() {
    var state = loadState();
    // The intro IS the first crow attempt, so only a brand-new visitor sees it.
    // Anyone who has already used the site lands straight on Home (the screen
    // you reach after that first crow test).
    if (hasPlayedBefore(state)) {
      goHome();
    } else {
      show("intro");
    }
  }

  function loadQuestions() {
    // Cache-bust so a redeployed questions.json is picked up. (The daily lock is
    // by date, not by content, so this never grants an extra attempt.)
    return fetch("questions.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.opponents)) {
          throw new Error("Malformed questions.json");
        }
        opponents = data.opponents.filter(function (op) {
          return op && typeof op.id === "string";
        });
        opponentsById = {};
        opponents.forEach(function (op) {
          opponentsById[op.id] = op;
        });
      });
  }

  function boot() {
    loadQuestions()
      .then(function () {
        decideEntryScreen();
      })
      .catch(function (err) {
        showError("Could not load today's questions. Check your connection.");
        // Keep the error in console for debugging without crashing the UI.
        if (window.console) console.error(err);
      });
  }

  // ---------------------------------------------------------------------------
  // Wire up static buttons
  // ---------------------------------------------------------------------------
  function wireEvents() {
    // Intro: clicking starts the crow test directly (counts as first attempt).
    $("intro-start").addEventListener("click", function () {
      startTest("crow");
    });

    $("home-test").addEventListener("click", function () {
      renderOpponents();
      show("opponents");
    });

    $("home-rewards").addEventListener("click", renderRewards);

    $("error-retry").addEventListener("click", boot);

    // Any element with data-nav="home"
    document.querySelectorAll('[data-nav="home"]').forEach(function (el) {
      el.addEventListener("click", goHome);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    wireEvents();
    boot();
  });
})();
