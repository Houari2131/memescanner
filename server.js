// server.js (ESM) — UI locale pour réviser et déplacer les doublons
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_EXTS = [".jpg",".jpeg",".png",".gif",".webp",".bmp",".tiff",".mp4",".mov",".webm",".avi",".mkv"];
const app = express();
app.use(express.json());
// Sert la petite UI (voir public/index.html + public/app.js)
app.use(express.static("public"));

let lastScan = null; // { root, results, dups }

function humanBytes(n){const u=["B","KB","MB","GB","TB"];let i=0,v=n;while(v>=1024&&i<u.length-1){v/=1024;i++;}return `${v.toFixed(1)} ${u[i]}`;}
async function walk(root,{includeHidden=true,maxFiles=Infinity}={}){
  const out=[], stack=[root]; const IGNORE=new Set(["node_modules",".git",".pnpm-store"]);
  while(stack.length && out.length<maxFiles){
    const cur=stack.pop(); let ents=[];
    try{ ents=await fsp.readdir(cur,{withFileTypes:true}); }catch{ continue; }
    for(const e of ents){
      const name=e.name; if(!includeHidden && name.startsWith(".")) continue;
      const full=path.join(cur,name);
      if(e.isDirectory()){ if(IGNORE.has(name)) continue; stack.push(full); }
      else if(e.isFile()){ out.push(full); if(out.length>=maxFiles) break; }
    }
  }
  return out;
}
function fileHashSha1(file){ return new Promise((res,rej)=>{ const h=crypto.createHash("sha1"); const s=fs.createReadStream(file);
  s.on("error",rej); s.on("data",c=>h.update(c)); s.on("end",()=>res(h.digest("hex"))); }); }
function pickKeeper(list, mode){
  const by = {
    first: (a,b)=>0,
    newest: (a,b)=>new Date(b.mtime)-new Date(a.mtime),
    oldest: (a,b)=>new Date(a.mtime)-new Date(b.mtime),
    largest:(a,b)=>b.size-a.size,
    smallest:(a,b)=>a.size-b.size
  };
  const cmp = by[mode] ?? by.newest;
  return [...list].sort(cmp)[0];
}
async function ensureDir(d){ await fsp.mkdir(d,{recursive:true}); }
async function uniqueTargetPath(destRoot, relPath){
  const ext=path.extname(relPath), base=path.basename(relPath,ext), dir=path.dirname(relPath);
  let cand=path.join(destRoot,dir,base+ext); let i=1;
  while(true){ try{ await fsp.access(cand); cand=path.join(destRoot,dir,`${base} (dup${i})${ext}`); i++; } catch{ return cand; } }
}
async function safeMove(src,dest){
  try{ await ensureDir(path.dirname(dest)); await fsp.rename(src,dest); }
  catch(e){ if(e.code==="EXDEV"||e.code==="EPERM"||e.code==="EACCES"){ await ensureDir(path.dirname(dest)); await fsp.copyFile(src,dest); await fsp.unlink(src); }
            else throw e; }
}

async function scan({dir=".", exts=DEFAULT_EXTS, includeHidden=true, maxFiles=Infinity, hash=true}){
  const root=path.resolve(process.cwd(),dir);
  const all=await walk(root,{includeHidden,maxFiles});
  const setExts=new Set(exts.map(e=>e.toLowerCase()));
  const media=all.filter(f=>setExts.has(path.extname(f).toLowerCase()));
  const results=[]; let totalBytes=0;
  for(const file of media){
    let st; try{ st=await fsp.stat(file); }catch{ continue; }
    const item={ path: path.relative(root,file), absPath:file, size:st.size, sizeHuman:humanBytes(st.size), mtime: st.mtime.toISOString(), ext:path.extname(file).toLowerCase() };
    if(hash){ try{ item.sha1=await fileHashSha1(file); }catch(e){ item.sha1=null; item.hashError=e.message; } }
    results.push(item); totalBytes+=st.size;
  }
  // group by sha1
  const byHash=new Map();
  for(const r of results){ if(!r.sha1) continue; if(!byHash.has(r.sha1)) byHash.set(r.sha1,[]); byHash.get(r.sha1).push(r); }
  const dups=[...byHash.values()].filter(g=>g.length>1);
  dups.sort((a,b)=> (b.reduce((s,x)=>s+x.size,0)) - (a.reduce((s,x)=>s+x.size,0)));
  lastScan={root,results,dups,totalBytes};
  return lastScan;
}

app.get("/api/scan", async (req,res)=>{
  try{
    const dir = req.query.dir || ".";
    const includeHidden = req.query.includeHidden !== "0";
    const maxFiles = req.query.maxFiles ? Number(req.query.maxFiles) : Infinity;
    const out = await scan({dir, includeHidden, maxFiles, hash:true});
    res.json({ ok:true, ...out, count: out.results.length, groups: out.dups.length });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// Sert un fichier media depuis la racine scannée (pour aperçus)
app.get("/file", async (req,res)=>{
  try{
    if(!lastScan) return res.status(400).send("Scan first");
    const rel=req.query.path;
    if(!rel) return res.status(400).send("Missing path");
    const abs=path.resolve(lastScan.root, rel);
    if(!abs.startsWith(lastScan.root)) return res.status(403).send("Forbidden");
    res.sendFile(abs);
  }catch(e){ res.status(500).send(e.message); }
});

// Déplace les doublons selon la règle keep
app.post("/api/move", async (req,res)=>{
  try{
    const opts=req.body || {};
    const keep = opts.keep || "newest";
    const dest = path.resolve(process.cwd(), opts.dest || "./dups");
    const dryRun = !!opts.dryRun;
    const preserveDirs = !!opts.preserveDirs;

    if(!lastScan) await scan({dir: opts.dir || ".", hash:true});
    const {root, dups}=lastScan;
    if(!dups || !dups.length) return res.json({ ok:true, moved:0, message:"Aucun doublon" });

    await ensureDir(dest);
    let moved=0, errors=0; const ops=[];
    for(const group of dups){
      const keeper=pickKeeper(group, keep);
      for(const f of group){
        if(f===keeper) continue;
        const rel = preserveDirs ? f.path : path.basename(f.path);
        const target = await uniqueTargetPath(dest, rel);
        ops.push({ from: path.join(root, f.path), to: target, rel: f.path, size: f.size });
      }
    }
    if(dryRun){
      return res.json({ ok:true, dryRun:true, planned: ops.length, sample: ops.slice(0,10) });
    }
    for(const op of ops){
      try{ await safeMove(op.from, op.to); moved++; }
      catch(e){ errors++; }
    }
    res.json({ ok:true, moved, errors, dest });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`UI Memescanner sur http://localhost:${PORT}`));
