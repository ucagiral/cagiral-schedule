// Fills in what the wardrobe does not know about its own clothes.
//
// Run:  node tools/wardrobe-agent.mjs [--dry-run]
// Needs ANTHROPIC_API_KEY. Triggered from the app's "Analyze wardrobe" button,
// which dispatches .github/workflows/wardrobe-agent.yml.
//
// The rule this whole file is built around: it never writes a field. Everything
// it works out lands in `agentGuessed`, alongside a confidence and a one-line
// reason, and stays there until it is accepted in the app. That is not a
// convention to be careful about -- applyProposals physically cannot reach the
// real fields, and tools/wardrobe-selftest.mjs proves it against a fabricated
// reply designed to overwrite everything.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "wardrobe", "wardrobe.json");

// The engine owns what counts as a gap; asking it here keeps the agent and the
// app's "Fill the gaps" list from ever disagreeing about the work to be done.
new Function(readFileSync(join(ROOT, "wardrobe", "engine.js"), "utf8"))();
const E = globalThis.WardrobeEngine;

const MODEL = "claude-opus-5";

// What the agent may propose, and what each field means. Kept next to the schema
// so the prompt and the validation can never drift apart.
export const FIELDS = {
  warmth:     { type: "step",   help: "How much this piece insulates, 1 very thin to 5 very thick, judged against other garments of the same kind -- a 5 t-shirt is still a t-shirt." },
  formality:  { type: "step3",  help: "1 sporty, 2 everyday, 3 smart." },
  pattern:    { type: "enum",   values: ["solid", "patterned"], help: "'patterned' covers prints, stripes, checks and graphics; a plain garment with a small logo is still 'solid'." },
  color:      { type: "hex",    help: "The dominant colour as #rrggbb, ignoring any white outline around the cutout." },
  fabric:     { type: "enum",   values: ["cotton", "wool", "synthetic", "denim", "leather", "suede", "other"], help: "The material it looks like it is made of." },
  waterproof: { type: "bool",   help: "Whether this would keep rain out. Only coated shells and technical fabrics count." }
};

// ---------------------------------------------------------------- gap finding

// The queue drives what gets asked, plus fabric wherever it is unknown: it is
// the one thing a photo genuinely shows that the wardrobe cannot otherwise know,
// and "what is this made of" was part of the point of having an agent at all.
export function fieldsToAsk(item) {
  const fields = new Set(E.gapsFor(item).map((g) => g.field));
  if (item.fabric === null || item.fabric === undefined) fields.add("fabric");
  for (const f of [...fields]) if (!FIELDS[f]) fields.delete(f);
  // Anything already proposed and awaiting review is not asked again.
  for (const f of Object.keys(item.agentGuessed || {})) fields.delete(f);
  return [...fields];
}

export function collectWork(wardrobe) {
  return (wardrobe.items || [])
    .map((item) => ({ item, fields: fieldsToAsk(item) }))
    .filter((w) => w.fields.length);
}

// ------------------------------------------------------------- applying work

function isOpen(item, field) {
  const missing = item[field] === null || item[field] === undefined;
  const guessed = (item.guessed || []).includes(field);
  return missing || guessed;
}

function valid(field, value) {
  const spec = FIELDS[field];
  if (!spec) return false;
  switch (spec.type) {
    case "step":  return Number.isInteger(value) && value >= 1 && value <= 5;
    case "step3": return Number.isInteger(value) && value >= 1 && value <= 3;
    case "int":   return Number.isInteger(value) && value >= 1 && value <= 99;
    case "bool":  return typeof value === "boolean";
    case "hex":   return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
    case "enum":  return spec.values.includes(value);
    default:      return false;
  }
}

// The boundary. Proposals go into agentGuessed and nowhere else; a proposal for
// a field Umut has already answered is dropped on the floor and counted.
export function applyProposals(wardrobe, proposals, today) {
  const byId = Object.fromEntries((wardrobe.items || []).map((i) => [i.id, i]));
  const report = { filled: 0, refusedSettled: 0, refusedInvalid: 0, refusedUnknownItem: 0, items: 0 };
  const touched = new Set();

  for (const proposal of proposals) {
    const item = byId[proposal.id];
    if (!item) { report.refusedUnknownItem++; continue; }

    for (const [field, entry] of Object.entries(proposal.fields || {})) {
      if (!FIELDS[field])            { report.refusedInvalid++; continue; }
      if (!isOpen(item, field))      { report.refusedSettled++; continue; }
      if (!valid(field, entry.value)){ report.refusedInvalid++; continue; }

      item.agentGuessed = item.agentGuessed || {};
      item.agentGuessed[field] = {
        value: entry.value,
        confidence: Math.max(0, Math.min(1, Number(entry.confidence) || 0)),
        why: String(entry.why || "").slice(0, 160),
        at: today
      };
      report.filled++;
      touched.add(item.id);
    }
  }
  report.items = touched.size;
  return report;
}

// ------------------------------------------------------------------ the model

