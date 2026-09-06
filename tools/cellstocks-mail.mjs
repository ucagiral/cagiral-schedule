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

import { readFileSync, existsSync } from "node:fs";
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

// ------------------------------------------------------------------------------- the run
export function readRecipients(dir) {
  const file = join(dir || EXPORTS, "recipients.json");
  if (!existsSync(file)) return [];
  try {
    const body = JSON.parse(readFileSync(file, "utf8"));
    return (body.emails || []).filter((a) => typeof a === "string" && /\S@\S+\.\S/.test(a));
  } catch (err) {
    // A list nobody can parse is not an empty list: refuse rather than silently
    // deciding that today nobody wanted the mail.
    throw new Error("cellstocks/exports/recipients.json is not valid JSON");
  }
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const user = process.env.MAIL_USER;
  const password = (process.env.MAIL_PASSWORD || "").replace(/\s+/g, "");  // app passwords are shown in groups of four
  if (!user || !password) {
    console.log("MAIL_USER / MAIL_PASSWORD are not set -- the export was built but is not being mailed.");
    process.exit(0);
  }
  const to = readRecipients();
  if (!to.length) {
    console.log("nobody is on the recipients list -- the export was built but is not being mailed.");
    process.exit(0);
  }

  const attachments = [
    { filename: "layout.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    { filename: "layout.pdf", mimeType: "application/pdf" },
    { filename: "layout.csv", mimeType: "text/csv; charset=UTF-8" }
  ].map((a) => Object.assign({}, a, { content: readFileSync(join(EXPORTS, a.filename)) }));

  const areaCount = () => {
    try {
      const lab = JSON.parse(readFileSync(join(ROOT, "cellstocks", "lab-storage.json"), "utf8"));
      return (lab.children || []).length;
    } catch (err) { return undefined; }
  };
  const today = new Date().toISOString().slice(0, 10);
  const text = [
    "Today's freezer layout is attached, in three shapes:",
    "",
    "  layout.xlsx  a grid sheet per box, every slot with its cell line and passage",
    "  layout.pdf   the printable map for the freezer door",
    "  layout.csv   one row per box: where it is, whose, how full",
    "",
    summarise(readFileSync(join(EXPORTS, "layout.csv"), "utf8"), areaCount()),
    "",
    "Rebuilt from the inventory this morning."
  ].join("\n");

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
    console.log(`mailed today's layout to ${to.length} address(es)`);
  }).catch((err) => {
    // The transcript never contains the credentials -- say() redacts them -- so it is
    // safe in a public build log, and it is the only way to tell a wrong password from
    // a blocked port from a rejected recipient.
    console.error("could not send the layout: " + err.message);
    if (err.transcript) console.error(err.transcript.join("\n"));
    process.exit(1);
  });
}
