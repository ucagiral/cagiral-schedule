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

  // Text for a push notification, from the tasks that are due.
  function notificationText(due) {
    var n = due.length;
    if (!n) return { title: "Reminders", body: "Open tasks are waiting." };
    var shown = due.slice(0, 3).map(function (t) { return t.title; });
    var more = n - shown.length;
    return {
      title: n === 1 ? "1 task due" : n + " tasks due",
      body: shown.join("\n") + (more > 0 ? "\n+" + more + " more" : "")
    };
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
    notificationText: notificationText, serverView: serverView, mergeServerTasks: mergeServerTasks
  };
});
