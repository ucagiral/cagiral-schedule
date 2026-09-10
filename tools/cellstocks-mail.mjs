// Sends the daily freezer layout by email, over SMTP, with no dependencies.
//
// Run:  node tools/cellstocks-mail.mjs
//       env: MAIL_USER, MAIL_PASSWORD, and optionally MAIL_HOST / MAIL_PORT / MAIL_FROM
//
// Why this rather than one of the ready-made "send an email" Actions: it would be given
// the mailbox's app password on every run, and this repository is public. This is ~150
// lines of the SMTP a mail server has spoken since 1982, in the same spirit as xlsx.js
// and pdf.js beside it -- auditable in one sitting, and the password never leaves the
// runner or this file.
//
// It reads cellstocks/exports/recipients.json for the address list. An empty list is a
// setting, not a fault: the files are still built and committed, and nothing is sent.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPORTS = join(ROOT, "cellstocks", "exports");
const CRLF = "\r\n";

// ------------------------------------------------------------------ building the message
//
// Everything here is a pure function of its inputs, which is what makes the message
// itself testable without a server: the selftest builds one and reads it back.

// Anything outside ASCII in a header has to be an RFC 2047 encoded-word, or the subject
// arrives as mojibake. Turkish subjects go through this every day.
export function encodeHeader(value) {
  const s = String(value === null || value === undefined ? "" : value);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";
}

function wrap(base64) {
  return (base64.match(/.{1,76}/g) || []).join(CRLF);
}

export function buildMessage({ from, to, subject, text, attachments, date }) {
  const boundary = "cellstocks-" + Buffer.from(String(date || "") + subject).toString("hex").slice(0, 24);
  const head = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${(date ? new Date(date) : new Date()).toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ].join(CRLF);

  // The body is base64 too, rather than 8bit: it carries box names and cell lines, which
  // in this lab are frequently Turkish, and a server that only speaks 7 bits would
  // otherwise mangle them silently.
  const parts = [
    ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
     wrap(Buffer.from(text, "utf8").toString("base64"))].join(CRLF)
  ];

  (attachments || []).forEach((a) => {
    parts.push([
      `Content-Type: ${a.mimeType || "application/octet-stream"}; name="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${a.filename}"`,
      "",
      wrap(a.content.toString("base64"))
    ].join(CRLF));
  });

  const body = parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF) + `${CRLF}--${boundary}--${CRLF}`;
  return head + CRLF + CRLF + body;
}

// A bare "." on a line ends the DATA command, so any line of the message that already
// starts with one has to be doubled. Miss this and a message can be truncated by its own
// contents -- rare, but silent, and impossible to debug from the receiving end.
export function dotStuff(message) {
  return message.split(/\r\n|\n/).map((line) => (line.startsWith(".") ? "." + line : line)).join(CRLF);
}

// ------------------------------------------------------------------------ the conversation
//
// `connect` is injectable so the selftest can drive the whole exchange over a plain
// socket against a fake server, and assert on exactly what was said.
export function sendMail(options) {
  const { host, port, user, password, from, to, message, connect } = options;
  const open = connect || ((opts, cb) => tlsConnect(opts, cb));

  return new Promise((resolve, reject) => {
    const transcript = [];
    let buffer = "";
    let pending = null;
    let done = false;

    const socket = open({ host, port, servername: host }, () => step());
    socket.setEncoding("utf8");
    socket.on("error", fail);
    socket.on("close", () => { if (!done) fail(new Error("the server closed the connection early")); });

    function fail(err) {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (e) { /* already gone */ }
      err.transcript = transcript;
      reject(err);
    }

    // A reply can span several lines: "250-STARTTLS" and so on, ending with a line whose
    // fourth character is a space rather than a hyphen.
    socket.on("data", (chunk) => {
      buffer += chunk;
      let m;
      while ((m = /^(\d{3})([ -])([\s\S]*?)\r\n/.exec(buffer))) {
        const line = buffer.slice(0, m[0].length);
        buffer = buffer.slice(m[0].length);
        transcript.push("< " + line.trim());
        if (m[2] === " " && pending) {
          const waiting = pending;
          pending = null;
          waiting(Number(m[1]), line.trim());
        }
      }
    });

    function say(command, expect, next) {
      transcript.push("> " + (/^AUTH|^[A-Za-z0-9+/=]{8,}$/.test(command) ? "(credentials)" : command));
      pending = (code, line) => {
        if (expect.indexOf(code) === -1) {
          return fail(new Error(`the mail server refused "${command.split(" ")[0]}": ${line}`));
        }
        next();
      };
      socket.write(command + CRLF);
    }

    const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");
    const recipients = to.slice();

    function step() {
      pending = (code, line) => {
        if (code !== 220) return fail(new Error(`unexpected greeting: ${line}`));
        say("EHLO cellstocks", [250], () =>
          say("AUTH LOGIN", [334], () =>
            say(b64(user), [334], () =>
              say(b64(password), [235], () =>
                say(`MAIL FROM:<${from}>`, [250], sendRecipients)))));
      };
    }

    function sendRecipients() {
      if (!recipients.length) {
        return say("DATA", [354], () => {
          transcript.push(`> (the message, ${message.length} bytes)`);
          pending = (code, line) => {
            if (code !== 250) return fail(new Error(`the message was rejected: ${line}`));
            say("QUIT", [221], () => { done = true; socket.end(); resolve(transcript); });
          };
          socket.write(dotStuff(message) + CRLF + "." + CRLF);
        });
      }
      const next = recipients.shift();
      // 251 is "will forward", which is a yes.
      say(`RCPT TO:<${next}>`, [250, 251], sendRecipients);
    }
  });
}

