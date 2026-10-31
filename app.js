"use strict";

// ---------------------------------------------------------------- settings
const SLOTS = { C: 3, W: 5, D: 3, F: 1, SKT: 1, G: 2 };
const DISCOUNT = 0.85;      // weight of each later season in dynasty value
const SKT_BONUS = 0.5;      // SKT slot: +50% on every category
const PAGE = 250;
const DEFAULT_MINE = [
  "Jack Hughes", "Logan Stankoven", "Brock Boeser", "Filip Forsberg", "Matthew Knies",
  "JJ Peterka", "Matthew Tkachuk", "Owen Tippett", "Jake DeBrusk", "Ben Kindel",
  "Jakub Dobes", "Porter Martone", "Anton Frondell", "Michael Hage", "Brady Martin",
  "Radim Mrtka", "Cole Eiserman", "Nate Danielson", "Calum Ritchie", "Nikita Chibrikov",
  "Justin Sourdif",
];
const SK_LABEL = { g: "Buts", ht: "Tours du chapeau", a1: "Passes primaires", a2: "Passes secondaires",
  otp: "Points en prolongation", sog: "Tirs au but", hit: "Mises en échec", blk: "Tirs bloqués (D)",
  tk: "Revirements provoqués (D)", sho: "Blanchissages (D)" };
const GO_LABEL = { w: "Victoires", otw: "Victoires en prol./TB", otl: "Défaites en prol./TB",
  ga: "Buts accordés", sv: "Arrêts", so: "Blanchissages", g: "Buts", a: "Passes" };

// ------------------------------------------------------------------- state
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const S = {
  view: "dynasty", q: "", pos: "ALL", who: "all",
  teams: store.get("teams", 12), agemax: null,
  sort: { dynasty: ["dyn", -1], season: ["vor0", -1], daily: ["week", -1] },
  limit: PAGE,
};
let DATA = null, P = [], BY_ID = new Map(), REPL = {}, SKT_BASE = 0, SPARK_MAX = 1;
let mine = new Set(store.get("mine", null) || []);
let taken = new Set(store.get("taken", []));

const $ = (s) => document.querySelector(s);
const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ------------------------------------------------------------------ values
function computeValues() {
  const N = S.teams;
  const sk = P.filter((p) => p.grp !== "G").sort((a, b) => b.fpy[0] - a.fpy[0]);
  const go = P.filter((p) => p.grp === "G").sort((a, b) => b.fpy[0] - a.fpy[0]);

  // Fill every team's starting lineup greedily, best players first.
  const left = { C: SLOTS.C * N, W: SLOTS.W * N, D: SLOTS.D * N, F: SLOTS.F * N, SKT: SLOTS.SKT * N };
  const starter = new Set();
  for (const p of sk) {
    if (left.C + left.W + left.D + left.F + left.SKT <= 0) break;
    const open = p.p.filter((x) => left[x] > 0).sort((a, b) => left[b] - left[a]);
    let slot = open[0];
    if (!slot && (p.p.includes("C") || p.p.includes("W")) && left.F > 0) slot = "F";
    if (!slot && left.SKT > 0) slot = "SKT";
    if (slot) { left[slot]--; starter.add(p.id); }
  }
  // Replacement level = best player left over at each position.
  REPL = {};
  for (const pos of ["C", "W", "D"]) {
    const r = sk.find((p) => !starter.has(p.id) && p.p.includes(pos));
    REPL[pos] = r ? r.fpy[0] : 0;
  }
  REPL.G = go[SLOTS.G * N] ? go[SLOTS.G * N].fpy[0] : 0;
  // SKT: each team puts its best skater there; bonus counts above the
  // level of the N-th best skater (a typical team's best).
  SKT_BASE = sk[N - 1] ? sk[N - 1].fpy[0] : 0;

  for (const p of P) {
    const elig = p.grp === "G" ? ["G"] : p.p;
    const pos = elig.reduce((best, x) => (REPL[x] < REPL[best] ? x : best), elig[0]);
    const repl = REPL[pos] ?? 0;
    p.vpos = pos;
    p.vor = p.fpy.map((fp) => fp + (p.grp === "G" ? 0 : SKT_BONUS * Math.max(0, fp - SKT_BASE)) - repl);
    p.vor0 = p.vor[0];
    p.dyn = p.vor.reduce((s, v, t) => s + Math.max(0, v) * DISCOUNT ** t, 0);
    p.peak = Math.max(...p.fpy);
  }
  rankBy("dyn", "rDyn");
  rankBy("vor0", "rSeason");
}
function rankBy(key, out) {
  [...P].sort((a, b) => b[key] - a[key]).forEach((p, i) => { p[out] = i + 1; });
}

