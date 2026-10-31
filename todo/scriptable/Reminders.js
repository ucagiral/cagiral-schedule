// Scriptable widget for the Reminders app. Paste into Scriptable as a script named "Reminders".
// It reads the open tasks from the Worker and draws them. Read-only: nothing can be completed here.
//
// Rules (order, which task is "due") come from the Worker's own engine.js, so they cannot drift.
// The access token is asked once and kept in the iOS Keychain on this phone -- not in this file.

const BASE = "https://todo-worker.caalabworkersdev.workers.dev";
const KEY = "todo_token";

async function token() {
  if (Keychain.contains(KEY)) return Keychain.get(KEY);
  const a = new Alert();
  a.title = "Reminders access token";
  a.message = "The AUTH_TOKEN you set on the server. Stored in the Keychain on this phone only.";
  a.addSecureTextField("token");
  a.addAction("Save");
  await a.present();
  const t = a.textFieldValue(0).trim();
  if (t) Keychain.set(KEY, t);
  return t;
}

async function loadEngine() {
  const code = await new Request(BASE + "/engine.js").loadString();
  const m = { exports: {} };
  new Function("module", code)(m);
  return m.exports;
}

function fmt(ms) {
  const d = new Date(ms), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + time;
}

const widget = new ListWidget();
widget.url = BASE;
widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);   // a hint; iOS decides the real cadence

try {
  const t = await token();
  const req = new Request(BASE + "/api/tasks");
  req.headers = { Authorization: "Bearer " + t };
  const res = await req.loadJSON();
  if (!res.tasks) { Keychain.remove(KEY); throw new Error("Token rejected. Run the script in Scriptable to enter it again."); }
  const E = await loadEngine();
  const now = Date.now();
  const open = E.sortOpen(res.tasks.map((x, i) => Object.assign({ seq: i }, x)));
  const due = open.filter((x) => E.isOverdue(x, now)).length;

  const family = config.widgetFamily || "large";
  const accessory = String(family).indexOf("accessory") === 0;
  const maxLines = { small: 4, medium: 5, large: 11, extraLarge: 11, accessoryRectangular: 3, accessoryInline: 1, accessoryCircular: 1 }[family] || 8;

  const head = widget.addText(open.length + " open" + (due ? " · " + due + " due" : ""));
  head.font = Font.boldSystemFont(accessory ? 12 : 16);
  if (!accessory) widget.addSpacer(6);

  const shown = open.length > maxLines ? maxLines - 1 : maxLines;
  open.slice(0, shown).forEach((x) => {
    const late = E.isOverdue(x, now);
    const line = widget.addText((late ? "! " : "• ") + x.title + (x.due !== null && !accessory ? "  " + fmt(x.due) : ""));
    line.font = Font.systemFont(accessory ? 11 : 13);
    line.lineLimit = 1;
    if (late && !accessory) line.textColor = Color.red();
  });
  if (open.length > shown) {
    const more = widget.addText("+" + (open.length - shown) + " more");
    more.font = Font.systemFont(accessory ? 11 : 12);
    more.textOpacity = 0.7;
  }
  if (!open.length) widget.addText("No open tasks.");
} catch (e) {
  widget.addText(String(e.message || e)).font = Font.systemFont(12);
}

if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentLarge();
Script.complete();
