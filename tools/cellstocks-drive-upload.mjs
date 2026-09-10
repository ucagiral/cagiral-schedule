// Mirrors cellstocks/exports/grid-roster.xlsx to a fixed file in Umut's Google Drive, so
// anyone with the link always sees today's freezer without asking anyone for a copy.
//
// Run:  node tools/cellstocks-drive-upload.mjs
//       env: GOOGLE_SERVICE_ACCOUNT_KEY (the service account's JSON key, as one line),
//            GOOGLE_DRIVE_FOLDER_ID (a folder in Umut's own Drive, shared with that
//            service account's email as Editor)
//
// Same link forever: the first run creates the file inside that folder, sets it to
// "anyone with the link can view" (never edit), and writes the returned file id to
// cellstocks/exports/drive-file-id.txt. Every later run reads that id and calls
// files.update with new content instead of creating a new file -- the link never changes.
//
// Missing secrets or a failed API call are not fatal: the export was still built and
// still mailed, mirroring "no secret, or nobody on the list, skips the mail" in
// cellstocks-mail.mjs. The service account key is never printed; any error message that
// might carry it is redacted before it reaches the console, since this repo is public.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPORTS = join(ROOT, "cellstocks", "exports");
export const DRIVE_FILE_ID_PATH = join(EXPORTS, "drive-file-id.txt");
export const GRID_ROSTER_NAME = "grid-roster.xlsx";
export const GRID_ROSTER_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const SCOPE = "https://www.googleapis.com/auth/drive";

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A service-account JWT bearer assertion (RFC 7523). `now` is a parameter, not a call to
// Date.now(), so the exact claim can be reproduced in a test.
export function signServiceAccountJwt({ clientEmail, privateKey, tokenUri, scope, now }) {
  const iat = Math.floor((now || Date.now()) / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = { iss: clientEmail, scope: scope || SCOPE, aud: tokenUri, exp: iat + 3600, iat };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

// Exchanges the JWT for an access token. `fetchImpl` and `tokenUri` are both injectable so
// the selftest can point this at a fake server instead of Google's real endpoint.
export async function fetchAccessToken({ clientEmail, privateKey, tokenUri, fetchImpl, now }) {
  const uri = tokenUri || "https://oauth2.googleapis.com/token";
  const jwt = signServiceAccountJwt({ clientEmail, privateKey, tokenUri: uri, now });
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt
  });
  const res = await (fetchImpl || fetch)(uri, { method: "POST", body: body.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`could not get an access token (${res.status}): ${json.error || json.error_description || "unknown error"}`);
  }
  return json.access_token;
}

// First run: creates the file inside the shared folder via a multipart upload, then sets
// it to view-only for anyone with the link. Returns the new file id.
export async function createFile({ accessToken, folderId, fileName, mimeType, content, driveApiBase, fetchImpl }) {
  const base = driveApiBase || "https://www.googleapis.com";
  const boundary = "cellstocks-drive-boundary";
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`, "utf8"),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, "utf8"),
    content,
    Buffer.from(`\r\n--${boundary}--`, "utf8")
  ]);
  const res = await (fetchImpl || fetch)(`${base}/upload/drive/v3/files?uploadType=multipart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body
  });
  const json = await res.json();
  if (!res.ok || !json.id) throw new Error(`could not create the Drive file (${res.status}): ${json.error && json.error.message || "unknown error"}`);

  const perm = await (fetchImpl || fetch)(`${base}/drive/v3/files/${json.id}/permissions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "anyone", role: "reader" })
  });
  if (!perm.ok) {
    const permJson = await perm.json().catch(() => ({}));
    throw new Error(`created the file but could not make it viewable (${perm.status}): ${permJson.error && permJson.error.message || "unknown error"}`);
  }
  return json.id;
}

// Every later run: same file id, new content, same link. Metadata (name, parent,
// permission) is untouched -- only the bytes change.
export async function updateFile({ accessToken, fileId, mimeType, content, driveApiBase, fetchImpl }) {
  const base = driveApiBase || "https://www.googleapis.com";
  const res = await (fetchImpl || fetch)(`${base}/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": mimeType },
    body: content
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(`could not update the Drive file (${res.status}): ${json.error && json.error.message || "unknown error"}`);
  }
}

// The whole run, with every collaborator (the token endpoint, the Drive API, the file id
// on disk) passed in or injectable -- so the selftest exercises the exact same logic
// against a fake server rather than a reimplementation of it.
export async function run({ serviceAccountKeyJson, folderId, filePath, fileIdPath, fetchImpl, tokenUri, driveApiBase, now }) {
  const key = JSON.parse(serviceAccountKeyJson);
  const accessToken = await fetchAccessToken({
    clientEmail: key.client_email, privateKey: key.private_key, tokenUri, fetchImpl, now
  });
  const content = readFileSync(filePath);
  const idFile = fileIdPath || DRIVE_FILE_ID_PATH;
  const existingId = existsSync(idFile) ? readFileSync(idFile, "utf8").trim() : "";

  if (existingId) {
    await updateFile({ accessToken, fileId: existingId, mimeType: GRID_ROSTER_MIME, content, driveApiBase, fetchImpl });
    return { fileId: existingId, created: false };
  }
  const fileId = await createFile({
    accessToken, folderId, fileName: GRID_ROSTER_NAME, mimeType: GRID_ROSTER_MIME, content, driveApiBase, fetchImpl
  });
  writeFileSync(idFile, fileId + "\n");
  return { fileId, created: true };
}

export function driveLinkFor(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

// Never let anything here throw the service account key onto a public build log.
function redact(err) {
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  let message = String(err && err.message || err);
  if (key) message = message.split(key).join("[redacted]");
  return message;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!keyJson || !folderId) {
    console.log("GOOGLE_SERVICE_ACCOUNT_KEY / GOOGLE_DRIVE_FOLDER_ID are not set -- the export was built but not mirrored to Drive.");
    process.exit(0);
  }

  run({ serviceAccountKeyJson: keyJson, folderId, filePath: join(EXPORTS, GRID_ROSTER_NAME) })
    .then(({ fileId, created }) => {
      console.log(`${created ? "created" : "updated"} the Drive file: ${driveLinkFor(fileId)}`);
      if (process.env.GITHUB_OUTPUT) {
        writeFileSync(process.env.GITHUB_OUTPUT, `drive_link=${driveLinkFor(fileId)}\n`, { flag: "a" });
      }
    })
    .catch((err) => {
      console.error("could not mirror the export to Drive: " + redact(err));
      // Non-fatal: the export was still built and will still be mailed.
      process.exit(0);
    });
}
