// Rules for the Reminders app. Pure functions: no DOM, no fetch, no clock -- "now" and ids
// are always arguments. The browser, the service worker and the Worker all load this one
// file, and tools/todo-selftest.mjs runs it in node.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TodoEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MIN_EVERY = 1;        // minutes
  var MAX_EVERY = 1440;     // one day
  var HOLD_MS = 2500;       // how long "Done" must be held to count

  // A task: { id, title, due (epoch ms | null), everyMin (int | null), seq, created }
  // `due` and `everyMin` are both null for a task with no time: it is listed, never pushed.
  function makeTask(o) {
    var title = String(o.title == null ? "" : o.title).replace(/\s+/g, " ").trim();
    if (!title) return { error: "A task needs a title." };
    var due = o.due == null || o.due === "" ? null : Number(o.due);
    if (due !== null && !isFinite(due)) return { error: "The date and time are not valid." };
    var every = null;
    if (due !== null) {
      every = o.everyMin == null || o.everyMin === "" ? 10 : Number(o.everyMin);
      if (!isInteger(every) || every < MIN_EVERY || every > MAX_EVERY) {
        return { error: "Repeat interval must be a whole number of minutes, " + MIN_EVERY + " to " + MAX_EVERY + "." };
      }
    }
    return { task: { id: o.id, title: title, due: due, everyMin: every, seq: o.seq, created: o.now } };
  }

  function isInteger(n) { return typeof n === "number" && isFinite(n) && Math.floor(n) === n; }

  // Timed tasks first, soonest to latest; then the rest in the order they were added.
  // Ties on time fall back to the order added, so the list never reshuffles between renders.
  function sortOpen(tasks) {
    return tasks.slice().sort(function (a, b) {
      var at = a.due !== null, bt = b.due !== null;
      if (at !== bt) return at ? -1 : 1;
      if (at && a.due !== b.due) return a.due - b.due;
      return a.seq - b.seq;
    });
  }

  // `sent` maps task id -> epoch ms of the last push for it.
  // A task is pushed when its time has come and either nothing was sent yet or a full
  // interval has passed since the last push. It repeats until it is removed (completed).
  function dueToSend(tasks, sent, now) {
    return tasks.filter(function (t) {
      if (t.due === null || t.everyMin == null) return false;
      if (now < t.due) return false;
      var last = sent && sent[t.id];
      return last == null || now - last >= t.everyMin * 60000;
    });
  }

  function isOverdue(t, now) { return t.due !== null && now >= t.due; }

  // Progress (0..1) of a press-and-hold that started at `start`.
  function holdProgress(start, now) {
    if (start == null) return 0;
    return Math.max(0, Math.min(1, (now - start) / HOLD_MS));
  }
  function holdComplete(start, now) { return holdProgress(start, now) >= 1; }

  // Text for a notification: ALL open tasks, soonest first, so the lock screen shows the
  // whole list and not only what just came due. "!" marks a task whose time has come.
  var MAX_LINES = 5;
  function notificationText(tasks, now) {
    var open = sortOpen(tasks), n = open.length;
    if (!n) return { title: "Reminders", body: "No open tasks." };
    var due = open.filter(function (t) { return isOverdue(t, now); }).length;
    var lines = open.slice(0, MAX_LINES).map(function (t) { return (isOverdue(t, now) ? "! " : "- ") + t.title; });
    if (n > MAX_LINES) lines.push("+" + (n - MAX_LINES) + " more");
    return { title: n + " open" + (due ? " \u00b7 " + due + " due" : ""), body: lines.join("\n") };
  }

  // ---- daily summary: a notification at fixed local times even when nothing is due.
  var MAX_SLOTS = 200;
  var SUMMARY_WINDOW = 15;   // minutes after a slot during which a missed poll is still made up

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  // "08:00, 20:30" -> ["08:00","20:30"]; empty string -> [] (summary off).
  // A range "08:15-21:00/5" means every 5 minutes from 08:15 to 21:00 inclusive.
  function parseTimes(str) {
    var parts = String(str == null ? "" : str).split(/[,;\s]+/).filter(Boolean), out = [];
    function add(min) { var t = pad2(Math.floor(min / 60)) + ":" + pad2(min % 60); if (out.indexOf(t) < 0) out.push(t); }
    for (var i = 0; i < parts.length; i++) {
      var r = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\/(\d{1,3})$/.exec(parts[i]);
      if (r) {
        var a = Number(r[1]) * 60 + Number(r[2]), b = Number(r[3]) * 60 + Number(r[4]), step = Number(r[5]);
        if (Number(r[1]) > 23 || Number(r[2]) > 59 || Number(r[3]) > 23 || Number(r[4]) > 59 || step < 1 || step > 720 || b < a) {
          return { error: "\"" + parts[i] + "\" is not a valid range. Use START-END/MINUTES, for example 08:15-21:00/5." };
        }
        for (var m = a; m <= b; m += step) add(m);
        continue;
      }
      var m1 = /^(\d{1,2}):(\d{2})$/.exec(parts[i]);
      if (!m1 || Number(m1[1]) > 23 || Number(m1[2]) > 59) {
        return { error: "\"" + parts[i] + "\" is not a time. Use HH:MM (08:00) or a range (08:15-21:00/5)." };
      }
      add(Number(m1[1]) * 60 + Number(m1[2]));
    }
    if (out.length > MAX_SLOTS) return { error: "At most " + MAX_SLOTS + " summary times." };
    return { times: out.sort() };
  }

  function validZone(tz) {
    try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return typeof tz === "string" && tz.length > 0; } catch (e) { return false; }
  }

  // Server-side check of what the app sends. Returns {times, tz} or null if it is not valid.
  function cleanSummary(o) {
    if (!o || !Array.isArray(o.times) || !validZone(o.tz)) return null;
    var p = parseTimes(o.times.join(","));
    return p.error ? null : { times: p.times, tz: o.tz };
  }

  // Local calendar date ("YYYY-MM-DD") and minutes since midnight at `ms` in zone `tz`.
  function localParts(ms, tz) {
    var f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    var g = {};
    f.formatToParts(new Date(ms)).forEach(function (p) { g[p.type] = p.value; });
    return { date: g.year + "-" + g.month + "-" + g.day, min: Number(g.hour) * 60 + Number(g.minute) };
  }

  // Slots whose moment has come (within SUMMARY_WINDOW) and that were not yet sent today.
  // `sent` maps slot -> the local date it was last sent for.
  function summaryDue(summary, sent, now) {
    if (!summary || !summary.times || !summary.times.length || !validZone(summary.tz)) return [];
    var lp = localParts(now, summary.tz);
    return summary.times.filter(function (slot) {
      var m = /^(\d{2}):(\d{2})$/.exec(slot);
      var late = lp.min - (Number(m[1]) * 60 + Number(m[2]));
      return late >= 0 && late < SUMMARY_WINDOW && !(sent && sent[slot] === lp.date);
    });
  }

  // The slice of a task the server needs: enough to decide when to push, nothing else.
  function serverView(t) { return { id: t.id, title: t.title, due: t.due, everyMin: t.everyMin }; }

  // Keeps `lastSent` for tasks that still exist and forgets it for the rest, so a completed
  // task cannot leave stale bookkeeping behind and a re-used id never inherits an old time.
  function mergeServerTasks(incoming, previousSent) {
    var sent = {}, out = [];
    incoming.forEach(function (t) {
      out.push(serverView(t));
      if (previousSent && previousSent[t.id] != null) sent[t.id] = previousSent[t.id];
    });
    return { tasks: out, sent: sent };
  }

  return {
    MIN_EVERY: MIN_EVERY, MAX_EVERY: MAX_EVERY, HOLD_MS: HOLD_MS,
    makeTask: makeTask, sortOpen: sortOpen, dueToSend: dueToSend, isOverdue: isOverdue,
    holdProgress: holdProgress, holdComplete: holdComplete,
    notificationText: notificationText, parseTimes: parseTimes, cleanSummary: cleanSummary,
    localParts: localParts, summaryDue: summaryDue, SUMMARY_WINDOW: SUMMARY_WINDOW, serverView: serverView, mergeServerTasks: mergeServerTasks
  };
});
