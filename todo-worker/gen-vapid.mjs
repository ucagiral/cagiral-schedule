// One-off: makes the VAPID key pair. Run once, keep the output.
//   node todo-worker/gen-vapid.mjs
// Public key -> VAPID_PUBLIC in wrangler.toml (it is public by design).
// Private JWK -> `wrangler secret put VAPID_PRIVATE_JWK` (never commit it; the repo is public).
import { b64u } from "./webpush.mjs";
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
console.log("VAPID_PUBLIC=" + b64u(pub));
console.log("VAPID_PRIVATE_JWK=" + JSON.stringify(jwk));
