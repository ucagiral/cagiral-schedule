// Checks the daily layout mailer against a fake SMTP server.
//
// The message building is pure and is read back byte for byte; the conversation is driven
// over a real socket to a server written here, which answers the way a mail server does
// and records every line. Both matter: a MIME body that no client can open and an SMTP
// exchange that stalls on a multi-line reply both look like "it sent" from the outside.

import { createServer } from "node:net";
import { connect as netConnect } from "node:net";
import { buildMessage, dotStuff, encodeHeader, sendMail, readRecipients, readMailSettings,
         shouldSendNow, normaliseTime, localClock, readLastMailed, recordSent,
         summarise } from "./cellstocks-mail.mjs";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const results = [];
async function check(name, fn) {
  let problem = null;
  try { problem = await fn(); } catch (err) { problem = String((err && err.stack) || err); }
  if (problem) { failures++; results.push(`  ✗ ${name}\n    ${problem}`); }
}

// A server that speaks just enough SMTP, including a multi-line EHLO reply -- which is
// what every real server sends, and what a naive line-at-a-time client trips over.
function fakeSmtp({ failAt } = {}) {
  const seen = [];
  let dataMode = false;
  let body = "";
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 fake.smtp ESMTP ready\r\n");
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (dataMode) {
          if (line === ".") {
            dataMode = false;
            seen.push({ command: "BODY", body });
            socket.write("250 2.0.0 queued\r\n");
          } else { body += line + "\n"; }
          continue;
        }
        seen.push({ command: line });
        const up = line.toUpperCase();
        if (up.startsWith("EHLO")) socket.write("250-fake.smtp\r\n250-SIZE 35882577\r\n250 AUTH LOGIN PLAIN\r\n");
        else if (up === "AUTH LOGIN") socket.write("334 VXNlcm5hbWU6\r\n");
        else if (up.startsWith("MAIL FROM")) socket.write("250 2.1.0 ok\r\n");
        else if (up.startsWith("RCPT TO")) {
          if (failAt === "rcpt") socket.write("550 5.1.1 no such mailbox\r\n");
          else socket.write("250 2.1.5 ok\r\n");
        } else if (up === "DATA") { dataMode = true; socket.write("354 go ahead\r\n"); }
        else if (up === "QUIT") { socket.write("221 2.0.0 bye\r\n"); socket.end(); }
        else if (/^[A-Za-z0-9+/=]+$/.test(line)) {
          // One of the two AUTH LOGIN base64 lines. It was recorded as a command a moment
          // ago; replace that entry, so the transcript reads as the conversation and the
          // credentials are never in it in the clear.
          seen.pop();
          const decoded = Buffer.from(line, "base64").toString("utf8");
          seen.push({ command: "AUTH-ARG", value: decoded });
          if (failAt === "auth" && seen.filter((s) => s.command === "AUTH-ARG").length === 2) {
            socket.write("535 5.7.8 bad credentials\r\n");
          } else if (seen.filter((s) => s.command === "AUTH-ARG").length === 2) {
            socket.write("235 2.7.0 accepted\r\n");
          } else {
            socket.write("334 UGFzc3dvcmQ6\r\n");
          }
        } else socket.write("500 5.5.1 what?\r\n");
      }
    });
  });
  return { server, seen };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

const plainConnect = (opts, cb) => netConnect({ host: opts.host, port: opts.port }, cb);

// ------------------------------------------------------------------------ the checks
await check("a non-ASCII subject is encoded, an ASCII one is left alone", () => {
  if (encodeHeader("CAA Lab freezer layout") !== "CAA Lab freezer layout") return "an ASCII subject was needlessly encoded";
  const enc = encodeHeader("Şişli — 6 Eylül");
  if (!/^=\?UTF-8\?B\?/.test(enc)) return `not an encoded-word: ${enc}`;
  if (Buffer.from(enc.slice(10, -2), "base64").toString("utf8") !== "Şişli — 6 Eylül") {
    return `the encoded subject does not decode back: ${enc}`;
  }
  return null;
});

await check("a line that starts with a dot is stuffed, so it cannot end the message early", () => {
  const out = dotStuff("hello\n.\n.hidden\nbye");
  const lines = out.split("\r\n");
  if (lines[1] !== "..") return `a bare dot was not stuffed: ${JSON.stringify(lines[1])}`;
  if (lines[2] !== "..hidden") return `a leading dot was not stuffed: ${JSON.stringify(lines[2])}`;
  if (lines[0] !== "hello" || lines[3] !== "bye") return `other lines were altered: ${JSON.stringify(lines)}`;
  return null;
});

