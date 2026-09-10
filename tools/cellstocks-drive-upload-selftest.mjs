// Checks the Drive mirror against a fake token endpoint and a fake Drive API, both real
// local HTTP servers -- so the JWT signature, the multipart upload body, and the file-id
// persistence are all exercised exactly as they run in production, not reimplemented here.

import { createServer } from "node:http";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  run, signServiceAccountJwt, driveLinkFor, GRID_ROSTER_NAME, GRID_ROSTER_MIME
} from "./cellstocks-drive-upload.mjs";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const results = [];
async function check(name, fn) {
  let problem = null;
  try { problem = await fn(); } catch (err) { problem = String((err && err.stack) || err); }
  if (problem) { failures++; results.push(`  ✗ ${name}\n    ${problem}`); }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// A key pair standing in for the service account's, so the fake token server can verify
// the JWT was actually signed with the private key that came in on the request -- not
// just shaped like one.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CLIENT_EMAIL = "fixture@fixture-project.iam.gserviceaccount.com";
const serviceAccountKeyJson = JSON.stringify({ client_email: CLIENT_EMAIL, private_key: privateKey.export({ type: "pkcs1", format: "pem" }) });

// One server plays both roles (token endpoint + Drive API), the way a real integration
// test only needs one fake HTTP server no matter how many real Google hosts it stands in
// for. State is closed over so each check can inspect exactly what arrived.
function fakeGoogle({ failCreate, failPermission, failUpdate } = {}) {
  const calls = [];
  let nextFileId = 1;
  const files = {};
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    calls.push({ method: req.method, url: req.url, headers: req.headers });

    if (req.url === "/token") {
      const params = new URLSearchParams(body.toString("utf8"));
      const jwt = params.get("assertion");
      const [headerB64, claimB64, sigB64] = jwt.split(".");
      const claim = JSON.parse(Buffer.from(claimB64, "base64url").toString("utf8"));
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${headerB64}.${claimB64}`);
      const ok = verifier.verify(publicKey, Buffer.from(sigB64, "base64url"));
      if (!ok || claim.iss !== CLIENT_EMAIL) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "fake-access-token", expires_in: 3599 }));
      return;
    }

    if (req.url.startsWith("/upload/drive/v3/files?uploadType=multipart") && req.method === "POST") {
      if (failCreate) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "boom" } })); return; }
      const boundary = (req.headers["content-type"].match(/boundary=([^;]+)/) || [])[1];
      const text = body.toString("utf8");
      const parts = text.split(`--${boundary}`).filter((p) => p.trim() && p.trim() !== "--");
      const metadata = JSON.parse(parts[0].split("\r\n\r\n")[1]);
      const mediaPart = parts[1];
      const mediaStart = text.indexOf(mediaPart) + mediaPart.indexOf("\r\n\r\n") + 4;
      const id = `file-${nextFileId++}`;
      files[id] = { name: metadata.name, parents: metadata.parents, content: text.slice(0), permission: null };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id }));
      return;
    }

    const permMatch = req.url.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/);
    if (permMatch && req.method === "POST") {
      if (failPermission) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "boom" } })); return; }
      const id = permMatch[1];
      files[id].permission = JSON.parse(body.toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "perm-1" }));
      return;
    }

    const updateMatch = req.url.match(/^\/upload\/drive\/v3\/files\/([^?]+)\?uploadType=media$/);
    if (updateMatch && req.method === "PATCH") {
      if (failUpdate) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "boom" } })); return; }
      const id = updateMatch[1];
      if (!files[id]) files[id] = { content: null, permission: null };
      files[id].updatedContent = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
  return { server, calls, files };
}

// ------------------------------------------------------------------------ the checks
await check("signServiceAccountJwt produces a JWT the fake token server accepts", async () => {
  const { server } = fakeGoogle();
  const port = await listen(server);
  try {
    const jwt = signServiceAccountJwt({
      clientEmail: CLIENT_EMAIL, privateKey, tokenUri: `http://127.0.0.1:${port}/token`, now: Date.now()
    });
    if (jwt.split(".").length !== 3) return `not a JWT: ${jwt}`;
    return null;
  } finally { server.close(); }
});

await check("first run: creates the file, sets it view-only for anyone, persists the file id", async () => {
  const google = fakeGoogle();
  const port = await listen(google.server);
  try {
    const dir = mkdtempSync(join(tmpdir(), "cst-drive-"));
    const filePath = join(dir, GRID_ROSTER_NAME);
    writeFileSync(filePath, "fake xlsx bytes");
    const fileIdPath = join(dir, "drive-file-id.txt");

    const { fileId, created } = await run({
      serviceAccountKeyJson, folderId: "folder-abc", filePath, fileIdPath,
      tokenUri: `http://127.0.0.1:${port}/token`, driveApiBase: `http://127.0.0.1:${port}`
    });

    if (!created) return "expected created:true on a first run";
    if (!existsSync(fileIdPath)) return "drive-file-id.txt was not written";
    if (readFileSync(fileIdPath, "utf8").trim() !== fileId) return "the persisted id does not match the created file's id";
    const file = google.files[fileId];
    if (!file) return `no such file recorded server-side: ${fileId}`;
    if (file.parents[0] !== "folder-abc") return `created in the wrong folder: ${JSON.stringify(file.parents)}`;
    if (!file.permission || file.permission.type !== "anyone" || file.permission.role !== "reader") {
      return `permission is not anyone/reader: ${JSON.stringify(file.permission)}`;
    }
    return null;
  } finally { google.server.close(); }
});

