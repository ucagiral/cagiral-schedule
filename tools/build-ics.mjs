// Build schedule.ics from claudeAgent.json.
//
// This file is the ONLY thing that generates calendar data — never hand-write schedule.ics,
// and never generate calendar data independently of claudeAgent.json.
//
// Run:  node tools/build-ics.mjs
// CI:   .github/workflows/ics.yml runs this on every change to claudeAgent.json.
//
// No dependencies, no network. Node 18+.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "claudeAgent.json");
const OUT = join(ROOT, "schedule.ics");

const CAL_NAME = "Cagiral Schedule";
const TZID = "Europe/Istanbul";          // Turkey: permanent UTC+3, no DST since 2016
const UID_DOMAIN = "cagiral-schedule";
const ALARM_MINUTES = 15;                // lead time on hands-on work

// ---------------------------------------------------------------- helpers

// RFC 5545 wants CRLF and lines folded at 75 octets, continuations starting with a space.
// Fold on character boundaries while counting UTF-8 bytes, so multi-byte characters
// (Turkish ı/ş/ğ, the ✓ mark) never get split down the middle.
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) {
      out.push(cur);
      cur = ch;
      curBytes = n;
      limit = 74; // continuation lines carry a leading space
    } else {
      cur += ch;
      curBytes += n;
    }
  }
  if (cur) out.push(cur);
  return out.join("\r\n ");
}

// Escape TEXT values per RFC 5545: backslash, semicolon, comma, and newlines.
function esc(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    date.getUTCFullYear() + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) +
    "T" + p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + "Z"
  );
}

// "2026-08-14" + "09:15" -> "20260814T091500" (local wall time, paired with TZID)
function localStamp(dateStr, timeStr) {
  const [h, m] = String(timeStr || "00:00").split(":");
  return dateStr.replace(/-/g, "") + "T" + String(h).padStart(2, "0") + String(m).padStart(2, "0") + "00";
}

function addMinutes(dateStr, timeStr, minutes) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = String(timeStr || "00:00").split(":").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi));
  dt.setUTCMinutes(dt.getUTCMinutes() + minutes);
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: dt.getUTCFullYear() + "-" + p(dt.getUTCMonth() + 1) + "-" + p(dt.getUTCDate()),
    time: p(dt.getUTCHours()) + ":" + p(dt.getUTCMinutes())
  };
}

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// ---------------------------------------------------------------- build

const raw = JSON.parse(readFileSync(SRC, "utf8"));
const events = Array.isArray(raw.events) ? raw.events : [];
const today = todayIso();

// Derive the revision stamp from the data, not from the clock, so this script is a
// pure function of claudeAgent.json. Otherwise every rebuild would differ byte-for-byte
// and CI would commit a "new" feed even when nothing about the schedule had changed.
const metaStamp = raw && raw._meta && raw._meta.lastModified ? new Date(raw._meta.lastModified) : null;
const revision = metaStamp && !isNaN(metaStamp.getTime()) ? metaStamp : new Date();

// SEQUENCE must be a non-decreasing integer. Minutes since the epoch gives that,
// and only matters to clients tracking per-event revisions — subscribed calendars
// are replaced wholesale on refresh.
const sequence = Math.floor(revision.getTime() / 60000) % 2147483647;

const lines = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//cagiral-schedule//weekly planner//EN",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "X-WR-CALNAME:" + esc(CAL_NAME),
  "X-WR-TIMEZONE:" + TZID,
  "X-WR-CALDESC:" + esc("Lab schedule — generated from claudeAgent.json. Do not edit here; edits are overwritten."),
  // Hints to the subscribing client about how often to come back.
  "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  "X-PUBLISHED-TTL:PT1H",
  // Fixed-offset zone: Turkey abolished DST in 2016, so a single STANDARD rule is correct.
  "BEGIN:VTIMEZONE",
  "TZID:" + TZID,
  "X-LIC-LOCATION:" + TZID,
  "BEGIN:STANDARD",
  "DTSTART:19700101T000000",
  "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300",
  "TZNAME:+03",
  "END:STANDARD",
  "END:VTIMEZONE"
];

// A reminder has no hour in claudeAgent.json — that's the point of the type — but a
// VEVENT needs a concrete time to hang a notification on. This is where one gets made
// up, purely for the feed; it is never written back to the source data.
const REMINDER_TIME = "10:00";
const REMINDER_SPAN_MIN = 1;

