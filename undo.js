// undo.js — annulation via manifest
import fsp from "node:fs/promises";
import path from "node:path";

// Liste les manifests triés (nom puis date) dans ./logs par défaut
export async function listManifests(dir = "logs") {
  try {
    const files = await fsp.readdir(dir);
    const manifests = files.filter(f => /^manifest-.*\.json$/i.test(f));
    const withStat = await Promise.all(manifests.map(async f => {
      const s = await fsp.stat(path.join(dir, f));
      return { f, mtime: s.mtimeMs };
    }));
    withStat.sort((a, b) => b.f.localeCompare(a.f) || b.mtime - a.mtime);
    return withStat.map(x => x.f);
  } catch {
    return [];
  }
}

export async function resolveUndoTarget(val) {
  if (!val || val === true) {
    throw new Error("Précise --undo=<fichier> ou --undo=latest");
  }
  if (val === "latest") {
    const list = await listManifests();
    if (!list.length) throw new Error("Aucun manifest trouvé dans ./logs");
    return path.join("logs", list[0]);
  }
  return path.resolve(val);
}

async function readManifest(p) {
  const buf = await fsp.readFile(p, "utf8");
  return JSON.parse(buf);
}

async function ensureDir(d) {
  await fsp.mkdir(d, { recursive: true });
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

async function exists(p) {
  try { await fsp.stat(p); return true; } catch { return false; }
}

// Annule un manifest donné (chemin absolu/relatif), retourne {undone, errors}
export async function undoFromManifest(mfPath) {
  const mf = await readManifest(mfPath);
  const ops = Array.isArray(mf.ops) ? mf.ops : [];
  let undone = 0, errors = 0;
  for (const op of ops) {
    const from = op.from;
    const to = op.to;
    // On ne supporte que les ops de type "move" (ou équivalent avec from/to)
    if (!from || !to) continue;
    try {
      const srcExists = await exists(from);
      const dstExists = await exists(to);
      // Si la source existe déjà, on ne touche pas; si la destination existe, on tente de la remettre
      if (!srcExists && dstExists) {
        await ensureDir(path.dirname(from));
        await safeMove(to, from);
        undone++;
      }
    } catch {
      errors++;
    }
  }
  return { undone, errors };
}
