const $ = (s)=>document.querySelector(s);
const imgExts = new Set([".jpg",".jpeg",".png",".gif",".webp",".bmp",".tiff"]);
const vidExts = new Set([".mp4",".mov",".webm",".avi",".mkv"]);

let last = null;

async function doScan(){
  const dir = $("#dir").value || ".";
  $("#stats").textContent = "Scan en cours...";
  const r = await fetch(`/api/scan?dir=${encodeURIComponent(dir)}&hash=1`);
  const j = await r.json();
  if(!j.ok){ $("#stats").textContent = "Erreur: " + j.error; return; }
  last = j;
  $("#stats").textContent = `Dossier: ${j.root} — Fichiers: ${j.count} — Groupes de doublons: ${j.groups}`;
  renderGroups(j.dups);
}

function mediaElem(file){
  const ext = file.ext?.toLowerCase() || "";
  const src = `/file?path=${encodeURIComponent(file.path)}`;
  if(imgExts.has(ext)){
    const img = document.createElement("img");
    img.className = "thumb"; img.loading = "lazy"; img.src = src;
    return img;
  }
  if(vidExts.has(ext)){
    const v = document.createElement("video");
    v.className = "thumb"; v.controls = true; v.preload = "metadata"; v.src = src;
    return v;
  }
  const pre = document.createElement("pre");
  pre.textContent = file.path;
  return pre;
}

function card(file){
  const div = document.createElement("div"); div.className="card";
  div.appendChild(mediaElem(file));
  const meta = document.createElement("div"); meta.className="meta";
  meta.innerHTML = `
    <div>${file.path}</div>
    <div>Taille: ${file.sizeHuman} — Modifié: ${new Date(file.mtime).toLocaleString()}</div>
    <div>SHA1: ${file.sha1?.slice(0,12) ?? "n/a"}</div>
  `;
  div.appendChild(meta);
  return div;
}

function renderGroups(dups){
  const root = $("#groups");
  root.innerHTML = "";
  if(!dups || !dups.length){
    root.textContent = "Aucun doublon détecté.";
    return;
  }
  // Limiter l’affichage initial si énorme
  const MAX = 200;
  const slice = dups.slice(0, MAX);
  if(dups.length > MAX){
    const note = document.createElement("div");
    note.className = "stats";
    note.textContent = `Affichage des ${MAX} premiers groupes sur ${dups.length}. Continuez avec Simuler/Déplacer pour tout traiter.`;
    root.appendChild(note);
  }
  slice.forEach((group, idx)=>{
    const g = document.createElement("div"); g.className="group";
    const total = group.reduce((s,x)=>s+x.size,0);
    const h = document.createElement("h3");
    h.textContent = `Groupe #${idx+1} — ${group.length} fichiers — Total ${humanBytes(total)}`;
    g.appendChild(h);
    const files = document.createElement("div"); files.className="files";
    group.forEach(f => files.appendChild(card(f)));
    g.appendChild(files);
    root.appendChild(g);
  });
}
function humanBytes(n){ const u=["B","KB","MB","GB","TB"]; let i=0,v=n; while(v>=1024&&i<u.length-1){v/=1024;i++;} return `${v.toFixed(1)} ${u[i]}`; }

async function doMove(dryRun){
  if(!last){ await doScan(); if(!last) return; }
  const keep = $("#keep").value;
  const dest = $("#dest").value || "./dups";
  const preserveDirs = $("#preserve").checked;
  const body = { keep, dest, dryRun, preserveDirs, dir: $("#dir").value || "." };
  const r = await fetch("/api/move",{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if(!j.ok){ alert("Erreur: " + j.error); return; }
  if(dryRun){
    $("#stats").textContent = `Simulation: ${j.planned} déplacements planifiés. Exemple: ${j.sample?.length||0} affichés dans la console.`;
    console.log("Exemple d’opérations (dry-run):", j.sample);
  }else{
    $("#stats").textContent = `Déplacement effectué. Fichiers déplacés: ${j.moved}` + (j.errors?`, erreurs: ${j.errors}`:"") + ` → ${j.dest}`;
    // Re-scan après action
    await doScan();
  }
}

// Bind UI
$("#scan").addEventListener("click", ()=>doScan());
$("#dry").addEventListener("click", ()=>doMove(true));
$("#move").addEventListener("click", ()=>doMove(false));
// Scan initial
doScan();