// --------------------------------------------------------------------------- when to send
//
// The workflow used to fire once a day at 05:00 UTC and send whatever it found. That is the
// top of the hour -- the most contended slot on GitHub's shared scheduler -- and GitHub's own
// docs say runs there are delayed and may be dropped outright. The very first morning it was
// due, nothing ran at all.
//
// So the cron is a *poll* now, every half hour, and this decides. Two consequences fall out
// of that, both of them things Umut asked for:
//
//   * a delayed or dropped poll is covered by the next one, so a skipped morning heals
//     itself instead of being silently lost;
//   * the send time stops being a literal in the workflow and becomes data -- which is what
//     lets an admin change it from inside the app, without anyone touching a YAML file.
//
// Pure, and `now` is an argument: the same rule the engine follows, and the only way to test
// midnight, a late poll and a DST shift without waiting for one.
const DEFAULT_SEND_AT = "07:30";
const DEFAULT_TIME_ZONE = "Europe/Istanbul";

// Local wall-clock date and time in a named zone, with no dependency: Intl has done this
// since Node 14 and it knows about DST, which hand-rolled offset arithmetic does not.
export function localClock(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  }).formatToParts(now instanceof Date ? now : new Date(now));
  const at = (t) => (parts.filter((p) => p.type === t)[0] || {}).value;
  // Some ICU builds render midnight as "24" rather than "00" under hour12:false.
  const hour = at("hour") === "24" ? "00" : at("hour");
  return { date: `${at("year")}-${at("month")}-${at("day")}`, time: `${hour}:${at("minute")}` };
}

export function shouldSendNow({ now, sendAt, timeZone, lastMailedDate }) {
  const zone = timeZone || DEFAULT_TIME_ZONE;
  const want = normaliseTime(sendAt) || DEFAULT_SEND_AT;
  let local;
  try {
    local = localClock(now, zone);
  } catch (err) {
    // An unknown zone is a setting somebody typed wrong. Fall back rather than never
    // mailing again -- a mail an hour off is recoverable, silence is not.
    local = localClock(now, DEFAULT_TIME_ZONE);
    return { send: false, localDate: local.date, localTime: local.time, sendAt: want,
             reason: `${timeZone} is not a time zone I know -- fix it in the app; nothing sent.` };
  }
  if (lastMailedDate === local.date) {
    return { send: false, localDate: local.date, localTime: local.time, sendAt: want,
             reason: `today's layout already went out (${local.date}).` };
  }
  // >= rather than ==: this is what makes a late poll still send, which is the whole point.
  if (local.time < want) {
    return { send: false, localDate: local.date, localTime: local.time, sendAt: want,
             reason: `it is ${local.time} in ${zone}; the layout goes out at ${want}.` };
  }
  return { send: true, localDate: local.date, localTime: local.time, sendAt: want,
           reason: `${local.time} in ${zone} is at or past ${want}, and nothing has gone out today.` };
}

// "8:00", "08:00", "8" and "0800" are all things a person types into a time field.
export function normaliseTime(value) {
  const m = /^\s*(\d{1,2})\s*[:.]?\s*(\d{2})?\s*$/.exec(String(value === null || value === undefined ? "" : value));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2] || 0);
  if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null;
  return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
}

