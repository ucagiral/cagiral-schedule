// Web Push with no payload, for the Reminders app. Only the VAPID half of the protocol is
// needed: an empty push carries nothing to encrypt, and the service worker builds the
// notification text from the tasks it already has on the device (RFC 8030 / RFC 8292).
// Plain WebCrypto, so it runs in a Worker and in node 20 alike.

export function b64u(bytes) {
  var s = "";
  var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  var bin = atob(s), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();

// ES256 JWT. WebCrypto's ECDSA signature is already the raw r||s form JWT wants.
export async function vapidJwt(endpoint, subject, privateJwk, nowSec) {
  var aud = new URL(endpoint).origin;
  var head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  var claims = b64u(enc.encode(JSON.stringify({ aud: aud, exp: nowSec + 12 * 3600, sub: subject })));
  var key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  var sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims));
  return head + "." + claims + "." + b64u(sig);
}

export async function sendPush(sub, cfg, fetchImpl, nowSec) {
  var jwt = await vapidJwt(sub.endpoint, cfg.subject, cfg.privateJwk, nowSec);
  var res = await (fetchImpl || fetch)(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: "vapid t=" + jwt + ", k=" + cfg.publicKey,
      TTL: "3600",
      Urgency: "high"
    }
  });
  return { status: res.status, gone: res.status === 404 || res.status === 410 };
}
