#!/usr/bin/env node

/**
 * Agregace RSS/Atom feedů do JSON souborů pro statický frontend.
 *
 * - načte seznam feedů ze `scripts/sources.json`
 * - stáhne XML (RSS/Atom)
 * - vybere položky (item/entry)
 * - filtruje podle klíčových slov
 * - normalizuje do jednotného formátu:
 *   { title, source, url, publishedAt }
 * - deduplikace podle URL, řazení dle data
 * - uloží do `data/cz.json` a `data/intl.json`
 *
 * Pozn.: Parser je „good enough“ pro RSS 2.0 + Atom. Neřeší 100 % edge-caseů,
 * ale pro MVP bez závislostí funguje dobře.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SCRIPTS_DIR = path.join(ROOT, "scripts");

const SOURCES_PATH = path.join(SCRIPTS_DIR, "sources.json");
const CZ_OUT = path.join(DATA_DIR, "cz.json");
const INTL_OUT = path.join(DATA_DIR, "intl.json");

const BRAND_KEYWORDS = [
  "temu",
  "shein",
  "aliexpress",
  "ali express",
  "alibaba",
  "wish",
];

// obecné „kontekstové“ výrazy, které drží relevanci k online nákupům / platformám
const CONTEXT_KEYWORDS = [
  "marketplace",
  "online marketplace",
  "e-shop",
  "eshop",
  "online shop",
  "online shopping",
  "ultra-fast fashion",
  "fast fashion",
];

// tematické okruhy, které chceme – ale samy o sobě můžou být příliš široké
const TOPIC_KEYWORDS = [
  "padělek",
  "padělky",
  "counterfeit",
  "product safety",
  "unsafe",
  "bezpečnost výrobků",
  "nebezpečný výrobek",
  "consumer protection",
  "ochrana spotřebitele",
  "toxic",
  "toxický",
  "hazardous",
  "recall",
  "stahování z trhu",
];

const MAX_ITEMS_PER_BUCKET = 80; // CZ / INTL
const REQUEST_TIMEOUT_MS = 15_000;

function loadSources() {
  const raw = fs.readFileSync(SOURCES_PATH, "utf8");
  return JSON.parse(raw);
}

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function stripCdata(s) {
  if (!s) return "";
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripTags(s) {
  if (!s) return "";
  return s.replace(/<[^>]*>/g, " ");
}

function normalizeText(s) {
  return stripTags(decodeEntities(stripCdata(String(s || ""))))
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(xml, patterns) {
  for (const re of patterns) {
    const m = xml.match(re);
    if (m && m[1]) return m[1];
  }
  return "";
}

function extractAllBlocks(xml, tag) {
  const re = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi");
  return xml.match(re) || [];
}

function safeUrl(u) {
  if (!u) return "";
  const s = u.trim();
  if (!/^https?:\/\//i.test(s)) return "";
  return s;
}

function guessSourceName(feedXml, feedUrl) {
  const titleRaw = firstMatch(feedXml, [
    /<channel[\s\S]*?<title>([\s\S]*?)<\/title>/i, // RSS
    /<feed[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i, // Atom
  ]);
  const title = normalizeText(titleRaw);
  if (title) return title;
  try {
    return new URL(feedUrl).hostname.replace(/^www\./, "");
  } catch {
    return "Neznámý zdroj";
  }
}

function parseDateToIso(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

function matchesKeywords(text) {
  const t = (text || "").toLowerCase();

  const brandMatch = BRAND_KEYWORDS.some((k) => t.includes(k));
  if (brandMatch) return true;

  const contextMatch = CONTEXT_KEYWORDS.some((k) => t.includes(k));
  const topicMatch = TOPIC_KEYWORDS.some((k) => t.includes(k.toLowerCase()));

  return topicMatch && contextMatch;
}

async function parseRssItems(feedXml, feedUrl) {
  const sourceName = guessSourceName(feedXml, feedUrl);
  const itemBlocks = extractAllBlocks(feedXml, "item");
  const items = await Promise.all(
    itemBlocks.map(async (block) => {
      const title = normalizeText(firstMatch(block, [/<title>([\s\S]*?)<\/title>/i]));
      const linkRaw = normalizeText(firstMatch(block, [/<link>([\s\S]*?)<\/link>/i]));
      const link = safeUrl(linkRaw);
      const pubDate = normalizeText(
        firstMatch(block, [
          /<pubDate>([\s\S]*?)<\/pubDate>/i,
          /<dc:date>([\s\S]*?)<\/dc:date>/i,
        ])
      );
      const desc = normalizeText(
        firstMatch(block, [
          /<description>([\s\S]*?)<\/description>/i,
          /<content:encoded>([\s\S]*?)<\/content:encoded>/i,
        ])
      );

      return {
        title,
        source: sourceName,
        url: link,
        publishedAt: parseDateToIso(pubDate),
        _search: `${title} ${desc}`.trim(),
      };
    })
  );
  return items;
}

async function parseAtomEntries(feedXml, feedUrl) {
  const sourceName = guessSourceName(feedXml, feedUrl);
  const entryBlocks = extractAllBlocks(feedXml, "entry");
  const items = await Promise.all(
    entryBlocks.map(async (block) => {
      const title = normalizeText(
        firstMatch(block, [/<title[^>]*>([\s\S]*?)<\/title>/i])
      );

      const hrefRaw =
        firstMatch(block, [
          /<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i,
          /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i,
        ]) || "";

      const href = safeUrl(hrefRaw);
      const link = href;
      const published = normalizeText(
        firstMatch(block, [
          /<published>([\s\S]*?)<\/published>/i,
          /<updated>([\s\S]*?)<\/updated>/i,
        ])
      );
      const summary = normalizeText(
        firstMatch(block, [
          /<summary[^>]*>([\s\S]*?)<\/summary>/i,
          /<content[^>]*>([\s\S]*?)<\/content>/i,
        ])
      );

      return {
        title,
        source: sourceName,
        url: link,
        publishedAt: parseDateToIso(published),
        _search: `${title} ${summary}`.trim(),
      };
    })
  );
  return items;
}

async function parseFeed(feedXml, feedUrl) {
  const xml = String(feedXml || "");
  const hasRss = /<rss\b/i.test(xml) || /<channel\b/i.test(xml);
  const hasAtom = /<feed\b/i.test(xml) && /<entry\b/i.test(xml);
  if (hasRss) return await parseRssItems(xml, feedUrl);
  if (hasAtom) return await parseAtomEntries(xml, feedUrl);
  const rss = await parseRssItems(xml, feedUrl);
  const atom = await parseAtomEntries(xml, feedUrl);
  return rss.length >= atom.length ? rss : atom;
}

async function fetchWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "cinskysmejdy.cz (GitHub Actions) RSS aggregator",
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function normalizeAndFilter(items) {
  const filtered = items
    .filter((x) => x && x.url && x.title)
    .filter((x) => matchesKeywords(x._search || x.title || ""));

  const seen = new Set();
  const deduped = [];
  for (const x of filtered) {
    const key = x.url;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      title: x.title,
      source: x.source,
      url: x.url,
      publishedAt: x.publishedAt || new Date().toISOString(),
    });
  }

  deduped.sort((a, b) => {
    const ta = Date.parse(a.publishedAt || "");
    const tb = Date.parse(b.publishedAt || "");
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });

  return deduped.slice(0, MAX_ITEMS_PER_BUCKET);
}

async function aggregateBucket(feedUrls, bucketName) {
  const all = [];
  for (const item of feedUrls) {
    // Podpora pro novou strukturu (objekt s topic/rss) i starou (string URL)
    const url = typeof item === "string" ? item : item?.rss;
    const topic = typeof item === "object" ? item?.topic : null;
    
    if (!url) {
      console.warn(`[${bucketName}] Skip: invalid feed item (missing URL)`);
      continue;
    }
    
    try {
      const topicLabel = topic ? ` [${topic}]` : "";
      console.log(`[${bucketName}] Fetch: ${url}${topicLabel}`);
      const xml = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
      const items = await parseFeed(xml, url);
      console.log(
        `[${bucketName}] Parsed: ${items.length} items (${guessSourceName(
          xml,
          url
        )})${topicLabel}`
      );
      all.push(...items);
    } catch (err) {
      console.error(`[${bucketName}] Failed: ${url} (${err.message})`);
    }
  }
  return normalizeAndFilter(all);
}

function writeJson(outPath, data) {
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");
}

async function main() {
  ensureDirs();

  let sources;
  try {
    sources = loadSources();
  } catch (err) {
    console.error("Chyba při čtení sources.json:", err.message);
    process.exitCode = 1;
    return;
  }

  // Podpora pro novou strukturu (objekty s rss) i starou (pole stringů)
  const cz = Array.isArray(sources.cz) ? sources.cz : [];
  const intl = Array.isArray(sources.intl) ? sources.intl : [];

  if (cz.length === 0 && intl.length === 0) {
    console.error("sources.json neobsahuje žádné zdroje (cz/intl).");
    process.exitCode = 1;
    return;
  }

  const [czOut, intlOut] = await Promise.all([
    aggregateBucket(cz, "CZ"),
    aggregateBucket(intl, "INTL"),
  ]);

  writeJson(CZ_OUT, czOut);
  writeJson(INTL_OUT, intlOut);
  console.log(`Hotovo. CZ: ${czOut.length}, INTL: ${intlOut.length}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Agregace selhala:", err.message);
    process.exitCode = 1;
  });
}