// ---------------------------------------------------------------- schedule
function localISO(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
function scheduleInfo() {
  const today = new Date();
  const days = [...Array(7)].map((_, i) => localISO(new Date(today.getTime() + i * 86400000)));
  const todayGames = {}, week = {};
  for (const [i, day] of days.entries()) {
    for (const [a, h] of DATA.schedule[day] || []) {
      week[a] = (week[a] || 0) + 1; week[h] = (week[h] || 0) + 1;
      if (i === 0) { todayGames[a] = "@" + h; todayGames[h] = "vs " + a; }
    }
  }
  return { todayGames, week, hasSchedule: Object.keys(week).length > 0 };
}

// ------------------------------------------------------------------ render
function filtered() {
  const q = S.q.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return P.filter((p) => {
    if (S.pos !== "ALL" && !(S.pos === "G" ? p.grp === "G" : p.p.includes(S.pos))) return false;
    if (S.who === "mine" && !mine.has(p.id)) return false;
    if (S.who === "free" && (taken.has(p.id) || mine.has(p.id))) return false;
    if (S.agemax && p.age && p.age > S.agemax) return false;
    if (q && !p.key.includes(q)) return false;
    return true;
  });
}

function spark(p) {
  const max = SPARK_MAX;
  const w = 60, h = 18, bw = w / p.fpy.length;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">${p.fpy
    .map((v, i) => {
      const bh = Math.max(1, (Math.max(0, v) / max) * h);
      const cls = p.vor[i] > 0 ? "pos" : "neg";
      return `<rect class="${cls}" x="${i * bw + 1}" y="${h - bh}" width="${bw - 2}" height="${bh}"/>`;
    })
    .join("")}</svg>`;
}

function playerCell(p) {
  const pos = p.grp === "G" ? "G" : p.p.join("/");
  return `<td class="name"><button class="plink" data-id="${p.id}">${esc(p.n)}</button>
    <span class="meta">${esc(p.t || "—")} · <span class="pos pos-${p.grp}">${pos}</span></span></td>`;
}
function marks(p) {
  return `<td class="marks"><button class="star ${mine.has(p.id) ? "on" : ""}" data-star="${p.id}" title="Mon équipe" aria-label="Mon équipe">${mine.has(p.id) ? "★" : "☆"}</button><button class="take ${taken.has(p.id) ? "on" : ""}" data-take="${p.id}" title="Pris par une autre équipe" aria-label="Pris">✕</button></td>`;
}

const COLS = {
  dynasty: [
    ["rDyn", "#", (p) => p.rDyn],
    [null, "", null, marks],
    ["n", "Joueur", null, playerCell],
    ["dyn", "Valeur dynasty", (p) => `<b>${fmt(p.dyn)}</b>`],
    ["age", "Âge", (p) => fmt(p.age, 1)],
    [null, "6 saisons", null, (p) => `<td>${spark(p)}</td>`],
    ["fp0", "Pts 26-27", (p) => fmt(p.fpy[0])],
    ["vor0", "VOR 26-27", (p) => fmt(p.vor0), null, true],
    ["peak", "Pic proj.", (p) => fmt(p.peak)],
  ],
  season: [
    ["rSeason", "#", (p) => p.rSeason],
    [null, "", null, marks],
    ["n", "Joueur", null, playerCell],
    ["vor0", "VOR", (p) => `<b>${fmt(p.vor0)}</b>`, null, true],
    ["fp0", "Pts", (p) => fmt(p.fpy[0])],
    ["rate", "Pts/M", (p) => fmt(p.rate, 2)],
    ["gp", "PJ", (p) => fmt(p.gp)],
    ["age", "Âge", (p) => fmt(p.age, 1)],
  ],
  daily: [
    [null, "", null, marks],
    ["n", "Joueur", null, playerCell],
    ["week", "Proj. 7 j", (p) => `<b>${fmt(p.proj7, 1)}</b>`],
    ["today", "Auj.", (p) => p.today || "—"],
    ["g7", "Matchs 7 j", (p) => fmt(p.g7)],
    ["rate", "Pts/M proj.", (p) => fmt(p.rate, 2)],
    ["l14pg", "Pts/M 14 j", (p) => fmt(p.l14pg, 2)],
    ["curpg", "Pts/M saison", (p) => fmt(p.curpg, 2)],
    ["curfp", "Pts saison", (p) => fmt(p.cur?.[1])],
  ],
};
const SK_COLS = [["g", "B"], ["a1", "A1"], ["a2", "A2"], ["sog", "TIR"], ["hit", "MEÉ"], ["blk", "BLQ"], ["tk", "TK"]];
const GO_COLS = [["w", "V"], ["otw", "VP"], ["otl", "DP"], ["sv", "ARR"], ["ga", "BA"], ["so", "BL"]];

function sortVal(p, key) {
  switch (key) {
    case "n": return p.n;
    case "fp0": return p.fpy[0];
    case "curfp": return p.cur ? p.cur[1] : -1e9;
    case "today": return p.today ? 1 : 0;
    case "week": return p.proj7 ?? -1e9;
    default:
      if (key.startsWith("s.")) return p.s[key.slice(2)] ?? -1e9;
      return p[key] ?? -1e9;
  }
}

function render() {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === S.view));
  const isMethod = S.view === "method";
  $("#controls").hidden = isMethod;
  $(".tablewrap").hidden = isMethod;
  $("#hint").hidden = isMethod;
  $("#summary").hidden = isMethod;
  $("#method").hidden = !isMethod;
  if (isMethod) return renderMethod();

  let cols = COLS[S.view];
  if (S.view === "season") {
    const extra = (S.pos === "G" ? GO_COLS : SK_COLS).map(([k, l]) => ["s." + k, l, (p) => fmt(p.s[k])]);
    cols = cols.concat(extra);
  }
  if (S.view === "daily") {
    const sch = scheduleInfo();
    for (const p of P) {
      p.today = sch.todayGames[p.t];
      p.g7 = sch.hasSchedule ? sch.week[p.t] || 0 : null;
      const share = p.grp === "G" ? Math.min(1, p.gp / 82) : Math.min(1, p.gp / 76);
      p.proj7 = p.g7 == null ? null : p.rate * p.g7 * share;
      p.curpg = p.cur && p.cur[0] ? p.cur[1] / p.cur[0] : null;
      p.l14pg = p.l14 && p.l14[0] ? p.l14[1] / p.l14[0] : null;
    }
  }
  const [key, dir] = S.sort[S.view];
  const rows = filtered().sort((a, b) => {
    const va = sortVal(a, key), vb = sortVal(b, key);
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  });

  $("#tbl thead").innerHTML = "<tr>" + cols.map(([k, l]) =>
    k ? `<th data-sort="${k}" class="${k === key ? "sorted" : ""}${k === "n" ? " lft" : ""}">${l}${k === key ? (dir < 0 ? " ▾" : " ▴") : ""}</th>` : `<th>${l}</th>`).join("") + "</tr>";
  const html = rows.slice(0, S.limit).map((p) => {
    const cls = [mine.has(p.id) ? "mine" : "", taken.has(p.id) ? "taken" : ""].join(" ");
    return `<tr class="${cls}">` + cols.map(([, , fn, cell, signed]) => {
      if (cell) return cell(p);
      const v = fn(p);
      const neg = signed && parseFloat(v) < 0 ? " class=\"neg\"" : "";
      return `<td${neg}>${v}</td>`;
    }).join("") + "</tr>";
  }).join("");
  const more = rows.length > S.limit ? `<tr><td colspan="${cols.length}" class="more"><button id="more">Afficher plus (${rows.length - S.limit} restants)</button></td></tr>` : "";
  $("#tbl tbody").innerHTML = html + more || `<tr><td colspan="${cols.length}" class="empty">Aucun joueur ne correspond aux filtres.</td></tr>`;

  const sch = S.view === "daily" ? scheduleInfo() : null;
  let sum = `Remplacement (${S.teams} équipes) : C ${fmt(REPL.C)} · W ${fmt(REPL.W)} · D ${fmt(REPL.D)} · G ${fmt(REPL.G)} pts · seuil SKT ${fmt(SKT_BASE)} pts`;
  if (sch && !sch.hasSchedule) sum += " · Calendrier pas encore disponible";
  if (S.view === "daily" && !P.some((p) => p.cur)) sum += " · La saison n'est pas commencée : les colonnes réelles se rempliront dès le premier match.";
  $("#summary").textContent = sum;
}

function renderMethod() {
  const r = DATA.rates || {};
  $("#method").innerHTML = `
  <h2>Comment le classement est calculé</h2>
  <h3>1. Projections</h3>
  <p>Les projections de base (matchs joués, buts, passes, tirs, mises en échec, blocs, et pour les gardiens victoires, arrêts, % d'arrêts et blanchissages) viennent du même modèle d'apprentissage automatique que <a href="https://samuellachance.github.io/fantasy-hockey-vor/">fantasy-hockey-vor</a>.</p>
  <p>Ce que ce modèle ne projette pas est estimé à partir des deux dernières saisons de chaque joueur, ramenées vers la moyenne de sa position :</p>
  <ul>
    <li>Passes primaires et secondaires : part de passes primaires du joueur (moyenne LNH : ${fmt((r.a1F || 0) * 100)} % chez les attaquants, ${fmt((r.a1D || 0) * 100)} % chez les D).</li>
    <li>Revirements provoqués (D) : taux par match du joueur.</li>
    <li>Tours du chapeau : probabilité de Poisson de marquer 3 buts selon ses buts par match.</li>
    <li>Points en prolongation : part de la production qui arrive en prolongation dans la LNH (${fmt((r.otShare || 0) * 100, 1)} %).</li>
    <li>Blanchissages (D) : taux de blanchissages de son équipe.</li>
    <li>Gardiens : buts accordés tirés des arrêts et du % d'arrêts; victoires et défaites en prolongation/TB selon la part des matchs qui vont en prolongation (${fmt((r.otGameShare || 0) * 100)} %).</li>
  </ul>
  <h3>2. Points Fantrax</h3>
  <p>Barème de la ligue : B 3, tour du chapeau 2, A1 2,4, A2 1,6, point en prol. 0,5, tir 0,4, MEÉ 0,3; pour les D seulement : bloc 0,3, revirement 0,35, blanchissage 2. Gardiens : V 3, V en prol. 2, D en prol. 1, BA −1,5, arrêt 0,27, blanchissage 3, but 3, passe 2.</p>
  <h3>3. VOR (valeur au-dessus du remplacement)</h3>
  <p>Même idée que le site d'origine, adaptée aux points : on remplit l'alignement partant de chaque équipe (3 C, 5 W, 3 D, 1 F, 1 SKT, 2 G) avec les meilleurs joueurs. Le niveau de remplacement d'une position est le meilleur joueur qui reste. VOR = points projetés − remplacement. Change le nombre d'équipes en haut et tout se recalcule.</p>
  <p><b>Bonus SKT :</b> chaque équipe met son meilleur patineur dans la case SKT (+50 %). Un patineur reçoit donc +50 % de ses points au-dessus du seuil SKT (le ${S.teams}e meilleur patineur), ce qui fait monter les vedettes.</p>
  <h3>4. Ajustement dynasty à l'âge</h3>
  <p>Pour les 5 saisons suivantes, le rythme de points par match est multiplié par une courbe de vieillissement (sommet vers 26-27 ans pour les attaquants, 27-28 pour les D, 29-30 pour les gardiens), avec un petit bonus de développement jusqu'à 23 ans pour les choix de 1re ronde. Les jeunes qui jouent peu aujourd'hui montent à une charge complète en deux ans. Aucun joueur n'est projeté au-dessus du meilleur rythme actuel à sa position. La production tombe à zéro à 42 ans.</p>
  <p><b>Valeur dynasty</b> = somme des VOR positifs des 6 saisons, chaque saison future comptant 15 % de moins que la précédente (1, 0,85, 0,72…). Pas de plafond salarial dans cette ligue, donc les contrats n'entrent pas en compte.</p>
  <h3>5. Au jour le jour</h3>
  <p>Chaque matin, le site va chercher les stats de la saison et des 14 derniers jours. Le rythme projeté mélange la projection et la production réelle (la projection compte pour 25 matchs). « Proj. 7 j » = rythme × matchs de l'équipe dans les 7 prochains jours. Les points réels sont une estimation (≈) : les tours du chapeau, les points en prolongation et les blanchissages des D sont approximés.</p>
  <p class="small">Données générées ${esc(DATA.generatedAt)} · projections de base du ${esc((DATA.baseGeneratedAt || "").slice(0, 10))}.</p>`;
}

function openDetail(id) {
  const p = BY_ID.get(id);
  if (!p) return;
  const lab = p.grp === "G" ? GO_LABEL : SK_LABEL;
  const w = p.grp === "G" ? DATA.scoring.goalie : DATA.scoring.skater;
  const rows = Object.keys(lab).filter((k) => k in p.s && (p.grp !== "F" || !["blk", "tk", "sho"].includes(k)))
    .map((k) => `<tr><td>${lab[k]}</td><td>${fmt(p.s[k], p.s[k] < 10 ? 1 : 0)}</td><td>${fmt(p.s[k] * w[k], 1)}</td></tr>`).join("");
  const years = p.fpy.map((fp, i) => `<tr><td>${2026 + i}-${String(27 + i).padStart(2, "0")}</td><td>${p.a0 ? fmt(p.a0 + i, 0) : "—"}</td><td>${fmt(fp)}</td><td class="${p.vor[i] < 0 ? "neg" : ""}">${fmt(p.vor[i])}</td></tr>`).join("");
  const cur = p.cur ? `<p>Saison en cours : ${p.cur[0]} PJ, ≈${fmt(p.cur[1])} pts (${fmt(p.cur[1] / Math.max(1, p.cur[0]), 2)}/match)${p.l14 ? ` · 14 derniers jours : ${p.l14[0]} PJ, ≈${fmt(p.l14[1])} pts` : ""}.</p>` : "";
  $("#detailBody").innerHTML = `
    <h2>${esc(p.n)}</h2>
    <p class="meta">${esc(p.t || "—")} · ${p.grp === "G" ? "G" : p.p.join("/")} · ${p.age ? fmt(p.age, 1) + " ans" : "âge inconnu"}${p.dp ? ` · repêché ${p.dp}e` : ""}</p>
    <p><b>#${p.rDyn}</b> dynasty · <b>#${p.rSeason}</b> cette saison · valeur dynasty ${fmt(p.dyn)} · VOR ${fmt(p.vor0)} (position ${p.vpos})</p>
    ${cur}
    <h3>Projection 2026-27 (${fmt(p.gp)} PJ)</h3>
    <table class="mini"><thead><tr><th>Catégorie</th><th>Proj.</th><th>Pts</th></tr></thead><tbody>${rows}
    <tr class="tot"><td>Total</td><td></td><td>${fmt(p.fp, 1)}</td></tr></tbody></table>
    <h3>Trajectoire dynasty</h3>
    <table class="mini"><thead><tr><th>Saison</th><th>Âge</th><th>Pts</th><th>VOR</th></tr></thead><tbody>${years}</tbody></table>`;
  $("#detail").showModal();
}

// ------------------------------------------------------------------ events
function bind() {
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    S.view = b.dataset.view; S.limit = PAGE; store.set("view", S.view); render();
  }));
  $("#q").addEventListener("input", (e) => { S.q = e.target.value; S.limit = PAGE; render(); });
  $("#pos").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.pos = b.dataset.pos; S.limit = PAGE;
    document.querySelectorAll("#pos button").forEach((x) => x.classList.toggle("on", x === b));
    render();
  });
  $("#who").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.who = b.dataset.who; S.limit = PAGE;
    document.querySelectorAll("#who button").forEach((x) => x.classList.toggle("on", x === b));
    render();
  });
  $("#teams").addEventListener("change", (e) => {
    const n = Math.max(6, Math.min(32, parseInt(e.target.value, 10) || 12));
    e.target.value = n; S.teams = n; store.set("teams", n); computeValues(); render();
  });
  $("#agemax").addEventListener("input", (e) => { S.agemax = parseFloat(e.target.value) || null; render(); });
  $("#tbl").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const k = th.dataset.sort, cur = S.sort[S.view];
      S.sort[S.view] = [k, cur[0] === k ? -cur[1] : (k === "n" || k === "age" || k.startsWith("r") ? 1 : -1)];
      return render();
    }
    const star = e.target.closest("[data-star]");
    if (star) { toggle(mine, "mine", +star.dataset.star); return render(); }
    const take = e.target.closest("[data-take]");
    if (take) { toggle(taken, "taken", +take.dataset.take); return render(); }
    const link = e.target.closest(".plink");
    if (link) return openDetail(+link.dataset.id);
    if (e.target.id === "more") { S.limit += PAGE; render(); }
  });
}
function toggle(set, key, id) {
  set.has(id) ? set.delete(id) : set.add(id);
  store.set(key, [...set]);
}

// -------------------------------------------------------------------- boot
fetch("data.json", { cache: "no-cache" }).then((r) => r.json()).then((d) => {
  DATA = d; P = d.players;
  SPARK_MAX = Math.max(1, ...P.map((p) => Math.max(...p.fpy)));
  for (const p of P) {
    p.key = (p.n + " " + p.t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    BY_ID.set(p.id, p);
  }
  if (!store.get("mine", null)) {
    const names = new Set(DEFAULT_MINE);
    mine = new Set(P.filter((p) => names.has(p.n)).map((p) => p.id));
    store.set("mine", [...mine]);
  }
  const v = store.get("view", "dynasty");
  if (["dynasty", "season", "daily", "method"].includes(v)) S.view = v;
  $("#teams").value = S.teams;
  const when = new Date(d.generatedAt);
  $("#updated").textContent = "mis à jour " + when.toLocaleDateString("fr-CA", { day: "numeric", month: "long" }) + " " + when.toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" });
  computeValues(); bind(); render();
}).catch((err) => {
  $("#summary").textContent = "Impossible de charger les données : " + err.message;
});
