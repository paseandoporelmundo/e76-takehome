import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SOURCES, type Source } from "../config/tenants.js";

// Reading files off disk: discovery, manifest lookup and parsing. No database here.

export interface Delivery {
  source: Source;
  file: string;          // absolute path
  name: string;          // path relative to the fixtures dir, e.g. <tenant>/orders/batch_03.csv
  batch: number | null;  // from the manifest
}

export interface ManifestEntry {
  tenant: string;
  source: string;
  batch: number;
  path: string;
  covers_from: string;
  covers_to: string;
}

export async function readManifest(fixturesDir: string): Promise<ManifestEntry[]> {
  try {
    return JSON.parse(await readFile(path.join(fixturesDir, "manifest.json"), "utf8")).batches;
  } catch {
    return [];
  }
}

/** Every file present for a tenant, in delivery order: batch first, then source. */
export async function discover(fixturesDir: string, slug: string): Promise<Delivery[]> {
  const manifest = await readManifest(fixturesDir);
  const out: Delivery[] = [];
  for (const source of SOURCES) {
    const dir = path.join(fixturesDir, slug, source);
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((f) => !f.startsWith(".")).sort();
    } catch {
      continue; // no folder = nothing delivered for this source; check-arrivals reports it
    }
    for (const f of files) {
      const name = `${slug}/${source}/${f}`;
      const listed = manifest.find((m) => m.path === name);
      out.push({ source, file: path.join(dir, f), name, batch: listed?.batch ?? null });
    }
  }
  const order = (d: Delivery) => (d.batch ?? Number.MAX_SAFE_INTEGER) * 10 + SOURCES.indexOf(d.source);
  return out.sort((a, b) => order(a) - order(b));
}

export interface Parsed {
  header: string[];
  rows: Record<string, string>[];
}

export function parse(content: string, format: "csv" | "ndjson"): Parsed {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (format === "ndjson") {
    const rows = lines.map((l) => {
      const obj = JSON.parse(l) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v == null ? "" : String(v)]));
    });
    const header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { header, rows };
  }
  const [head, ...body] = lines;
  const header = splitCsvLine(head).map((h) => h.trim());
  const rows = body.map((l) => {
    const cells = splitCsvLine(l);
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? "").trim()]));
  });
  return { header, rows };
}

// Minimal RFC 4180 line splitter: handles quoted fields and doubled quotes.
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
