// Drives the wardrobe app in a real browser, end to end.
//
// Run:  node tools/wardrobe-browser-test.mjs [--shots <dir>]
//
// tools/wardrobe-selftest.mjs proves the rules; this proves the app -- that the
// screens render, that swiping and wearing write what they claim to, that an
// agent proposal stays a proposal until it is accepted, and that a token missing
// the Actions permission is told exactly what to fix.
//
// GitHub and Open-Meteo are stood in for locally. The GitHub stand-in is not a
// mock of what the app "should" send: it implements the real git data API shape
// and records whatever the app actually commits, so the assertions are made
// against the bytes that would have reached the repository.
//
// Needs playwright with a chromium build. Without it this exits 0 with a note,
// rather than failing a checkout that never asked for a browser.

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const shotsArg = process.argv.indexOf("--shots");
const OUT_DIR = shotsArg !== -1 ? process.argv[shotsArg + 1] : join(REPO_ROOT, ".wardrobe-shots");
const SHOTS = join(OUT_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  for (const guess of ["/opt/node22/lib/node_modules/playwright/index.mjs",
                       "/usr/lib/node_modules/playwright/index.mjs",
                       "/usr/local/lib/node_modules/playwright/index.mjs"]) {
    try { ({ chromium } = await import(guess)); break; } catch { /* keep looking */ }
  }
}
if (!chromium) {
  console.log("playwright is not installed — skipping the browser test.");
  console.log("  npm i -D playwright && npx playwright install chromium");
  process.exit(0);
}

let pass = 0;
const fails = [];
const allErrors = [];
const check = (name, cond, detail) => {
  if (cond) pass++;
  else fails.push(`${name}${detail ? "\n    " + detail : ""}`);
};

// ------------------------------------------------------------ local stand-ins

const ROOT = REPO_ROOT;
const TYPES = {
  ".html":"text/html", ".js":"text/javascript", ".json":"application/json",
  ".png":"image/png", ".webp":"image/webp", ".jpg":"image/jpeg",
  ".webmanifest":"application/manifest+json", ".ics":"text/calendar"
};

function serve(port){
  const server = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()){
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

function fakeWeather(dayISO, tempsByHour){
  const time = [], temperature_2m = [], apparent_temperature = [], precipitation_probability = [],
        wind_speed_10m = [], weather_code = [];
  for (let h = 0; h < 24; h++){
    time.push(`${dayISO}T${String(h).padStart(2,"0")}:00`);
    const t = tempsByHour(h);
    temperature_2m.push(t.temp);
    apparent_temperature.push(t.apparent);
    precipitation_probability.push(t.rain || 0);
    wind_speed_10m.push(8);
    weather_code.push(t.rain > 50 ? 61 : 1);
  }
  return { hourly: { time, temperature_2m, apparent_temperature, precipitation_probability, wind_speed_10m, weather_code } };
}

// Stands in for GitHub. Records every blob the app pushes so a test can assert on
// exactly what would have been committed.
function githubStub(page, opts){
  const state = { blobs: [], commits: [], files: {}, wardrobe: opts.wardrobe || null, dispatches: 0 };
  let n = 0;
  const sha = () => "0".repeat(32) + String(++n).padStart(8, "0");

  page.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (body, status=200) => route.fulfill({ status, contentType:"application/json", body: JSON.stringify(body) });

    if (path.includes("/contents/wardrobe/wardrobe.json")){
      if (!state.wardrobe) return json({ message:"Not Found" }, 404);
      return json({ content: Buffer.from(JSON.stringify(state.wardrobe)).toString("base64"), sha:"abc123", encoding:"base64" });
    }
    if (path.endsWith("/git/ref/heads/main")) return json({ object:{ sha:"basecommit" } });
    if (path.includes("/git/commits/")) return json({ tree:{ sha:"basetree" } });
    if (path.endsWith("/git/blobs")){
      const body = JSON.parse(req.postData());
      const s = sha();
      state.blobs.push({ sha:s, ...body });
      return json({ sha:s });
    }
    if (path.endsWith("/git/trees")){
      const body = JSON.parse(req.postData());
      state.lastTree = body.tree;
      return json({ sha: sha() });
    }
    if (path.endsWith("/git/commits")){
      const body = JSON.parse(req.postData());
      state.commits.push({ message: body.message, tree: state.lastTree });
      // Whatever the app just committed becomes what a reload would read back.
      for (const t of state.lastTree){
        const blob = state.blobs.find((b) => b.sha === t.sha);
        if (!blob) continue;
        state.files[t.path] = blob;
        if (t.path.endsWith("wardrobe.json")){
          // The app sends JSON as utf-8 and images as base64; decode accordingly.
          const text = blob.encoding === "base64"
            ? Buffer.from(blob.content, "base64").toString("utf8") : blob.content;
          try { state.wardrobe = JSON.parse(text); }
          catch(e){ state.parseError = e.message; }
        }
      }
      return json({ sha: sha() });
    }
    if (path.includes("/git/refs/heads/main")) return json({ ok:true });
    if (path.includes("/actions/workflows/")){ state.dispatches++; return route.fulfill({ status:204, body:"" }); }
    return json({ message:"unhandled " + path }, 500);
  });

  page.route("https://raw.githubusercontent.com/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.includes("wardrobe/demo/demo.json")){
      return route.fulfill({ status: opts.demo ? 200 : 404, contentType:"application/json",
                             body: JSON.stringify(opts.demo || {}) });
    }
    if (p.includes("claudeAgent.json")){
      return route.fulfill({ status: opts.schedule ? 200 : 404, contentType:"application/json",
                             body: JSON.stringify(opts.schedule || {}) });
    }
    if (p.includes("wardrobe/wardrobe.json")){
      return route.fulfill({ status: state.wardrobe ? 200 : 404, contentType:"application/json",
                             body: JSON.stringify(state.wardrobe || {}) });
    }
    return route.fulfill({ status:404, body:"" });
  });

  page.route("https://api.open-meteo.com/**", (route) =>
    route.fulfill({ status:200, contentType:"application/json", body: JSON.stringify(opts.weather || fakeWeather("2026-08-21", () => ({ temp:20, apparent:20 }))) }));
  page.route("https://geocoding-api.open-meteo.com/**", (route) =>
    route.fulfill({ status:200, contentType:"application/json",
                    body: JSON.stringify({ results:[{ latitude:39.93, longitude:32.86, name:"Ankara" }] }) }));

  return state;
}

