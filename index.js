#!/usr/bin/env node
// index.js — CLI de memescanner: scan + détection de doublons + déplacement/Corbeille + UNDO

// --- Imports (ESM)
import { resolveUndoTarget, undoFromManifest } from "./undo.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import trash from "trash";
import { loadCache, saveCache, getCached, setCached } from "./cache.js";

// --- Constantes
const DEFAULT_EXTS = [
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff",
  ".mp4", ".mov", ".webm", ".avi", ".mkv"
];

// --- Utilitaires simples
function humanBytes(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

// FIX: accepter les espaces optionnels entre nombre et unité
function parseSize(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i.exec(String(s).trim());
  if (!m) return Number(s) || 0;
  const n = parseFloat(m[1]);
  const u = (m[2] || "B").toUpperCase();
  const f = u === "GB" ? 1024 ** 3 : u === "MB" ? 1024 ** 2 : u === "KB" ? 1024 : 1;
  return Math.round(n * f);
}

// --- Parsing des arguments (ignore le séparateur "--" de pnpm)
function parseArgs(argv) {
  const opts = {
    dir: ".",
    out: null,
    hash: false,
    maxFiles: Infinity,
    includeHidden: false,
    exts: DEFAULT_EXTS,
    moveDuplicates: null,
    keep: "newest",
    dryRun: false,
    preserveDirs: false,
    minSize: 32 * 1024,         // ignore < 32KB par défaut
    trashDuplicates: false,     // envoyer à la Corbeille au lieu de déplacer
    undo: null                  // chemin d’un manifest ou "latest"
  };

  for (const aRaw of argv) {
    if (aRaw === "--") continue; // important pour pnpm run ... -- ...
    const a = String(aRaw);
    if (!a.startsWith("--")) continue;

    if (a.includes("=")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (k === "dir") opts.dir = v;
      else if (k === "out") opts.out = v;
      else if (k === "max-files") opts.maxFiles = Number(v);
      // FIX: normaliser les extensions (ajouter le point si manquant)
      else if (k === "exts") {
        opts.exts = v
          .split(",")
          .map(s => s.trim().toLowerCase())
          .filter(s => s.length > 0)
          .map(s => (s.startsWith(".") ? s : "." + s));
      }
      else if (k === "move-duplicates") opts.moveDuplicates = v;
      else if (k === "keep") opts.keep = v;
      else if (k === "min-size") opts.minSize = parseSize(v);
      else if (k === "undo") opts.undo = v; // accepte "latest" ou un chemin
    } else {
      const k = a.slice(2);
      if (k === "hash") opts.hash = true;
      else if (k === "include-hidden") opts.includeHidden = true;
      else if (k === "dry-run") opts.dryRun = true;
      else if (k === "preserve-dirs") opts.preserveDirs = true;
      else if (k === "trash-duplicates") opts.trashDuplicates = true;
      else if (k === "help" || k === "h") {
        console.log(`Usage:
  node index.js --dir=PATH [--out=result.json] [--hash] [--max-files=N]
                [--exts=jpg,png,mp4] [--include-hidden] [--min-size=64KB]
                [--move-duplicates=DIR] [--trash-duplicates]
                [--keep=first|newest|oldest|largest|smallest] [--dry-run] [--preserve-dirs]
                [--undo=latest|logs/manifest-*.json]

Notes:
- --exts accepte avec ou sans point (jpg ou .jpg).
- --min-size accepte "B, KB, MB, GB", avec ou sans espace (ex: 1KB, 1 KB, 1024).`);
        process.exit(0);
      }
    }
  }
  return opts;
}

// --- FS helpers
async function ensureDir(d) { await fsp.mkdir(d, { recursive: true }); }

async function uniqueTargetPath(destRoot, relPath) {
  const ext = path.extname(relPath), base = path.basename(relPath, ext), dir = path.dirname(relPath);
  let cand = path.join(destRoot, dir, base + ext); let i = 1;
  for (;;) {
    try { await fsp.access(cand); }
    catch { return cand; }
    cand = path.join(destRoot, dir, `${base} (dup${i})${ext}`); i++;
  }
}

async function safeMove(src, dest) {
  try {
    await ensureDir(path.dirname(dest));
    await fsp.rename(src, dest);
  } catch (e) {
    if (e.code === "EXDEV" || e.code === "EPERM" || e.code === "EACCES") {
      await ensureDir(path.dirname(dest));
      await fsp.copyFile(src, dest);
      await fsp.unlink(src);
    } else {
      throw e;
    }
  }
}

// --- Manifests (écriture)
async function writeManifest(ops) {
  const dir = path.resolve(process.cwd(), "logs");
  await ensureDir(dir);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `manifest-${ts}.json`);
  await fsp.writeFile(file, JSON.stringify({ createdAt: new Date().toISOString(), ops }, null, 2), "utf8");
  return file;
}