// ------------------------------------------------------------------------------- the run
//
// One file holds who the mail goes to and when. It is the one path under exports/ the
// worker lets the app write, and it is admin-only there -- so the send time inherits
// exactly the right permission without the worker having to learn about it.
export function readMailSettings(dir) {
  const file = join(dir || EXPORTS, "recipients.json");
  const fallback = { emails: [], sendAt: DEFAULT_SEND_AT, timeZone: DEFAULT_TIME_ZONE };
  if (!existsSync(file)) return fallback;
  let body;
  try {
    body = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    // A list nobody can parse is not an empty list: refuse rather than silently
    // deciding that today nobody wanted the mail.
    throw new Error("cellstocks/exports/recipients.json is not valid JSON");
  }
  return {
    emails: (body.emails || []).filter((a) => typeof a === "string" && /\S@\S+\.\S/.test(a)),
    // A file written before there was a time in it still works, and still sends.
    sendAt: normaliseTime(body.sendAt) || DEFAULT_SEND_AT,
    timeZone: typeof body.timeZone === "string" && body.timeZone ? body.timeZone : DEFAULT_TIME_ZONE
  };
}

// Kept because it reads better at the call sites that only want the addresses.
export function readRecipients(dir) {
  return readMailSettings(dir).emails;
}

// The one piece of state: which day's mail has already gone. Written only by the Action,
// never by the app, so an admin editing the recipient list cannot race it.
export function readLastMailed(dir) {
  const file = join(dir || EXPORTS, "last-mailed.json");
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")).date || null; } catch (err) { return null; }
}

// Called only once the server has accepted the message. A send that failed must NOT be
// recorded, or the next poll would decide today was done and nobody would get anything.
export function recordSent(dir, date, count, now) {
  writeFileSync(join(dir || EXPORTS, "last-mailed.json"),
    JSON.stringify({ date: date, sentAt: (now || new Date()).toISOString(), to: count }, null, 2) + "\n");
}

// A box's location is a whole path now, and a path can contain a comma the same way a box
// name always could, so the summary reads the rows properly rather than splitting on every
// comma it finds. A quoted cell doubles its own quotes; that is the whole grammar.
export function parseCsvRow(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') { cell += ch; continue; }
      if (line[i + 1] === '"') { cell += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { cells.push(cell); cell = ""; continue; }
    cell += ch;
  }
  cells.push(cell);
  return cells;
}

// `areaCount` is passed in rather than counted from the rows: the summary is per box, so
// a lab whose freezers hold no boxes yet would otherwise be reported as having no
// freezers, which is not the same thing and is exactly the state this lab was in the
// morning it was first set up.
//
// "Storage area" rather than "freezer": the top layer of the tree is whatever the admin
// named it, and in this lab that is already a freezer, a fridge and a nitrogen tank.
export function summarise(csvText, areaCount) {
  const lines = csvText.replace(/^﻿/, "").trim().split(/\r?\n/).slice(1).filter(Boolean);
  const boxes = lines.map((line) => {
    const cells = parseCsvRow(line);
    return { area: cells[0], box: cells[2], owner: cells[3], used: Number(cells[6]), capacity: Number(cells[7]) };
  });
  const placed = boxes.filter((b) => b.area && b.area !== "Not placed yet");
  const areas = areaCount === undefined ? new Set(placed.map((b) => b.area)).size : areaCount;
  const areaText = `${areas} storage area${areas === 1 ? "" : "s"}`;
  if (!boxes.length) return `${areaText}, with no boxes set up in them yet.`;

  const used = boxes.reduce((n, b) => n + (b.used || 0), 0);
  const full = boxes.filter((b) => b.capacity && b.used / b.capacity > 0.9);
  const homeless = boxes.length - placed.length;
  const out = [
    `${boxes.length} box${boxes.length === 1 ? "" : "es"} across ${areaText}.`,
    `${used} vial${used === 1 ? "" : "s"} stored, in ${boxes.filter((b) => b.used).length} of those boxes.`
  ];
  // Boxes with no home are the one thing in here that is somebody's to act on, so they
  // are named rather than folded into the total.
  if (homeless) {
    out.push(`${homeless} box${homeless === 1 ? " has" : "es have"} not been placed in the ` +
             `tree yet: ` + boxes.filter((b) => !placed.includes(b)).map((b) => b.box).join(", ") + ".");
  }
  if (full.length) {
    out.push("Nearly full: " + full.map((b) => `${b.box} (${b.used}/${b.capacity})`).join(", ") + ".");
  }
  return out.join("\n");
}