async function openApp(opts = {}){
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: opts.viewport || { width: 430, height: 900 } });
  await page.addInitScript(([token, cfg]) => {
    localStorage.setItem("cs_cfg", JSON.stringify(cfg));
    if (token){ localStorage.setItem("cs_token", token); localStorage.setItem("cs_device", "test rig"); }
    // Freeze the clock so "today" and the journal are deterministic.
    const REAL = Date;
    const FIXED = new REAL("2026-08-21T09:30:00Z").getTime();
    class FakeDate extends REAL {
      constructor(...a){ super(...(a.length ? a : [FIXED])); }
      static now(){ return FIXED; }
    }
    window.Date = FakeDate;
  }, [opts.token === undefined ? "ghp_test" : opts.token, { owner:"ucagiral", repo:"cagiral-schedule", branch:"main" }]);

  const gh = githubStub(page, opts);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(`http://127.0.0.1:${opts.port}/wardrobe/index.html`, { waitUntil:"domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("status").textContent !== "Loading…", { timeout: 15000 });
  return { browser, page, gh, errors };
}

// ========================================================= the app, end to end
{
// Drives the real app in a real browser: the screens, a swipe, wearing an outfit,
// and what actually lands in wardrobe.json.


const SHOTS = join(OUT_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });
const demo = JSON.parse(readFileSync(join(REPO_ROOT, "wardrobe", "demo", "demo.json"), "utf8"));

let server = await serve(8791);

// A cool, brightening autumn morning: 11 °C at 8am climbing to 20 °C at 2pm.
const weather = fakeWeather("2026-08-21", (h) => {
  const t = h < 10 ? 11 : (h < 12 ? 15 : (h < 17 ? 20 : 14));
  return { temp: t, apparent: t, rain: 10 };
});
const schedule = { events: [
  { id:"e1", date:"2026-08-21", start:"09:00", end:"12:00", title:"Western blot",
    category:"experiment", type:"active", status:"pending" }
] };

const { browser, page, gh, errors } = await openApp({ port: 8791, weather, schedule, demo });

// ---------------------------------------------------------------- today
await page.waitForFunction(() => document.querySelectorAll("#todayOutfit .piece").length > 0, { timeout: 15000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/1-today.png`, fullPage: true });

const todayPieces = await page.$$eval("#todayOutfit .piece .nm", ns => ns.map(n => n.textContent));
const why = await page.textContent("#todayWhy");
const wxMeta = await page.textContent("#wxMeta");
console.log("today:", todayPieces.join(" + "));
console.log("why:  ", why);
console.log("wx:   ", wxMeta);

check("today shows a full outfit", todayPieces.length >= 3, todayPieces.join(","));
check("today's why-line quotes a temperature", /°C outfit/.test(why), why);
check("the weather strip reports the morning and the climb",
  /feels like 11°/.test(wxMeta) && /up to 20°/.test(wxMeta), wxMeta);

const shed = await page.textContent("#todayShed");
check("a 9° climb nominates a layer to shed", /take the .* off around 20°/.test(shed), shed);

// A lab day: nothing tagged smart-only should be on the card.
const smartOnly = demo.items.filter(i => i.occasions && i.occasions.length &&
  !i.occasions.includes("lab")).map(i => i.name);
const leaked = todayPieces.filter(n => smartOnly.includes(n));
check("the lab day in the calendar filtered the wardrobe", leaked.length === 0,
  "leaked: " + leaked.join(", "));

// Stickers must actually render, not fall back to the emoji placeholder.
const imgs = await page.$$eval("#todayOutfit .piece img",
  els => els.map(e => ({ src: e.getAttribute("src"), w: e.naturalWidth })));
check("every sticker on the card loaded", imgs.length > 0 && imgs.every(i => i.w > 0),
  JSON.stringify(imgs));

// ---------------------------------------------------------------- another
const firstKey = todayPieces.join("|");
await page.click("#btnAnother");
await page.waitForTimeout(250);
const second = await page.$$eval("#todayOutfit .piece .nm", ns => ns.map(n => n.textContent));
check("'show another' changes the outfit", second.join("|") !== firstKey,
  second.join(",") + " vs " + firstKey);

// ---------------------------------------------------------------- deck
await page.click('nav button[data-screen="deck"]');
await page.waitForSelector(".swipecard:not(.back)");
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/2-deck.png`, fullPage: true });

// The deck is weather-free, so it must be able to show outerwear on a mild day.
// Swipe through a fixed number of cards regardless, so the swipe log is exercised
// whether or not the first card happens to have a jacket on it.
const deckScan = await page.evaluate(async () => {
  let sawOuter = false, cards = 0;
  for (let i = 0; i < 14; i++){
    const names = [...document.querySelectorAll(".swipecard:not(.back) .piece .nm")].map(n => n.textContent);
    if (!names.length) break;
    cards++;
    if (names.some(n => /jacket|gilet/i.test(n))) sawOuter = true;
    document.getElementById("btnNope").click();
    await new Promise(r => setTimeout(r, 260));
  }
  return { sawOuter, cards };
});
check("the weather-free deck offers outerwear on a mild day", deckScan.sawOuter,
  "scanned " + deckScan.cards + " cards");
check("the deck actually served cards", deckScan.cards >= 10, "cards: " + deckScan.cards);

const swipes = await page.evaluate(() => JSON.parse(localStorage.getItem("wd_cache")).state.swipes.length);
check("swiping is recorded", swipes === deckScan.cards, `${swipes} swipes for ${deckScan.cards} cards`);
const rejected = await page.evaluate(() => JSON.parse(localStorage.getItem("wd_cache")).state.rejected.length);
check("passing on an outfit is recorded as reversible", rejected === deckScan.cards,
  `${rejected} rejections for ${deckScan.cards} passes`);

// Swipe right, and check the model actually moved.
await page.click("#btnLike");
await page.waitForTimeout(300);
const afterLike = await page.evaluate(() => JSON.parse(localStorage.getItem("wd_cache")).state);
check("a keep is recorded as liked", afterLike.swipes[afterLike.swipes.length-1].liked === true);
check("a keep is not added to the passed list", afterLike.rejected.length === rejected);
const taste = await page.evaluate(() => JSON.parse(localStorage.getItem("wd_cache")).state.taste);
check("the taste model has weights after swiping", Object.keys(taste.weights).length > 1,
  "keys: " + Object.keys(taste.weights).length);

// ---------------------------------------------------------------- wardrobe
await page.click('nav button[data-screen="wardrobe"]');
await page.waitForSelector(".tile");
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/3-wardrobe.png`, fullPage: true });
const tiles = await page.$$eval(".tile", els => els.length);
check("the wardrobe grid shows every demo piece", tiles === demo.items.length, `${tiles} of ${demo.items.length}`);
const demoBadge = await page.isVisible("#demoBadge");
check("the demo badge is showing", demoBadge);
const gapsCard = await page.textContent("#gapsCard");
check("a fully specified demo wardrobe raises no gaps", gapsCard.trim() === "", gapsCard.slice(0,120));

// ---------------------------------------------------------------- journal
await page.click('nav button[data-screen="today"]');
await page.waitForTimeout(300);
await page.click("#btnWore");
await page.waitForTimeout(300);
const banner = await page.textContent("#banner");
check("wearing a demo outfit is refused with a reason", /demo outfit/.test(banner), banner);

await page.click('nav button[data-screen="settings"]');
await page.waitForTimeout(200);
await page.screenshot({ path: `${SHOTS}/5-settings.png`, fullPage: true });

// ---------------------------------------------------------------- real item
// Promote a demo piece into the real wardrobe by editing it, which is the path a
// real first item takes.
await page.click('nav button[data-screen="wardrobe"]');
await page.waitForSelector(".tile");
await page.click(".tile");
await page.waitForSelector("#dlgTitle");
await page.click('#dlgFoot button:has-text("Save")');
await page.waitForFunction(() => /Saved|Ready/.test(document.getElementById("status").textContent),
  { timeout: 8000 });
await page.waitForTimeout(300);
const nowReal = gh.wardrobe && gh.wardrobe.items.length;
check("editing a demo piece copies it into the real wardrobe", nowReal === 1, "items: " + nowReal);
const stillDemo = await page.isVisible("#demoBadge");
check("one real item retires the demo set", !stillDemo);

await page.click('nav button[data-screen="journal"]');
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/4-journal.png`, fullPage: true });
allErrors.push(...errors);
await browser.close();
server.close();
}