// --- Walk + signatures
async function walk(root, { includeHidden = false, maxFiles = Infinity } = {}) {
  const out = [];
  const stack = [root];
  const IGNORE = new Set(["node_modules", ".git", ".pnpm-store", ".cache"]);
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const name = ent.name;
      if (!includeHidden && name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        if (IGNORE.has(name)) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        out.push(full);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

// Hash rapide: lit 256KB du début et de la fin
async function quickSig(file, size) {
  const CHUNK = 256 * 1024;
  const h = crypto.createHash("sha1");
  const fh = await fsp.open(file, "r");
  try {
    if (size <= CHUNK * 2) {
      const buf = Buffer.allocUnsafe(size);
      await fh.read(buf, 0, size, 0);
      h.update(buf);
    } else {
      const head = Buffer.allocUnsafe(CHUNK);
      const tail = Buffer.allocUnsafe(CHUNK);
      await fh.read(head, 0, CHUNK, 0);
      await fh.read(tail, 0, CHUNK, size - CHUNK);
      h.update(head); h.update(tail);
    }
    return h.digest("hex");
  } finally {
    await fh.close();
  }
}

async function sha1File(file) {
  return await new Promise((resolve, reject) => {
    const h = crypto.createHash("sha1");
    const s = fs.createReadStream(file);
    s.on("error", reject);
    s.on("data", c => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

function pickKeeper(list, mode) {
  const by = {
    first: (a, b) => 0,
    newest: (a, b) => new Date(b.mtime) - new Date(a.mtime),
    oldest: (a, b) => new Date(a.mtime) - new Date(b.mtime),
    largest: (a, b) => b.size - a.size,
    smallest: (a, b) => a.size - b.size
  };
  const cmp = by[mode] ?? by.newest;
  return [...list].sort(cmp)[0];
}

// --- Scan avec cache et quickSig -> SHA-1 pour groupes suspects
async function scan({ dir = ".", exts = DEFAULT_EXTS, includeHidden = false, maxFiles = Infinity, minSize = 0, wantSha1 = false }) {
  const cache = await loadCache();
  const root = path.resolve(process.cwd(), dir);
  const all = await walk(root, { includeHidden, maxFiles });
  const setExts = new Set(exts.map(e => e.toLowerCase()));
  const media = all.filter(f => setExts.has(path.extname(f).toLowerCase()));
  const results = []; let totalBytes = 0;

  // 1) métadonnées + quickSig (ou cache)
  const tmpByKS = new Map(); // clé: size+quickSig -> items[]
  for (const file of media) {
    let st; try { st = await fsp.stat(file); } catch { continue; }
    if (st.size < minSize) continue;
    const rel = path.relative(root, file);
    const cached = getCached(cache, file, st);
    let qsig, sha1;
    if (cached && cached.qsig && (!wantSha1 || cached.sha1)) {
      qsig = cached.qsig;
      sha1 = cached.sha1 || null;
    } else {
      try { qsig = await quickSig(file, st.size); }
      catch { qsig = null; }
    }
    const item = {
      path: rel, absPath: file, size: st.size, sizeHuman: humanBytes(st.size),
      mtime: st.mtime.toISOString(), ext: path.extname(file).toLowerCase(),
      qsig, sha1: wantSha1 ? (cached?.sha1 ?? null) : (cached?.sha1 ?? null)
    };
    results.push(item); totalBytes += st.size;

    if (qsig) {
      const k = `${st.size}|${qsig}`;
      if (!tmpByKS.has(k)) tmpByKS.set(k, []);
      tmpByKS.get(k).push(item);
    }
  }

  // 2) SHA-1 complet pour les groupes suspects
  for (const [, list] of tmpByKS) {
    if (list.length < 2) continue;
    for (const it of list) {
      if (!it.sha1) {
        try {
          it.sha1 = await sha1File(it.absPath);
          const st = await fsp.stat(it.absPath).catch(() => null);
          if (st) setCached(cache, it.absPath, st, { qsig: it.qsig, sha1: it.sha1 });
        } catch {
          it.sha1 = null;
        }
      }
    }
  }

  await saveCache(cache);

  // 3) Groupes de doublons confirmés par SHA-1
  const byHash = new Map();
  for (const r of results) {
    if (!r.sha1) continue;
    if (!byHash.has(r.sha1)) byHash.set(r.sha1, []);
    byHash.get(r.sha1).push(r);
  }
  const dups = [...byHash.values()].filter(g => g.length > 1)
    .sort((a, b) => (b.reduce((s, x) => s + x.size, 0)) - (a.reduce((s, x) => s + x.size, 0)));

  return { root, results, dups, totalBytes };
}

// --- Exécution des actions (move/trash) + génération du manifest
async function moveOrTrashDups({ root, dups, keep, dest, dryRun, preserveDirs, useTrash }) {
  const ops = []; // {from, to?, mode:"move"|"trash"}
  if (!useTrash && dest) await ensureDir(dest);
  let moved = 0, errors = 0;

  for (const group of dups) {
    const keeper = pickKeeper(group, keep);
    for (const f of group) {
      if (f === keeper) continue;
      if (useTrash) {
        ops.push({ from: path.join(root, f.path), mode: "trash" });
      } else {
        const rel = preserveDirs ? f.path : path.basename(f.path);
        const target = await uniqueTargetPath(dest, rel);
        ops.push({ from: path.join(root, f.path), to: target, mode: "move" });
      }
    }
  }

  if (dryRun) {
    return { moved: 0, errors: 0, manifest: null, planned: ops.length, sample: ops.slice(0, 10), ops };
  }

  for (const op of ops) {
    try {
      if (op.mode === "trash") {
        await trash([op.from]);
      } else {
        await safeMove(op.from, op.to);
      }
      moved++;
    } catch {
      errors++;
    }
  }

  const manifest = await writeManifest(ops);
  return { moved, errors, manifest, planned: ops.length, sample: ops.slice(0, 10) };
}

// --- Main
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Branche UNDO (supporte --undo=latest)
  if (opts.undo) {
    const mfPath = await resolveUndoTarget(opts.undo);
    const res = await undoFromManifest(mfPath);
    console.log(`Annulation: restaurés ${res.undone}` + (res.errors ? `, erreurs: ${res.errors}` : ""));
    return;
  }

  // Scan
  const { root, results, dups, totalBytes } = await scan({
    dir: opts.dir, exts: opts.exts, includeHidden: opts.includeHidden, maxFiles: opts.maxFiles,
    minSize: opts.minSize, wantSha1: opts.hash
  });

  console.log(`Dossier: ${root}`);
  console.log(`Fichiers: ${results.length} | Total: ${humanBytes(totalBytes)} | Groupes de doublons: ${dups.length}`);

  // Export JSON des résultats si demandé
  if (opts.out) {
    const outPath = path.resolve(process.cwd(), opts.out);
    await fsp.writeFile(outPath, JSON.stringify({ root, count: results.length, totalBytes, results }, null, 2), "utf8");
    console.log(`Résultats écrits dans: ${outPath}`);
  }

  // Actions sur les doublons
  if (opts.moveDuplicates || opts.trashDuplicates) {
    if (opts.dryRun) console.log("[dry-run] aucun fichier ne sera modifié.");
    const destRoot = opts.moveDuplicates ? path.resolve(process.cwd(), opts.moveDuplicates) : null;
    const { moved, errors, manifest, planned } = await moveOrTrashDups({
      root, dups, keep: opts.keep, dest: destRoot, dryRun: opts.dryRun,
      preserveDirs: opts.preserveDirs, useTrash: opts.trashDuplicates
    });
    if (opts.dryRun) {
      console.log(`Simulation: ${planned} opérations prévues.`);
    } else {
      console.log(`Opérations réalisées: ${moved}` + (errors ? `, erreurs: ${errors}` : ""));
      if (manifest) console.log(`Manifest: ${path.relative(process.cwd(), manifest)} (pour annuler)`);
    }
  }

  console.log("Memescanner prêt");
}

main().catch(err => { console.error("Erreur:", err); process.exit(1); });
