/**
 * Cagiral Schedule — today, as an Übersicht desktop widget.
 *
 * Install: https://tracesof.net/uebersicht (free). Copy this whole
 * `cagiral-schedule.widget` folder into `~/Library/Application Support/Übersicht/widgets/`
 * — the `.widget` suffix on the folder name is how Übersicht discovers it. It renders
 * automatically once copied in; no separate "install" step.
 *
 * Übersicht widgets are a single JSX file exporting `command` (a shell command whose
 * stdout becomes `output`), `refreshFrequency` (ms), `className` (CSS-in-JS via Emotion,
 * used here for both position and look), and `render({ output, error })`.
 *
 * Fetches claudeAgent.json straight from the public repo via curl — the same read-only
 * path any device without a save token already uses. Reposition by editing `top`/`left`
 * below; Übersicht hot-reloads on save.
 *
 * Deliberately simplified colours, same reasoning as the iOS widget: today's items need
 * active/passive/reminder/done as the signal, not the app's full hashed group palette. A
 * group with an explicit override in _groups still gets its own colour; one without falls
 * back to status colour, so nothing here needs updating if that palette ever changes.
 */

export const command = 'curl -s "https://raw.githubusercontent.com/ucagiral/cagiral-schedule/main/claudeAgent.json"';

export const refreshFrequency = 300000; // 5 min — a desktop panel, no battery/data budget concern

export const className = `
  top: 40px;
  left: 40px;
  width: 260px;
  max-height: 420px;
  overflow: hidden;
  padding: 14px;
  border-radius: 10px;
  background: rgba(28, 31, 38, 0.82);
  backdrop-filter: blur(14px);
  color: #e6e8eb;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  font-size: 12px;
  box-shadow: 0 8px 24px rgba(0,0,0,.35);

  .header {
    font-size: 13px;
    font-weight: 650;
    margin-bottom: 8px;
    opacity: .95;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 3px 0;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%; flex: none;
  }
  .time {
    color: #9aa1ac;
    font-variant-numeric: tabular-nums;
    min-width: 40px;
  }
  .title {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .done { opacity: .5; text-decoration: line-through; }
  .muted { color: #9aa1ac; font-size: 11px; margin-top: 4px; }
  .error { color: #f87171; font-size: 11px; }
`;

const COLOR = {
  active: "#2563eb",
  passive: "#94a3b8",
  reminder: "#78716c",
  done: "#9ca3af",
  overdue: "#f59e0b"
};

const TIMED_CAP = 12;

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
  if (ev.group && groups[ev.group] && groups[ev.group].color) return groups[ev.group].color;
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  if (ev.type !== "passive" && ev.end && timeToMin(ev.end) < nowMin) return COLOR.overdue;
  return ev.type === "passive" ? COLOR.passive : COLOR.active;
}

function Row({ ev, groups }) {
  const isReminder = ev.type === "reminder";
  return (
    <div className="row">
      <span className="dot" style={{ background: eventColor(ev, groups) }} />
      <span className="time">{isReminder ? "📌" : (ev.start || "")}</span>
      <span className={"title" + (ev.status === "done" ? " done" : "")}>{ev.title || "(untitled)"}</span>
    </div>
  );
}

export const render = ({ output, error }) => {
  if (error) return <div className="error">Couldn't run curl</div>;
  if (!output) return <div className="muted">Loading…</div>;

  let data;
  try { data = JSON.parse(output); }
  catch (e) { return <div className="error">Couldn't parse schedule.json</div>; }

  const events = data.events || [];
  const groups = data._groups || {};
  const today = todayIso();
  const live = events.filter(e => e.date === today && e.status !== "cancelled");
  const reminders = live.filter(e => e.type === "reminder");
  const timed = live
    .filter(e => e.type !== "reminder")
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));

  const shownTimed = timed.slice(0, TIMED_CAP);

  return (
    <div>
      <div className="header">Today</div>
      {reminders.map(ev => <Row key={ev.id} ev={ev} groups={groups} />)}
      {reminders.length > 0 && shownTimed.length > 0 && <div style={{ height: 4 }} />}
      {shownTimed.length
        ? shownTimed.map(ev => <Row key={ev.id} ev={ev} groups={groups} />)
        : reminders.length === 0 && <div className="muted">Nothing scheduled</div>}
      {timed.length > TIMED_CAP && (
        <div className="muted">+{timed.length - TIMED_CAP} more today</div>
      )}
    </div>
  );
};
