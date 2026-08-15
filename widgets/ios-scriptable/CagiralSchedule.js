// Cagiral Schedule — today, for a Scriptable home-screen widget.
//
// Install: https://scriptable.app (free). Paste this whole file into a new script named
// "CagiralSchedule", then long-press the Home Screen → + → Scriptable → small or medium →
// add → tap the placeholder → Script: CagiralSchedule, When Interacting: Run Script.
//
// Reads claudeAgent.json straight from the public repo — the same read-only path any
// device without a save token already uses. iOS decides the real refresh cadence for a
// widget; refreshAfterDate below is only a hint, not a guarantee.
//
// Deliberately simplified colours: this shows today's items, not a whole week, so the
// signal that matters is active/passive/reminder/done — not full group-colour fidelity.
// A group with an explicit override in _groups still gets its own pinned colour; a group
// without one falls back to the status colour rather than the app's hashed palette, so
// nothing here needs updating if that palette ever changes.

const DATA_URL = "https://raw.githubusercontent.com/ucagiral/cagiral-schedule/main/claudeAgent.json";

const COLOR = {
  active: new Color("#2563eb"),
  passive: new Color("#94a3b8"),
  reminder: new Color("#78716c"),
  done: new Color("#9ca3af"),
  overdue: new Color("#f59e0b"),
  text: Color.dynamic(new Color("#1f2430"), new Color("#e6e8eb")),
  muted: Color.dynamic(new Color("#6b7280"), new Color("#9aa1ac")),
  bg: Color.dynamic(new Color("#ffffff"), new Color("#1c1f26"))
};

function todayIso() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function timeToMin(t) {
  const p = String(t || "00:00").split(":");
  return (+p[0]) * 60 + (+p[1]);
}

function eventColor(ev, groups) {
  if (ev.type === "reminder") return COLOR.reminder;
  if (ev.status === "done") return COLOR.done;
  if (ev.group && groups[ev.group] && groups[ev.group].color) return new Color(groups[ev.group].color);
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  if (ev.type !== "passive" && ev.end && timeToMin(ev.end) < nowMin) return COLOR.overdue;
  return ev.type === "passive" ? COLOR.passive : COLOR.active;
}

async function fetchSchedule() {
  const req = new Request(DATA_URL);
  req.timeoutInterval = 15;
  const data = await req.loadJSON();
  return { events: data.events || [], groups: data._groups || {} };
}

function buildRows(events) {
  const today = todayIso();
  const live = events.filter(e => e.date === today && e.status !== "cancelled");
  const reminders = live.filter(e => e.type === "reminder");
  const timed = live
    .filter(e => e.type !== "reminder")
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return { reminders, timed };
}

function addRow(stack, ev, groups, opts) {
  const row = stack.addStack();
  row.centerAlignContent();
  row.spacing = 6;

  const dot = row.addText("●");
  dot.font = Font.systemFont(9);
  dot.textColor = eventColor(ev, groups);

  const isReminder = ev.type === "reminder";
  const label = isReminder ? "📌" : (ev.start || "");
  const time = row.addText(label);
  time.font = Font.mediumSystemFont(11);
  time.textColor = COLOR.muted;
  time.minimumScaleFactor = 0.8;
  if (!opts.compact) row.addSpacer(0);

  const title = row.addText(ev.title || "(untitled)");
  title.font = Font.systemFont(12);
  title.textColor = ev.status === "done" ? COLOR.muted : COLOR.text;
  title.lineLimit = 1;
  title.minimumScaleFactor = 0.85;

  if (ev.status === "done") {
    const check = row.addText("✓");
    check.font = Font.systemFont(11);
    check.textColor = COLOR.done;
  }
  return row;
}

async function buildWidget() {
  const w = new ListWidget();
  w.backgroundColor = COLOR.bg;
  w.setPadding(12, 12, 12, 12);
  w.url = "https://ucagiral.github.io/cagiral-schedule/"; // tap the widget to open the app

  const header = w.addText("Today");
  header.font = Font.boldSystemFont(13);
  header.textColor = COLOR.text;
  w.addSpacer(6);

  let reminders = [], timed = [], errored = false;
  try {
    const { events, groups } = await fetchSchedule();
    ({ reminders, timed } = buildRows(events));
    var groupMap = groups;
  } catch (e) {
    errored = true;
  }

  if (errored) {
    const msg = w.addText("Couldn't load schedule");
    msg.font = Font.systemFont(12);
    msg.textColor = COLOR.muted;
    w.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000); // retry sooner on failure
    return w;
  }

  const size = config.widgetFamily; // "small" | "medium" | "large" | undefined in-app
  const reminderCap = size === "small" ? 1 : 2;
  const timedCap = size === "small" ? 1 : (size === "large" ? 10 : 5);

  reminders.slice(0, reminderCap).forEach(ev => addRow(w, ev, groupMap, { compact: true }));
  if (reminders.length > reminderCap) {
    const more = w.addText("+" + (reminders.length - reminderCap) + " more reminders");
    more.font = Font.systemFont(10);
    more.textColor = COLOR.muted;
  }
  if (reminders.length) w.addSpacer(4);

  const remaining = timed.filter(e => e.status !== "done");
  const shown = remaining.length ? remaining : timed; // if everything's done, show it anyway
  shown.slice(0, timedCap).forEach(ev => { addRow(w, ev, groupMap, { compact: false }); w.addSpacer(3); });

  if (!shown.length) {
    const empty = w.addText("Nothing scheduled");
    empty.font = Font.systemFont(12);
    empty.textColor = COLOR.muted;
  } else if (shown.length > timedCap) {
    const more = w.addText("+" + (shown.length - timedCap) + " more today");
    more.font = Font.systemFont(10);
    more.textColor = COLOR.muted;
  }

  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000); // hint only — iOS decides the real cadence
  return w;
}

const widget = await buildWidget();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
