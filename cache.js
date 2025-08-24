// cache.js (ESM) — cache simple sur disque pour les hachages
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "memescanner-cache.json");

function keyFor(file, st) {
  return `${file}|${st.size}|${st.mtimeMs}`;
}

export async function loadCache() {
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const buf = await fsp.readFile(CACHE_FILE, "utf8");
    const parsed = JSON.parse(buf);
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

export async function saveCache(map) {
  const obj = Object.fromEntries(map);
  const tmp = CACHE_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(obj), "utf8");
  await fsp.rename(tmp, CACHE_FILE);
}

export function getCached(map, file, st) {
  const k = keyFor(file, st);
  const v = map.get(k);
  return v ? JSON.parse(v) : null;
}

export function setCached(map, file, st, data) {
  const k = keyFor(file, st);
  map.set(k, JSON.stringify(data));
}