function schemaFor(fields) {
  const properties = {}, required = [];
  for (const f of fields) {
    const spec = FIELDS[f];
    const value =
      spec.type === "step"  ? { type: "integer", minimum: 1, maximum: 5 } :
      spec.type === "step3" ? { type: "integer", minimum: 1, maximum: 3 } :
      spec.type === "int"   ? { type: "integer", minimum: 1, maximum: 99 } :
      spec.type === "bool"  ? { type: "boolean" } :
      spec.type === "hex"   ? { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } :
                              { type: "string", enum: spec.values };
    properties[f] = {
      type: "object",
      additionalProperties: false,
      required: ["value", "confidence", "why"],
      properties: {
        value,
        confidence: { type: "number", minimum: 0, maximum: 1 },
        why: { type: "string", description: "One short sentence, from what is visible in the photo." }
      }
    };
    required.push(f);
  }
  return { type: "object", additionalProperties: false, required, properties };
}

function prompt(item, fields) {
  const lines = [
    `This is a single garment from someone's wardrobe, photographed and cut out.`,
    `They named it "${item.name}".`,
    `It is worn as: ${item.slot}${item.slot === "top" ? ` (layer ${item.layer || 1})` : ""}.`,
    ``,
    `Work out only these, from the photo and the name:`,
    ...fields.map((f) => `- ${f}: ${FIELDS[f].help}`),
    ``,
    `Judge what you can see. Where the photo genuinely does not settle it -- how thick a knit is`,
    `often does not survive a photograph -- say so with a low confidence rather than committing.`,
    `Every answer is reviewed by hand before it counts, so an honest 0.4 is more useful than a`,
    `confident guess.`
  ];
  return lines.join("\n");
}

async function ask(client, zod, helpers, item, image, fields) {
  const shape = {};
  for (const f of fields) {
    const spec = FIELDS[f];
    const value =
      spec.type === "step"  ? zod.number().int().min(1).max(5) :
      spec.type === "step3" ? zod.number().int().min(1).max(3) :
      spec.type === "int"   ? zod.number().int().min(1).max(99) :
      spec.type === "bool"  ? zod.boolean() :
      spec.type === "hex"   ? zod.string() :
                              zod.enum(spec.values);
    shape[f] = zod.object({
      value,
      confidence: zod.number().min(0).max(1),
      why: zod.string()
    });
  }
  const schema = zod.object(shape);

  const content = [];
  if (image) {
    content.push({ type: "image", source: { type: "base64", media_type: image.type, data: image.data } });
  }
  content.push({ type: "text", text: prompt(item, fields) });

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content }],
    output_config: { format: helpers.zodOutputFormat(schema) }
  });
  if (response.stop_reason === "refusal") {
    throw new Error("the model declined to answer for " + item.name);
  }
  return response.parsed_output;
}

function loadImage(item) {
  if (!item.image) return null;
  const path = join(ROOT, "wardrobe", item.image.replace(/^items\//, "items/"));
  if (!existsSync(path)) return null;
  const type = path.endsWith(".webp") ? "image/webp" : path.endsWith(".png") ? "image/png" : "image/jpeg";
  return { type, data: readFileSync(path).toString("base64") };
}

// ---------------------------------------------------------------------- main

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const wardrobe = JSON.parse(readFileSync(DATA, "utf8"));
  const work = collectWork(wardrobe);
  const today = new Date().toISOString().slice(0, 10);

  if (!work.length) {
    console.log("Nothing to fill in — every item is either answered or already waiting for review.");
    return;
  }
  console.log(`${work.length} item(s) with gaps:`);
  for (const w of work) console.log(`  ${w.item.name}: ${w.fields.join(", ")}`);
  if (dryRun) { console.log("\n--dry-run: stopping before calling the model."); return; }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Add it as a repository secret.");
    process.exit(1);
  }

  // Imported lazily so the pure half of this file can be tested with nothing
  // installed.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const zod = await import("zod");
  const helpers = await import("@anthropic-ai/sdk/helpers/zod");
  const client = new Anthropic();

  const proposals = [];
  for (const { item, fields } of work) {
    const image = loadImage(item);
    try {
      const answer = await ask(client, zod.z, helpers, item, image, fields);
      proposals.push({ id: item.id, fields: answer });
      const summary = Object.entries(answer)
        .map(([f, v]) => `${f}=${v.value} (${Math.round(v.confidence * 100)}%)`).join(", ");
      console.log(`  ${item.name}: ${summary}${image ? "" : "  [no photo — from the name alone]"}`);
    } catch (err) {
      console.error(`  ${item.name}: skipped — ${err.message}`);
    }
  }

  const report = applyProposals(wardrobe, proposals, today);
  console.log(`\nProposed ${report.filled} field(s) across ${report.items} item(s).`);
  if (report.refusedSettled) console.log(`Left alone: ${report.refusedSettled} field(s) already answered by hand.`);
  if (report.refusedInvalid) console.log(`Discarded: ${report.refusedInvalid} answer(s) that failed validation.`);

  if (!report.filled) { console.log("Nothing to write."); return; }
  writeFileSync(DATA, JSON.stringify(wardrobe, null, 2) + "\n");
  console.log("Wrote wardrobe/wardrobe.json. Everything is a proposal until accepted in the app.");
}

// Only run when invoked directly, so the exports above stay importable.
if (process.argv[1] && process.argv[1].endsWith("wardrobe-agent.mjs")) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