await check("the message is multipart, with the body and every attachment intact", () => {
  const msg = buildMessage({
    from: "lab@example.com",
    to: ["a@example.com", "b@example.com"],
    subject: "Şişli layout",
    text: "Bugünün düzeni ekte.",
    date: "2026-09-06T05:00:00Z",
    attachments: [
      { filename: "layout.csv", mimeType: "text/csv", content: Buffer.from("unit,box\n-80,BOX ONE\n", "utf8") },
      { filename: "layout.pdf", mimeType: "application/pdf", content: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]) }
    ]
  });
  const boundary = (msg.match(/boundary="([^"]+)"/) || [])[1];
  if (!boundary) return "no multipart boundary";
  if (!msg.includes(`--${boundary}--`)) return "the multipart is never closed";
  if (msg.split(`--${boundary}`).length - 1 !== 4) return "expected three parts and a closing boundary";
  if (!msg.includes("To: a@example.com, b@example.com")) return "the To header is wrong";
  if (!/Subject: =\?UTF-8\?B\?/.test(msg)) return "the Turkish subject was not encoded";

  // Every part must decode back to exactly what went in.
  const parts = msg.split(`--${boundary}`).slice(1, 4);
  const decoded = parts.map((p) => {
    const body = p.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, "");
    return Buffer.from(body.replace(/\r\n/g, ""), "base64");
  });
  if (decoded[0].toString("utf8") !== "Bugünün düzeni ekte.") return `body did not round-trip: ${decoded[0]}`;
  if (decoded[1].toString("utf8") !== "unit,box\n-80,BOX ONE\n") return `the csv did not round-trip: ${decoded[1]}`;
  if (decoded[2].toString("latin1") !== "%PDF-") return `the pdf did not round-trip: ${decoded[2].toString("latin1")}`;
  // Base64 must be wrapped: some servers reject a line over 998 characters outright.
  for (const line of msg.split("\r\n")) {
    if (line.length > 998) return `a line is ${line.length} characters long`;
  }
  return null;
});

await check("the whole conversation is spoken in order, and the message arrives", async () => {
  const { server, seen } = fakeSmtp();
  const port = await listen(server);
  try {
    const message = buildMessage({
      from: "lab@example.com", to: ["a@example.com", "b@example.com"],
      subject: "layout", text: "line one\n.stuffed line\n", date: "2026-09-06T05:00:00Z", attachments: []
    });
    await sendMail({
      host: "127.0.0.1", port, user: "lab@example.com", password: "app pass word here",
      from: "lab@example.com", to: ["a@example.com", "b@example.com"],
      message, connect: plainConnect
    });
    const commands = seen.filter((s) => s.command !== "AUTH-ARG").map((s) => s.command.split(":")[0].split(" ")[0]);
    const want = ["EHLO", "AUTH", "MAIL", "RCPT", "RCPT", "DATA", "BODY", "QUIT"];
    if (JSON.stringify(commands) !== JSON.stringify(want)) {
      return `unexpected conversation: ${JSON.stringify(commands)}`;
    }
    const rcpts = seen.filter((s) => s.command.toUpperCase().startsWith("RCPT")).map((s) => s.command);
    if (rcpts.length !== 2) return `expected one RCPT per recipient, got ${JSON.stringify(rcpts)}`;
    // What the server received is the MIME message, so the text is base64 inside it:
    // decode the first part back and compare, rather than grepping for words that are
    // not there in the clear.
    const body = seen.filter((s) => s.command === "BODY")[0].body;
    const boundary = (body.match(/boundary="([^"]+)"/) || [])[1];
    if (!boundary) return `no boundary in what arrived: ${JSON.stringify(body.slice(0, 200))}`;
    const first = body.split("--" + boundary)[1] || "";
    const encoded = first.split("\n\n").slice(1).join("\n\n").replace(/\s+/g, "");
    const text = Buffer.from(encoded, "base64").toString("utf8");
    if (text !== "line one\n.stuffed line\n") return `the body did not survive the wire: ${JSON.stringify(text)}`;
    return null;
  } finally { server.close(); }
});