// ============================================================= the agent side
{
// The app's side of the agent: the trigger, the 403 guidance, and the review list.

const SHOTS = join(OUT_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });
const server = await serve(8792);

// A wardrobe with real gaps and one proposal already waiting for review.
const wardrobe = {
  items: [
    { id:"w-grey-jumper", name:"Grey jumper", slot:"top", layer:3, warmth:null, clo:null,
      color:"#7a7a7a", pattern:null, formality:null, fabric:null, washAfter:null, occasions:null,
      waterproof:false, wearsSinceWash:0, lastWorn:null, pinnedUntil:null, guessed:[], agentGuessed:{} },
    { id:"w-navy-chinos", name:"Navy chinos", slot:"bottom", warmth:3, clo:null, color:"#2b3a55",
      pattern:"solid", formality:3, fabric:"cotton", washAfter:5, occasions:null, waterproof:false,
      wearsSinceWash:0, lastWorn:null, pinnedUntil:null, guessed:[],
      agentGuessed:{ fabric:{ value:"denim", confidence:0.62, why:"visible twill weave", at:"2026-08-21" } } },
    { id:"w-white-tee", name:"White tee", slot:"top", layer:1, warmth:2, clo:null, color:"#f0f0f0",
      pattern:"solid", formality:2, fabric:"cotton", washAfter:1, occasions:null, waterproof:false,
      wearsSinceWash:0, lastWorn:null, pinnedUntil:null, guessed:[], agentGuessed:{} },
    { id:"w-trainers", name:"Trainers", slot:"shoes", warmth:2, clo:null, color:"#dddddd",
      pattern:"solid", formality:1, fabric:"synthetic", washAfter:60, occasions:null, waterproof:false,
      wearsSinceWash:0, lastWorn:null, pinnedUntil:null, guessed:[], agentGuessed:{} }
  ],
  log: [], swipes: [], rejected: [], taste:{weights:{},n:0},
  settings:{ city:"Ankara", cloOffset:0, repeatDays:3, outlinePx:6, demo:false }
};