let counts = { total: 0, alarms: 0, cancelled: 0, done: 0, skipped: 0 };

for (const ev of events) {
  const isReminder = ev.type === "reminder";
  if (!ev || !ev.id || !ev.date) { counts.skipped++; continue; }
  if (!isReminder && (!ev.start || !ev.end)) { counts.skipped++; continue; }

  const isCancelled = ev.status === "cancelled";
  const isDone = ev.status === "done";
  const isPassive = ev.type === "passive";
  const isFuture = ev.date >= today;

  const startTime = isReminder ? REMINDER_TIME : ev.start;
  let endDate = ev.date, endTime;
  if (isReminder) {
    const bumped = addMinutes(ev.date, REMINDER_TIME, REMINDER_SPAN_MIN);
    endDate = bumped.date; endTime = bumped.time;
  } else {
    // Guard against zero-length or inverted spans so clients don't discard the event.
    endTime = ev.end;
    if (String(ev.end) <= String(ev.start)) {
      const bumped = addMinutes(ev.date, ev.start, 15);
      endDate = bumped.date; endTime = bumped.time;
    }
  }

  const descParts = [];
  if (ev.notes) descParts.push(ev.notes);
  descParts.push(isReminder ? "Reminder — no fixed hour, flagged for this day" :
    (isPassive ? "Passive — runs unattended, does not block time" : "Active — needs you there"));
  if (ev.group) descParts.push("Group: " + ev.group);
  if (ev.category) descParts.push("Category: " + ev.category);
  if (isDone) descParts.push("Marked done.");

  lines.push("BEGIN:VEVENT");
  lines.push("UID:" + ev.id + "@" + UID_DOMAIN);
  lines.push("DTSTAMP:" + stamp(revision));
  lines.push("SEQUENCE:" + sequence);
  lines.push("DTSTART;TZID=" + TZID + ":" + localStamp(ev.date, startTime));
  lines.push("DTEND;TZID=" + TZID + ":" + localStamp(endDate, endTime));
  lines.push("SUMMARY:" + esc((isDone ? "✓ " : "") + (isReminder ? "📌 " : "") + (ev.title || "(untitled)")));
  lines.push("DESCRIPTION:" + esc(descParts.join("\n")));
  // Both the group and the category become CATEGORIES values, so Calendar clients that
  // support filtering can pick out a whole experiment thread (e.g. "Virus prep").
  // Each value is escaped separately — the comma between them is the list separator
  // and must stay unescaped, unlike commas inside a value.
  {
    const cats = [];
    if (ev.group) cats.push(esc(ev.group));
    if (ev.category) cats.push(esc(ev.category));
    if (cats.length) lines.push("CATEGORIES:" + cats.join(","));
  }
  lines.push("STATUS:" + (isCancelled ? "CANCELLED" : "CONFIRMED"));
  // Passive incubations and reminders shouldn't make you look busy.
  lines.push("TRANSP:" + (isPassive || isReminder || isCancelled || isDone ? "TRANSPARENT" : "OPAQUE"));

  // Alarms only on things still ahead of us — otherwise subscribing would fire a
  // burst of notifications for months of history. A reminder fires once, right at
  // its made-up anchor time, rather than the lead-time active work gets.
  if (!isCancelled && !isDone && isFuture && (isReminder || !isPassive)) {
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push("DESCRIPTION:" + esc(ev.title || (isReminder ? "Reminder" : "Scheduled work")));
    lines.push("TRIGGER:" + (isReminder ? "PT0M" : "-PT" + ALARM_MINUTES + "M"));
    lines.push("END:VALARM");
    counts.alarms++;
  }

  lines.push("END:VEVENT");
  counts.total++;
  if (isCancelled) counts.cancelled++;
  if (isDone) counts.done++;
}

lines.push("END:VCALENDAR");

const ics = lines.map(fold).join("\r\n") + "\r\n";
writeFileSync(OUT, ics, "utf8");

console.log(
  `schedule.ics: ${counts.total} events (${counts.alarms} with alarms, ` +
  `${counts.done} done, ${counts.cancelled} cancelled, ${counts.skipped} skipped as incomplete)`
);