await check("a raw message with a dotted line survives the wire intact", async () => {
  // buildMessage base64s everything, so its lines never start with a dot -- but sendMail
  // takes any message, and dot-stuffing has to be undone by the server, not left in.
  const { server, seen } = fakeSmtp();
  const port = await listen(server);
  try {
    await sendMail({
      host: "127.0.0.1", port, user: "u", password: "p", from: "lab@example.com",
      to: ["a@example.com"],
      message: "Subject: x\r\n\r\nline one\r\n.stuffed\r\nlast line",
      connect: plainConnect
    });
    const body = seen.filter((s) => s.command === "BODY")[0].body;
    // The fake server strips one leading dot the way a real one does.
    const undone = body.split("\n").map((l) => (l.startsWith("..") ? l.slice(1) : l)).join("\n");
    if (!/^\.stuffed$/m.test(undone)) return `the dotted line was lost: ${JSON.stringify(body)}`;
    if (!/last line/.test(undone)) return `the message was truncated at the dot: ${JSON.stringify(body)}`;
    return null;
  } finally { server.close(); }
});

await check("the credentials are sent, and the app password's spaces are the caller's to strip", async () => {
  const { server, seen } = fakeSmtp();
  const port = await listen(server);
  try {
    await sendMail({
      host: "127.0.0.1", port, user: "lab@example.com", password: "abcdefghijklmnop",
      from: "lab@example.com", to: ["a@example.com"], message: "Subject: x\r\n\r\nx", connect: plainConnect
    });
    const args = seen.filter((s) => s.command === "AUTH-ARG").map((s) => s.value);
    if (args[0] !== "lab@example.com") return `the username was not sent: ${JSON.stringify(args)}`;
    if (args[1] !== "abcdefghijklmnop") return `the password was not sent: ${JSON.stringify(args)}`;
    return null;
  } finally { server.close(); }
});

await check("a rejected password fails loudly, and the transcript never contains it", async () => {
  const { server } = fakeSmtp({ failAt: "auth" });
  const port = await listen(server);
  try {
    await sendMail({
      host: "127.0.0.1", port, user: "lab@example.com", password: "hunter2-hunter2",
      from: "lab@example.com", to: ["a@example.com"], message: "Subject: x\r\n\r\nx", connect: plainConnect
    });
    return "a bad password was reported as a success";
  } catch (err) {
    if (!/bad credentials|refused/.test(err.message)) return `unhelpful error: ${err.message}`;
    const transcript = (err.transcript || []).join("\n");
    if (transcript.includes("hunter2-hunter2")) return "the password is in the transcript, which goes into a public build log";
    if (transcript.includes(Buffer.from("hunter2-hunter2").toString("base64"))) {
      return "the base64 password is in the transcript";
    }
    return null;
  } finally { server.close(); }
});

await check("a rejected recipient fails rather than half-sending", async () => {
  const { server, seen } = fakeSmtp({ failAt: "rcpt" });
  const port = await listen(server);
  try {
    await sendMail({
      host: "127.0.0.1", port, user: "u", password: "p",
      from: "lab@example.com", to: ["nope@example.com"], message: "Subject: x\r\n\r\nx", connect: plainConnect
    });
    return "a refused recipient was reported as a success";
  } catch (err) {
    if (!/RCPT/.test(err.message)) return `unhelpful error: ${err.message}`;
    if (seen.some((s) => s.command === "BODY")) return "the message was sent anyway";
    return null;
  } finally { server.close(); }
});

await check("the recipients list: empty, absent and unreadable are three different things", () => {
  const dir = mkdtempSync(join(tmpdir(), "cellstocks-mail-"));
  if (readRecipients(dir).length !== 0) return "a missing file should read as nobody";

  writeFileSync(join(dir, "recipients.json"), JSON.stringify({ emails: [] }));
  if (readRecipients(dir).length !== 0) return "an empty list should read as nobody";

  writeFileSync(join(dir, "recipients.json"), JSON.stringify({ emails: ["a@b.co", "", "not-an-address", "c@d.org"] }));
  const got = readRecipients(dir);
  if (JSON.stringify(got) !== JSON.stringify(["a@b.co", "c@d.org"])) return `bad filtering: ${JSON.stringify(got)}`;

  writeFileSync(join(dir, "recipients.json"), "{ this is not json");
  try {
    readRecipients(dir);
    return "an unreadable list was silently treated as nobody wanting the mail";
  } catch (err) {
    if (!/not valid JSON/.test(err.message)) return `unhelpful error: ${err.message}`;
  }
  return null;
});