const { browser, page, gh, errors } = await openApp({ port: 8792, wardrobe });
await page.click('nav button[data-screen="wardrobe"]');
await page.waitForSelector(".tile");
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/6-agent-review.png`, fullPage: true });

// --- the review list ---
const review = await page.textContent("#agentReview");
check("a waiting proposal is shown for review", /agent filled in 1 field/i.test(review), review.slice(0,140));
check("the proposal shows its confidence", /62%/.test(review), review.slice(0,220));
check("the proposal shows its reasoning", /visible twill weave/.test(review));
check("an unaccepted proposal has not changed the real field",
  gh.wardrobe === null || gh.wardrobe === undefined ||
  (gh.wardrobe.items.find(i => i.id === "w-navy-chinos").fabric === "cotton"));

// --- accepting ---
await page.click('#agentReview button:has-text("Accept all")');
await page.waitForFunction(() => /Saved|Ready/.test(document.getElementById("status").textContent), { timeout: 9000 });
await page.waitForTimeout(300);
const chinos = gh.wardrobe.items.find(i => i.id === "w-navy-chinos");
check("accepting writes the value into the real field", chinos.fabric === "denim", "fabric: " + chinos.fabric);
check("accepting clears the proposal", !Object.keys(chinos.agentGuessed || {}).length);
const gone = await page.textContent("#agentReview");
check("the review list empties once accepted", gone.trim() === "", gone.slice(0,80));

// --- triggering ---
await page.click("#btnAnalyze");
await page.waitForTimeout(700);
check("the analyze button dispatches the workflow", gh.dispatches === 1, "dispatches: " + gh.dispatches);
const banner = await page.textContent("#banner");
check("the banner says how many items it is looking at", /looking at 1 item/.test(banner), banner.slice(0,160));

// --- the 403 path, which is the one Umut will actually hit first ---
await page.route("https://api.github.com/**/actions/workflows/**", (route) =>
  route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "Resource not accessible by personal access token" }) }));
await page.click("#btnAnalyze");
await page.waitForTimeout(700);
const denied = await page.textContent("#banner");
check("a refused dispatch explains exactly which permission is missing",
  /Actions: Read and write/.test(denied), denied.slice(0,220));
check("it also offers the route that needs no token change",
  /Actions/.test(denied) && /Run workflow/.test(denied), denied.slice(0,260));
await page.screenshot({ path: `${SHOTS}/7-agent-403.png`, fullPage: true });

allErrors.push(...errors);
await browser.close();
server.close();
}

// ================================================= two apps, one origin, two workers
//
// The schedule and the wardrobe are served from the same origin, so they share one
// Cache Storage, and the schedule's worker scope covers the wardrobe's path. Both
// have bitten. These are the regression tests for it -- and they need real service
// workers, so this section drives the actual pages rather than the app harness.
{
  const server = await serve(8793);
  const browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  const base = "http://127.0.0.1:8793";

  const cacheKeys = () => page.evaluate(() => caches.keys());
  const waitForCache = (prefix) =>
    page.waitForFunction(
      async (p) => (await caches.keys()).some((k) => k.startsWith(p)),
      prefix, { timeout: 20000 });

  // 1. Open the schedule and let its worker install and fill its cache.
  await page.goto(`${base}/index.html`, { waitUntil: "load" });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await waitForCache("cagiral-schedule-");
  const afterSchedule = await cacheKeys();
  check("the schedule worker caches its own shell",
    afterSchedule.some((k) => k.startsWith("cagiral-schedule-")), afterSchedule.join(", "));

  // 2. Open the wardrobe. Its worker activating must not take the schedule's cache
  //    with it -- caches.keys() returns the whole origin, not just its own.
  await page.goto(`${base}/wardrobe/index.html`, { waitUntil: "load" });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await waitForCache("wardrobe-");
  const afterWardrobe = await cacheKeys();
  check("opening the wardrobe does not wipe the schedule's offline copy",
    afterWardrobe.some((k) => k.startsWith("cagiral-schedule-")), afterWardrobe.join(", "));
  check("both apps keep a cache of their own",
    afterWardrobe.some((k) => k.startsWith("wardrobe-")) &&
    afterWardrobe.some((k) => k.startsWith("cagiral-schedule-")), afterWardrobe.join(", "));

  // 3. The schedule's cached shell must still be the schedule. The wardrobe sits
  //    inside the schedule worker's scope, and the first visit to it is served by
  //    that worker -- which used to store the wardrobe's page under this app's own
  //    "index.html" key.
  const shell = await page.evaluate(async () => {
    const key = (await caches.keys()).find((k) => k.startsWith("cagiral-schedule-"));
    if (!key) return null;
    const hit = await (await caches.open(key)).match("/index.html");
    return hit ? (await hit.text()).slice(0, 1200) : null;
  });
  check("the schedule's cached shell was not overwritten by the wardrobe",
    shell !== null && /<title>Cagiral Schedule<\/title>/.test(shell),
    shell === null ? "no cached shell at all" : shell.slice(0, 160));

  // 4. The real test of all of it: offline, each address serves its own app.
  await context.setOffline(true);
  await page.goto(`${base}/index.html`, { waitUntil: "load" });
  const offlineSchedule = await page.title();
  await page.goto(`${base}/wardrobe/index.html`, { waitUntil: "load" });
  const offlineWardrobe = await page.title();
  await context.setOffline(false);

  check("offline, the schedule address opens the schedule", offlineSchedule === "Cagiral Schedule", offlineSchedule);
  check("offline, the wardrobe address opens the wardrobe", offlineWardrobe === "Wardrobe", offlineWardrobe);

  await browser.close();
  server.close();
}

// ---------------------------------------------------------------------- report
const real = allErrors.filter((e) => !/404|Failed to load resource/.test(e));
console.log(`\n${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL " + f);
if (real.length) console.log("\nPAGE ERRORS:\n  " + real.join("\n  "));
console.log(`Screenshots in ${SHOTS}`);
process.exit(fails.length || real.length ? 1 : 0);