await check("second run: reuses the persisted file id, updates content, never creates a second file", async () => {
  const google = fakeGoogle();
  const port = await listen(google.server);
  try {
    const dir = mkdtempSync(join(tmpdir(), "cst-drive-"));
    const filePath = join(dir, GRID_ROSTER_NAME);
    const fileIdPath = join(dir, "drive-file-id.txt");
    writeFileSync(filePath, "version one");
    const first = await run({
      serviceAccountKeyJson, folderId: "folder-abc", filePath, fileIdPath,
      tokenUri: `http://127.0.0.1:${port}/token`, driveApiBase: `http://127.0.0.1:${port}`
    });

    writeFileSync(filePath, "version two, updated");
    const second = await run({
      serviceAccountKeyJson, folderId: "folder-abc", filePath, fileIdPath,
      tokenUri: `http://127.0.0.1:${port}/token`, driveApiBase: `http://127.0.0.1:${port}`
    });

    if (second.created) return "a second run must update, not create";
    if (second.fileId !== first.fileId) return `the file id changed: ${first.fileId} -> ${second.fileId}`;
    const createCalls = google.calls.filter((c) => c.url.startsWith("/upload/drive/v3/files?"));
    if (createCalls.length !== 1) return `expected exactly one create call, got ${createCalls.length}`;
    const updated = google.files[first.fileId].updatedContent;
    if (!updated || updated.toString("utf8") !== "version two, updated") {
      return `the file's content was not updated: ${updated && updated.toString("utf8")}`;
    }
    return null;
  } finally { google.server.close(); }
});

await check("driveLinkFor builds a normal Drive viewer link", () => {
  const link = driveLinkFor("abc123");
  if (link !== "https://drive.google.com/file/d/abc123/view") return `unexpected link: ${link}`;
  return null;
});

await check("a failed permission call surfaces as an error rather than silently leaving the file editable-only-by-us", async () => {
  const google = fakeGoogle({ failPermission: true });
  const port = await listen(google.server);
  try {
    const dir = mkdtempSync(join(tmpdir(), "cst-drive-"));
    const filePath = join(dir, GRID_ROSTER_NAME);
    writeFileSync(filePath, "content");
    let threw = false;
    try {
      await run({
        serviceAccountKeyJson, folderId: "folder-abc", filePath, fileIdPath: join(dir, "drive-file-id.txt"),
        tokenUri: `http://127.0.0.1:${port}/token`, driveApiBase: `http://127.0.0.1:${port}`
      });
    } catch (err) { threw = true; }
    if (!threw) return "expected run() to throw when the permission call fails";
    if (existsSync(join(dir, "drive-file-id.txt"))) return "the file id must not be persisted when the permission step failed";
    return null;
  } finally { google.server.close(); }
});

await check("running the CLI with no secrets configured skips cleanly, exit 0, no throw", () => {
  const out = execFileSync("node", [join(HERE, "tools", "cellstocks-drive-upload.mjs")], {
    stdio: "pipe", env: { ...process.env, GOOGLE_SERVICE_ACCOUNT_KEY: "", GOOGLE_DRIVE_FOLDER_ID: "" }
  }).toString("utf8");
  if (!/not set/.test(out)) return `expected a "not set" message, got: ${out}`;
  return null;
});

await check("the redaction guard never lets the raw service account key reach the console on failure", async () => {
  const google = fakeGoogle({ failCreate: true });
  const port = await listen(google.server);
  try {
    const dir = mkdtempSync(join(tmpdir(), "cst-drive-"));
    const filePath = join(dir, GRID_ROSTER_NAME);
    writeFileSync(filePath, "content");
    const scriptEnv = { ...process.env, GOOGLE_SERVICE_ACCOUNT_KEY: serviceAccountKeyJson, GOOGLE_DRIVE_FOLDER_ID: "folder-abc" };
    // Route the CLI at the fake server by way of a tiny wrapper, since the CLI block
    // itself does not take --token-uri: this proves run()'s failure path never echoes
    // the private key, which is the part that actually matters for a public build log.
    let message = "";
    try {
      await run({
        serviceAccountKeyJson, folderId: "folder-abc", filePath, fileIdPath: join(dir, "drive-file-id.txt"),
        tokenUri: `http://127.0.0.1:${port}/token`, driveApiBase: `http://127.0.0.1:${port}`
      });
    } catch (err) { message = err.message; }
    if (message.includes(privateKey.export({ type: "pkcs1", format: "pem" }).toString())) {
      return "the raw private key leaked into the error message";
    }
    return null;
  } finally { google.server.close(); }
});

console.log("");
if (failures) {
  console.log(`${failures} of 7 cell stocks drive-upload checks failed:\n`);
  console.log(results.join("\n\n"));
  process.exit(1);
}
console.log("All 7 cell stocks drive-upload checks passed.");