await check("the summary counts what is in the freezer, and names a nearly full box", () => {
  const csv = "﻿area,location,box,owner,rows,cols,used,capacity,free\r\n" +
              "-80 Freezer,-80 Freezer → Shelf 1 → Rack 1,BOX ONE,umut,9,9,80,81,1\r\n" +
              "-80 Freezer,-80 Freezer → Shelf 1 → Rack 1,BOX TWO,busra,3,3,2,9,7\r\n" +
              "LN2 Tank,LN2 Tank → Tower 1,BOX THREE,umut,2,2,0,4,4\r\n";
  const out = summarise(csv, 2);
  if (!/3 boxes across 2 storage areas/.test(out)) return `wrong totals: ${out}`;
  if (!/82 vials stored, in 2 of those boxes/.test(out)) return `wrong vial count: ${out}`;
  if (!/Nearly full: BOX ONE \(80\/81\)/.test(out)) return `the full box was not named: ${out}`;
  if (/BOX TWO \(/.test(out)) return `a box at 22% was called nearly full: ${out}`;
  if (/not been placed/.test(out)) return `every box has a home, but one was called homeless: ${out}`;

  // A lab with freezers but no boxes in them yet is not a lab with no freezers -- and
  // that is the state this one was in on the morning the export was first set up.
  const empty = summarise("﻿area,location,box,owner,rows,cols,used,capacity,free\r\n", 3);
  if (!/3 storage areas, with no boxes set up in them yet\./.test(empty)) {
    return `an empty freezer reads wrong: ${empty}`;
  }
  if (/0 storage area/.test(empty)) return `three freezers were reported as none: ${empty}`;
  return null;
});

await check("a location holding a comma does not shift every column after it", () => {
  const csv = '﻿area,location,box,owner,rows,cols,used,capacity,free\r\n' +
              '"Freezer 1, middle door","Freezer 1, middle door → Shelf 1",BOX ONE,umut,9,9,80,81,1\r\n';
  const out = summarise(csv);
  // Split naively on commas and "BOX ONE" lands in the owner column, the counts read as
  // NaN, and the mail quietly says nothing is in the freezer.
  if (!/1 box across 1 storage area/.test(out)) return `the quoted path broke the columns: ${out}`;
  if (!/80 vials stored/.test(out)) return `the counts shifted: ${out}`;
  if (!/Nearly full: BOX ONE \(80\/81\)/.test(out)) return `the box name shifted: ${out}`;
  return null;
});

await check("a box with no home yet is named rather than hidden in the total", () => {
  const csv = "﻿area,location,box,owner,rows,cols,used,capacity,free\r\n" +
              "-80 Freezer,-80 Freezer → Shelf 1,BOX ONE,umut,3,3,2,9,7\r\n" +
              "Not placed yet,Not placed yet,BOX THREE,umut,2,2,1,4,3\r\n";
  const out = summarise(csv, 1);
  if (!/2 boxes across 1 storage area/.test(out)) return `wrong totals: ${out}`;
  if (!/1 box has not been placed in the tree yet: BOX THREE\./.test(out)) {
    return `the unplaced box was not called out: ${out}`;
  }
  // Its vial is still in the lab, so it still counts.
  if (!/3 vials stored, in 2 of those boxes/.test(out)) return `wrong vial count: ${out}`;
  return null;
});

// ---------------------------------------------------------------- when it goes out
//
// The cron used to be a single "0 5 * * *" and the first morning it was due, GitHub ran
// nothing at all -- the top of the hour is its most contended slot. It is a half-hourly
// poll now and this decides which poll is the day's send. `now` is an argument, so
// midnight, a dropped poll and a DST shift are all testable without waiting for one.

const IST = "Europe/Istanbul";
const at = (iso, extra) => shouldSendNow(Object.assign(
  { now: new Date(iso), sendAt: "07:30", timeZone: IST, lastMailedDate: null }, extra));

await check("it waits until the time the admin set, then sends once", () => {
  // 04:05Z is 07:05 in Istanbul -- before 07:30, so this poll does nothing.
  if (at("2026-09-07T04:05:00Z").send) return "sent half an hour early";
  // 04:35Z is 07:35: the first poll at or after the time.
  const due = at("2026-09-07T04:35:00Z");
  if (!due.send) return `did not send at the right time: ${due.reason}`;
  if (due.localTime !== "07:35" || due.localDate !== "2026-09-07") {
    return `local clock is wrong: ${due.localDate} ${due.localTime}`;
  }
  // Having sent, the rest of the day's polls do nothing.
  const after = at("2026-09-07T05:05:00Z", { lastMailedDate: "2026-09-07" });
  if (after.send) return "sent a second copy on the next poll";
  if (!/already went out/.test(after.reason)) return `unhelpful reason: ${after.reason}`;
  return null;
});

await check("a poll GitHub dropped is picked up by the next one, not lost", () => {
  // This is the whole point of the rewrite: the morning's polls never ran, and the one
  // that finally does still sends rather than deciding it has missed its slot.
  const late = at("2026-09-07T08:05:00Z");          // 11:05 in Istanbul, hours late
  if (!late.send) return `a late poll refused to send: ${late.reason}`;
  const verylate = at("2026-09-07T20:55:00Z");      // 23:55, still the same day
  if (!verylate.send) return `the last poll of the day refused to send: ${verylate.reason}`;
  return null;
});

await check("crossing local midnight starts a new day's send", () => {
  // 20:55Z on the 7th is 23:55 Istanbul -- still the 7th, already sent.
  if (at("2026-09-07T20:55:00Z", { lastMailedDate: "2026-09-07" }).send) {
    return "sent twice on the same local day";
  }
  // 21:05Z is 00:05 on the 8th: a new day, but before the send time.
  const justAfterMidnight = at("2026-09-07T21:05:00Z", { lastMailedDate: "2026-09-07" });
  if (justAfterMidnight.localDate !== "2026-09-08") return `date did not roll: ${justAfterMidnight.localDate}`;
  if (justAfterMidnight.send) return "sent at five past midnight";
  // And the next morning it sends again.
  if (!at("2026-09-08T04:35:00Z", { lastMailedDate: "2026-09-07" }).send) {
    return "the next morning never sent";
  }
  return null;
});

await check("the local clock is the lab's, not the runner's UTC", () => {
  // The runner is UTC; getting this wrong sends the mail three hours out.
  const c = localClock(new Date("2026-09-07T04:35:00Z"), IST);
  if (c.time !== "07:35") return `Istanbul time read as ${c.time}`;
  // Midnight is the case that breaks naive hour formatting (some builds say "24").
  const mid = localClock(new Date("2026-09-07T21:00:00Z"), IST);
  if (mid.time !== "00:00" || mid.date !== "2026-09-08") return `midnight read as ${mid.date} ${mid.time}`;
  return null;
});

await check("a time zone nobody can resolve refuses rather than mailing at a random hour", () => {
  const bad = shouldSendNow({ now: new Date("2026-09-07T04:35:00Z"), sendAt: "07:30",
                              timeZone: "Not/AZone", lastMailedDate: null });
  if (bad.send) return "an unreadable time zone still sent";
  if (!/not a time zone/.test(bad.reason)) return `unhelpful reason: ${bad.reason}`;
  return null;
});

await check("the times a person actually types are all understood", () => {
  const want = { "7:30": "07:30", "07:30": "07:30", "8": "08:00", "0800": "08:00", " 9:05 ": "09:05" };
  for (const [given, expected] of Object.entries(want)) {
    if (normaliseTime(given) !== expected) return `${JSON.stringify(given)} read as ${normaliseTime(given)}`;
  }
  for (const bad of ["25:00", "07:70", "", "lunchtime", null]) {
    if (normaliseTime(bad) !== null) return `${JSON.stringify(bad)} was accepted as ${normaliseTime(bad)}`;
  }
  return null;
});

await check("a recipients file written before there was a time in it still sends", () => {
  const dir = mkdtempSync(join(tmpdir(), "cellstocks-mail-"));
  // Exactly the shape of the file on main before this change.
  writeFileSync(join(dir, "recipients.json"), JSON.stringify({ emails: ["a@example.com"] }));
  const s = readMailSettings(dir);
  if (s.sendAt !== "07:30") return `sendAt defaulted to ${s.sendAt}`;
  if (s.timeZone !== IST) return `timeZone defaulted to ${s.timeZone}`;
  if (JSON.stringify(s.emails) !== JSON.stringify(["a@example.com"])) return "the addresses were lost";
  // And a nonsense time falls back rather than throwing or never sending again.
  writeFileSync(join(dir, "recipients.json"), JSON.stringify({ emails: [], sendAt: "half past eight" }));
  if (readMailSettings(dir).sendAt !== "07:30") return "an unreadable time was not defaulted";
  return null;
});

await check("a send is recorded only once it lands, and then the day is closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "cellstocks-mail-"));
  const now = new Date("2026-09-07T04:35:00Z");   // 07:35 Istanbul

  // Nothing recorded yet: this poll is the send.
  if (readLastMailed(dir) !== null) return "a fresh directory claimed a mail had gone";
  if (!shouldSendNow({ now, sendAt: "07:30", timeZone: IST, lastMailedDate: readLastMailed(dir) }).send) {
    return "the first poll of the day refused to send";
  }

  // The mailer calls this only after the server accepted the message.
  recordSent(dir, "2026-09-07", 3, now);
  if (readLastMailed(dir) !== "2026-09-07") return `the marker read back as ${readLastMailed(dir)}`;
  const written = JSON.parse(readFileSync(join(dir, "last-mailed.json"), "utf8"));
  if (written.to !== 3) return `the marker lost the recipient count: ${JSON.stringify(written)}`;

  // And now every later poll today declines.
  const next = shouldSendNow({ now: new Date("2026-09-07T05:05:00Z"), sendAt: "07:30",
                               timeZone: IST, lastMailedDate: readLastMailed(dir) });
  if (next.send) return "the poll half an hour later sent a second copy";

  // A failed send never gets here, so the marker still says yesterday and the next poll
  // retries -- which is what the live smoke test showed: TLS refused, no marker written.
  return null;
});

