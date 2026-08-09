#!/usr/bin/env node
/* Build questions.json for a given day from bank.json.
 *
 * Rotation, not regeneration. Each tier draws the 10 questions that were used
 * least recently (never-used first, then oldest `used` date, ties broken by a
 * date-seeded shuffle). A question therefore cannot reappear until every other
 * question in its tier has been shown — with the current bank that is a 3-day
 * floor for the smallest tier and 9 days for the largest, and it grows every
 * time the bank does. That is the fix for questions cycling: grow bank.json,
 * never hand-write questions.json.
 *
 * Usage:
 *   node tools/build-daily.js              # today (UTC)
 *   node tools/build-daily.js 2026-08-10   # a specific day
 *   node tools/build-daily.js --dry-run    # print, write nothing
 *   node tools/build-daily.js --check      # validate bank + output, write nothing
 */

"use strict";

var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var BANK_PATH = path.join(ROOT, "bank.json");
var OUT_PATH = path.join(ROOT, "questions.json");

var PER_OPPONENT = 10;
var CHOICES_PER_QUESTION = 4;

// Opponent metadata lives here, not in the bank, so the bank stays pure
// content. Order is the order they appear in the app.
var OPPONENTS = [
  { id: "timmy", name: "Timmy", iq: 70 },
  { id: "crow", name: "Crow", iq: 90 },
  { id: "bob", name: "Bob", iq: 100 },
  { id: "einstein", name: "Einstein", iq: 180 },
  { id: "claude", name: "Claude", iq: 1000 }
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function isDateStr(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Deterministic PRNG so the same date always produces the same paper.
function seedFrom(str) {
  var h = 2166136261;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed) {
  var s = seed || 1;
  return function () {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function shuffle(arr, rng) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rng() * (i + 1));
    var t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// ---------------------------------------------------------------------------
// Validation — a bad answer key is the worst possible failure, so this is
// strict and runs on every build.
// ---------------------------------------------------------------------------
function validateBank(bank) {
  var errors = [];

  if (!bank || !Array.isArray(bank.questions)) {
    return ["bank.json has no questions array"];
  }

  var seenIds = {};
  var seenStems = {};
  var tiers = {};

  bank.questions.forEach(function (q, i) {
    var where = "question[" + i + "] " + (q && q.id ? q.id : "(no id)");

    if (!q || typeof q !== "object") {
      errors.push(where + ": not an object");
      return;
    }
    if (typeof q.id !== "string" || !q.id) {
      errors.push(where + ": missing id");
    } else if (seenIds[q.id]) {
      errors.push(where + ": duplicate id");
    } else {
      seenIds[q.id] = true;
    }

    if (typeof q.tier !== "string" || !q.tier) {
      errors.push(where + ": missing tier");
    } else {
      tiers[q.tier] = (tiers[q.tier] || 0) + 1;
    }

    if (typeof q.q !== "string" || q.q.trim().length < 3) {
      errors.push(where + ": missing or trivial question text");
    } else {
      var stem = q.q.trim().toLowerCase();
      if (seenStems[stem]) errors.push(where + ": duplicate question text");
      seenStems[stem] = true;
    }

    if (!Array.isArray(q.choices) || q.choices.length !== CHOICES_PER_QUESTION) {
      errors.push(where + ": needs exactly " + CHOICES_PER_QUESTION + " choices");
    } else {
      var seenChoice = {};
      q.choices.forEach(function (c) {
        if (typeof c !== "string" || !c.trim()) {
          errors.push(where + ": empty choice");
        }
        var key = String(c).trim().toLowerCase();
        if (seenChoice[key]) {
          errors.push(where + ": duplicate choice '" + c + "'");
        }
        seenChoice[key] = true;
      });
    }

    if (
      typeof q.answer !== "number" ||
      q.answer % 1 !== 0 ||
      q.answer < 0 ||
      q.answer >= CHOICES_PER_QUESTION
    ) {
      errors.push(where + ": answer must be an integer 0.." + (CHOICES_PER_QUESTION - 1));
    }

    if (q.used !== null && !isDateStr(q.used)) {
      errors.push(where + ": used must be null or YYYY-MM-DD");
    }
  });

  OPPONENTS.forEach(function (op) {
    var n = tiers[op.id] || 0;
    if (n < PER_OPPONENT) {
      errors.push(
        "tier '" + op.id + "' has only " + n + " questions; needs at least " + PER_OPPONENT
      );
    }
  });

  return errors;
}

function validateOutput(out) {
  var errors = [];
  if (!isDateStr(out.date)) errors.push("output: bad date");
  if (!Array.isArray(out.opponents) || out.opponents.length !== OPPONENTS.length) {
    errors.push("output: expected " + OPPONENTS.length + " opponents");
    return errors;
  }
  out.opponents.forEach(function (op) {
    if (!Array.isArray(op.questions) || op.questions.length !== PER_OPPONENT) {
      errors.push("output: " + op.id + " must have exactly " + PER_OPPONENT + " questions");
      return;
    }
    op.questions.forEach(function (q, i) {
      if (!Array.isArray(q.choices) || q.choices.length !== CHOICES_PER_QUESTION) {
        errors.push("output: " + op.id + " q" + i + " bad choices");
      }
      if (typeof q.answer !== "number" || q.answer < 0 || q.answer >= CHOICES_PER_QUESTION) {
        errors.push("output: " + op.id + " q" + i + " bad answer index");
      }
    });
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
// Least-recently-used: never-used questions first, then oldest used date.
// The date-seeded shuffle only breaks ties, so rotation stays fair but the
// paper still differs day to day.
function pickForTier(bank, tier, rng) {
  var pool = bank.questions.filter(function (q) {
    return q.tier === tier;
  });
  if (pool.length < PER_OPPONENT) {
    throw new Error(
      "tier '" + tier + "' has " + pool.length + " questions; need " + PER_OPPONENT
    );
  }

  var shuffled = shuffle(pool, rng);
  shuffled.sort(function (a, b) {
    if (a.used === b.used) return 0;
    if (a.used === null) return -1;
    if (b.used === null) return 1;
    return a.used < b.used ? -1 : 1;
  });

  return shuffled.slice(0, PER_OPPONENT);
}

// Shuffle the choice order so a question's correct slot moves between
// appearances — the answer key can't be memorised positionally.
function renderQuestion(q, rng) {
  var correct = q.choices[q.answer];
  var choices = shuffle(q.choices, rng);
  return {
    q: q.q,
    choices: choices,
    answer: choices.indexOf(correct)
  };
}

function build(date, bank) {
  var rng = makeRng(seedFrom(date));
  var opponents = OPPONENTS.map(function (op) {
    var picked = pickForTier(bank, op.id, rng);
    picked.forEach(function (q) {
      q.used = date; // stamp rotation state back onto the bank
    });
    return {
      id: op.id,
      name: op.name,
      iq: op.iq,
      questions: picked.map(function (q) {
        return renderQuestion(q, rng);
      })
    };
  });
  return { date: date, opponents: opponents };
}

// ---------------------------------------------------------------------------
// Serialisation — match the hand-written house style: 2-space indent, one
// question per line, key order q / choices / answer.
// ---------------------------------------------------------------------------
function serialiseQuestions(out) {
  var lines = ["{", '  "date": ' + JSON.stringify(out.date) + ",", '  "opponents": ['];
  out.opponents.forEach(function (op, oi) {
    lines.push("    {");
    lines.push('      "id": ' + JSON.stringify(op.id) + ",");
    lines.push('      "name": ' + JSON.stringify(op.name) + ",");
    lines.push('      "iq": ' + op.iq + ",");
    lines.push('      "questions": [');
    op.questions.forEach(function (q, qi) {
      lines.push(
        "        { " +
          '"q": ' + JSON.stringify(q.q) + ", " +
          '"choices": ' + JSON.stringify(q.choices) + ", " +
          '"answer": ' + q.answer +
          " }" +
          (qi === op.questions.length - 1 ? "" : ",")
      );
    });
    lines.push("      ]");
    lines.push("    }" + (oi === out.opponents.length - 1 ? "" : ","));
  });
  lines.push("  ]");
  lines.push("}");
  return lines.join("\n") + "\n";
}

function serialiseBank(bank) {
  var lines = ["{", '  "version": ' + JSON.stringify(bank.version) + ","];
  lines.push('  "note": ' + JSON.stringify(bank.note) + ",");
  lines.push('  "questions": [');
  bank.questions.forEach(function (q, i) {
    var parts = [
      '"id": ' + JSON.stringify(q.id),
      '"tier": ' + JSON.stringify(q.tier),
      '"q": ' + JSON.stringify(q.q),
      '"choices": ' + JSON.stringify(q.choices),
      '"answer": ' + q.answer
    ];
    if (q.src) parts.push('"src": ' + JSON.stringify(q.src));
    parts.push('"used": ' + JSON.stringify(q.used === undefined ? null : q.used));
    lines.push(
      "    { " + parts.join(", ") + " }" + (i === bank.questions.length - 1 ? "" : ",")
    );
  });
  lines.push("  ]");
  lines.push("}");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  var args = process.argv.slice(2);
  var dryRun = args.indexOf("--dry-run") !== -1;
  var checkOnly = args.indexOf("--check") !== -1;
  var dateArg = args.filter(function (a) {
    return a.indexOf("--") !== 0;
  })[0];
  var date = dateArg || todayUTC();

  if (!isDateStr(date)) {
    console.error("Bad date '" + date + "'. Expected YYYY-MM-DD.");
    process.exit(1);
  }

  var bank;
  try {
    bank = JSON.parse(fs.readFileSync(BANK_PATH, "utf8"));
  } catch (e) {
    console.error("Could not read bank.json: " + e.message);
    process.exit(1);
  }

  var bankErrors = validateBank(bank);
  if (bankErrors.length) {
    console.error("bank.json is invalid — refusing to build:");
    bankErrors.slice(0, 40).forEach(function (e) {
      console.error("  - " + e);
    });
    if (bankErrors.length > 40) {
      console.error("  ... and " + (bankErrors.length - 40) + " more");
    }
    process.exit(1);
  }

  var counts = {};
  bank.questions.forEach(function (q) {
    counts[q.tier] = (counts[q.tier] || 0) + 1;
  });

  var out = build(date, bank);

  var outErrors = validateOutput(out);
  if (outErrors.length) {
    console.error("generated questions.json is invalid — refusing to write:");
    outErrors.forEach(function (e) {
      console.error("  - " + e);
    });
    process.exit(1);
  }

  console.log("Date: " + date);
  Object.keys(counts).forEach(function (tier) {
    var days = Math.floor(counts[tier] / PER_OPPONENT);
    console.log(
      "  " + tier + ": " + counts[tier] + " in bank (repeats no sooner than " + days + " days)"
    );
  });

  if (checkOnly) {
    console.log("OK — bank and generated output both valid. Nothing written (--check).");
    return;
  }
  if (dryRun) {
    console.log("--dry-run: nothing written. First Crow question would be:");
    console.log("  " + out.opponents[1].questions[0].q);
    return;
  }

  fs.writeFileSync(OUT_PATH, serialiseQuestions(out));
  fs.writeFileSync(BANK_PATH, serialiseBank(bank));
  console.log("Wrote questions.json and stamped rotation state in bank.json.");
}

main();