// Pure, so the drive-link line can be checked without a real fixture repo or mail server:
// present when today's grid-roster made it to Drive, absent when it didn't (no secrets
// configured yet, or today's upload failed) -- either way the mail still goes out.
export function buildBodyText({ summary, driveLink }) {
  return [
    "Today's freezer layout is attached, in five shapes:",
    "",
    "  layout.xlsx      a grid sheet per box, every slot with its cell line and passage",
    "  layout.pdf       the printable map for the freezer door",
    "  layout.csv       one row per box: where it is, whose, how full",
    "  roster.xlsx      one flat sheet per member (active vials only), plus a lab-wide log",
    "  grid-roster.xlsx one flat sheet per member, every slot in every one of their boxes,",
    "                   empty or not, in the order the boxes actually sit in the freezer",
    "",
    summary,
    "",
    ...(driveLink ? [`Always-current copy of grid-roster.xlsx, view-only: ${driveLink}`, ""] : []),
    "Rebuilt from the inventory this morning."
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const settings = readMailSettings();

  // The cron polls every half hour. --check answers "is this poll the day's send?" and
  // writes send=true|false to $GITHUB_OUTPUT so the workflow can skip building, committing
  // and mailing on the other 47 polls. The rule lives here, once, rather than being
  // half-restated in YAML.
  if (process.argv.includes("--check")) {
    const when = shouldSendNow({
      now: new Date(),
      sendAt: settings.sendAt,
      timeZone: settings.timeZone,
      lastMailedDate: readLastMailed()
    });
    console.log(when.reason);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `send=${when.send}\n`);
    }
    process.exit(0);
  }

  const user = process.env.MAIL_USER;
  const password = (process.env.MAIL_PASSWORD || "").replace(/\s+/g, "");  // app passwords are shown in groups of four
  if (!user || !password) {
    console.log("MAIL_USER / MAIL_PASSWORD are not set -- the export was built but is not being mailed.");
    process.exit(0);
  }

  const to = settings.emails;
  if (!to.length) {
    console.log("nobody is on the recipients list -- the export was built but is not being mailed.");
    process.exit(0);
  }

  const attachments = [
    { filename: "layout.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    { filename: "layout.pdf", mimeType: "application/pdf" },
    { filename: "layout.csv", mimeType: "text/csv; charset=UTF-8" },
    { filename: "roster.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    { filename: "grid-roster.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
  ].map((a) => Object.assign({}, a, { content: readFileSync(join(EXPORTS, a.filename)) }));

  const areaCount = () => {
    try {
      const lab = JSON.parse(readFileSync(join(ROOT, "cellstocks", "lab-storage.json"), "utf8"));
      return (lab.children || []).length;
    } catch (err) { return undefined; }
  };
  // Written by cellstocks-drive-upload.mjs, which runs before this in the workflow. Its
  // absence (no Drive secrets configured yet, or today's upload failed) is not an error
  // here -- the mail still goes out with five attachments and no link line.
  const driveLink = () => {
    try {
      const id = readFileSync(join(EXPORTS, "drive-file-id.txt"), "utf8").trim();
      return id ? `https://drive.google.com/file/d/${id}/view` : null;
    } catch (err) { return null; }
  };
  const today = new Date().toISOString().slice(0, 10);
  const text = buildBodyText({
    summary: summarise(readFileSync(join(EXPORTS, "layout.csv"), "utf8"), areaCount()),
    driveLink: driveLink()
  });

  sendMail({
    host: process.env.MAIL_HOST || "smtp.gmail.com",
    port: Number(process.env.MAIL_PORT || 465),
    user, password,
    from: process.env.MAIL_FROM || user,
    to,
    message: buildMessage({
      from: process.env.MAIL_FROM || user,
      to, subject: `CAA Lab freezer layout — ${today}`, text, attachments, date: new Date()
    })
  }).then(() => {
    // Only after the server has accepted it. Written before this and a send that failed
    // would still count as today's, and the next poll would not retry.
    const local = localClock(new Date(), settings.timeZone);
    recordSent(EXPORTS, local.date, to.length);
    console.log(`mailed today's layout to ${to.length} address(es); marked ${local.date} as sent`);
  }).catch((err) => {
    // The transcript never contains the credentials -- say() redacts them -- so it is
    // safe in a public build log, and it is the only way to tell a wrong password from
    // a blocked port from a rejected recipient.
    console.error("could not send the layout: " + err.message);
    if (err.transcript) console.error(err.transcript.join("\n"));
    process.exit(1);
  });
}