// ------------------------------------------------ the marker the workflow has to commit
//
// The mailer writes cellstocks/exports/last-mailed.json only after the server has taken
// the message, and the workflow commits it. If that commit does not happen, every later
// poll the same day sends another copy -- which is precisely what happened the first time
// this ran for real: the mail went out at 14:07 and the step reported "nothing was sent
// this run", because it asked `git diff`, and git diff does not see a file that is not
// tracked yet. The very first send is exactly when the marker is untracked.
//
// So the guard is read out of the workflow itself and run against a real repository,
// rather than trusting that the line says what it should.

function guardFromWorkflow() {
  const yml = readFileSync(new URL("../.github/workflows/cellstocks-export.yml", import.meta.url), "utf8");
  const line = yml.split("\n").map((l) => l.trim())
    .filter((l) => l.startsWith("if ") && l.includes("last-mailed.json"))[0];
  return line || null;
}

// Runs the workflow's own condition in `dir`; true means "there is something to commit".
function guardSaysChanged(dir, guard) {
  const script = `cd "${dir}"\n${guard}\n  echo NOCHANGE\n  exit 0\nfi\necho CHANGED\n`;
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  return out.includes("CHANGED");
}

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "cst-marker-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", ".");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "cellstocks", "exports"), { recursive: true });
  writeFileSync(join(dir, "cellstocks", "exports", "layout.csv"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { dir, git };
}

await check("the workflow still guards the marker with something that sees a new file", async () => {
  const guard = guardFromWorkflow();
  if (!guard) return "no condition naming last-mailed.json found in the export workflow";

  // 1. The first send ever: the marker is brand new and untracked. This is the case that
  //    was broken, and the one that matters most -- an unrecorded send repeats all day.
  const a = scratchRepo();
  writeFileSync(join(a.dir, "cellstocks", "exports", "last-mailed.json"), '{"date":"2026-09-07"}\n');
  if (!guardSaysChanged(a.dir, guard)) {
    return "an untracked marker reads as 'nothing was sent' -- the first send of every " +
           "new deployment would go unrecorded and repeat on every later poll that day";
  }

  // 2. A later send: the marker exists and its date moves on.
  const b = scratchRepo();
  const marker = join(b.dir, "cellstocks", "exports", "last-mailed.json");
  writeFileSync(marker, '{"date":"2026-09-06"}\n');
  b.git("add", "-A"); b.git("commit", "-qm", "yesterday");
  writeFileSync(marker, '{"date":"2026-09-07"}\n');
  if (!guardSaysChanged(b.dir, guard)) return "a marker that moved to today reads as unchanged";

  // 3. A poll that sent nothing must not commit, or the log fills with empty commits.
  if (guardSaysChanged(b.dir, guard) === false) return null;
  const c = scratchRepo();
  writeFileSync(join(c.dir, "cellstocks", "exports", "last-mailed.json"), '{"date":"2026-09-07"}\n');
  c.git("add", "-A"); c.git("commit", "-qm", "sent");
  if (guardSaysChanged(c.dir, guard)) return "a poll that sent nothing would still commit";
  return null;
});

console.log("");
if (failures) {
  console.log(`${failures} of 21 cell stocks mail checks failed:\n`);
  results.forEach((r) => console.log(r + "\n"));
  process.exit(1);
}
console.log("All 21 cell stocks mail checks passed.");
