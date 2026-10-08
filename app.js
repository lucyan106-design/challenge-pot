(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const r2 = (n) => Math.round(Number(n) * 100) / 100;
  const gbp = (n) => { const v = r2(n); return (v < 0 ? "-£" : "£") + (Number.isInteger(v) ? Math.abs(v).toString() : Math.abs(v).toFixed(2)); };
  const fmtDate = (d) => { if (!d) return "fără termen"; try { return new Date(d + "T12:00:00").toLocaleDateString("ro-RO", { day: "numeric", month: "short" }); } catch { return d; } };
  const fmtTime = (t) => { try { const d = new Date(t); const today = new Date().toDateString() === d.toDateString(); return d.toLocaleString("ro-RO", today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  const toast = (msg) => { const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); };
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  const errText = (e) => {
    const m = (e && (e.message || e.error_description)) || "";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Nu e conexiune la internet. Încearcă din nou.";
    if (/Invalid login credentials/i.test(m)) return "Email sau parolă greșite.";
    if (/already registered|already been registered/i.test(m)) return "Există deja un cont cu acest email. Alege „Am cont”.";
    if (/Password should be at least/i.test(m)) return "Parola trebuie să aibă minim 6 caractere.";
    if (/valid email|invalid format|Unable to validate email/i.test(m)) return "Adresa de email nu pare corectă.";
    if (/rate limit|too many/i.test(m)) return "Prea multe încercări. Așteaptă un minut.";
    if (/Email not confirmed/i.test(m)) return "Contul nu e confirmat. Spune-i lui Lucian.";
    if (/JWT|token/i.test(m)) return "Sesiunea a expirat. Intră din nou.";
    return m || "N-a mers. Încearcă din nou.";
  };

  const cfg = window.CHALLENGE_POT_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase) {
    $("loading").innerHTML = '<div class="hero"><h1>Challenge <em>Pot</em></h1></div><div class="empty"><strong>Aplicația nu e configurată</strong>Lipsesc datele de conectare la baza de date.</div>';
    return;
  }
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  const S = {
    session: null, me: null,
    groups: [],          // [{id,name,nick,is_admin}]
    gid: null,           // current group id
    members: {}, challenges: [], payments: [], proofs: {}, votes: {}, messages: [], photoUrls: {},
    tab: "list", openId: null, kind: "duel", stake: 10, mode: "login", channel: null, loaded: false, busy: false
  };
  const STATUS = { open: "Se strâng mizele", active: "În desfășurare", voting: "La vot", settled: "Închis", cancelled: "Anulat" };
  const curGroup = () => S.groups.find(g => g.id === S.gid) || null;

  // ---------- views ----------
  const VIEWS = ["loading", "authView", "startView", "tabList", "tabNew", "tabLedger"];
  function show(view) {
    VIEWS.forEach(v => { $(v).hidden = v !== view; });
    const inGroup = ["tabList", "tabNew", "tabLedger"].includes(view);
    $("nav").hidden = !inGroup;
    $("meBtn").hidden = !inGroup;
    $("grpBtn").hidden = !inGroup;
  }
  function go(tab) {
    S.tab = tab;
    show({ list: "tabList", new: "tabNew", ledger: "tabLedger" }[tab]);
    document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-current", b.dataset.tab === tab ? "page" : "false"));
    window.scrollTo(0, 0);
  }

  // ---------- people ----------
  const nameOf = (id) => id === S.me ? "Tu" : ((S.members[id] && S.members[id].nick) || "Fost membru");
  const colorOf = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 45% 42%)`; };
  const face = (id, cls = "av sm") => {
    const n = (S.members[id] && S.members[id].nick) || "?";
    return `<span class="${cls}" style="background:${colorOf(id)}" aria-hidden="true">${esc(n.trim().charAt(0) || "?")}</span>`;
  };

  // ---------- settlement math ----------
  function transfersFor(c) {
    const out = [];
    if (c.status !== "settled" || !c.result) return out;
    const stake = Number(c.stake) || 0;
    if (c.kind === "personal") {
      for (const b of (c.backers || [])) {
        if (c.result.success) out.push({ from: b, to: c.creator, amount: stake });
        else out.push({ from: c.creator, to: b, amount: stake });
      }
    } else {
      const winners = c.result.winners || [];
      if (!winners.length) return out;
      const losers = (c.participants || []).filter(p => !winners.includes(p));
      for (const l of losers) for (const w of winners) out.push({ from: l, to: w, amount: stake / winners.length });
    }
    return out;
  }
  function balances() {
    const bal = {};
    const add = (id, v) => { bal[id] = (bal[id] || 0) + v; };
    for (const c of S.challenges) for (const t of transfersFor(c)) { add(t.from, -t.amount); add(t.to, t.amount); }
    for (const p of S.payments) { add(p.from_id, Number(p.amount)); add(p.to_id, -Number(p.amount)); }
    return bal;
  }
  function simplify(bal) {
    const debt = [], cred = [];
    for (const [id, v] of Object.entries(bal)) { const r = r2(v); if (r < 0) debt.push([id, -r]); else if (r > 0) cred.push([id, r]); }
    debt.sort((a, b) => b[1] - a[1]); cred.sort((a, b) => b[1] - a[1]);
    const out = []; let i = 0, j = 0;
    while (i < debt.length && j < cred.length) {
      const a = r2(Math.min(debt[i][1], cred[j][1]));
      if (a > 0) out.push({ from: debt[i][0], to: cred[j][0], amount: a });
      debt[i][1] = r2(debt[i][1] - a); cred[j][1] = r2(cred[j][1] - a);
      if (debt[i][1] <= 0) i++; if (cred[j][1] <= 0) j++;
    }
    return out;
  }
  window.__cpMath = { transfersFor, balances, simplify, S };

  // ---------- data ----------
  async function rpc(name, args, okMsg) {
    if (S.busy) return { ok: false };
    S.busy = true;
    try {
      const { data, error } = await sb.rpc(name, args);
      if (error) throw error;
      if (okMsg) toast(okMsg);
      await loadAll();
      return { ok: true, data };
    } catch (e) { toast(errText(e)); return { ok: false, error: e }; }
    finally { S.busy = false; }
  }

  async function loadGroups() {
    const [mine, groups] = await Promise.all([
      sb.from("group_members").select("group_id,nick,is_admin").eq("user_id", S.me),
      sb.from("groups").select("id,name").order("created_at", { ascending: true })
    ]);
    const err = mine.error || groups.error;
    if (err) throw err;
    const byId = {}; (groups.data || []).forEach(g => { byId[g.id] = g; });
    S.groups = (mine.data || []).filter(m => byId[m.group_id])
      .map(m => ({ id: m.group_id, name: byId[m.group_id].name, nick: m.nick, is_admin: m.is_admin }))
      .sort((a, b) => a.name.localeCompare(b.name, "ro"));
    if (!S.groups.some(g => g.id === S.gid)) {
      const saved = store.get("cp-group-" + S.me);
      S.gid = (S.groups.find(g => g.id === saved) || S.groups[0] || {}).id || null;
    }
  }

  let loadSeq = 0;
  async function loadAll() {
    const seq = ++loadSeq;
    try { await loadGroups(); } catch (e) { banner(errText(e)); return; }
    if (seq !== loadSeq) return;
    if (!S.gid) { S.loaded = true; renderStart(); return; }
    const gid = S.gid;
    const [m, c, p] = await Promise.all([
      sb.from("group_members").select("user_id,nick,is_admin").eq("group_id", gid),
      sb.from("challenges").select("*").eq("group_id", gid).order("created_at", { ascending: false }),
      sb.from("payments").select("*").eq("group_id", gid).order("created_at", { ascending: false })
    ]);
    if (seq !== loadSeq || gid !== S.gid) return;
    const err = m.error || c.error || p.error;
    if (err) { banner(errText(err)); return; }
    clearBanner();
    S.members = {}; (m.data || []).forEach(r => { S.members[r.user_id] = r; });
    S.challenges = c.data || []; S.payments = p.data || [];
    await signPhotos(S.challenges.map(x => x.photo_path));
    if (S.openId) await loadDetail(S.openId);
    S.loaded = true;
    renderAll();
  }
  async function signPhotos(paths) {
    const need = [...new Set(paths.filter(x => x && !S.photoUrls[x]))];
    if (!need.length) return;
    try {
      const { data } = await sb.storage.from("proofs").createSignedUrls(need, 60 * 60 * 6);
      (data || []).forEach(d => { if (d.signedUrl) S.photoUrls[d.path] = d.signedUrl; });
    } catch {}
  }
  async function loadDetail(id) {
    const c = S.challenges.find(x => x.id === id);
    const isPlayer = c ? playersOf(c).includes(S.me) : false;
    const [p, v, msg] = await Promise.all([
      sb.from("proofs").select("*").eq("challenge_id", id),
      sb.from("votes").select("*").eq("challenge_id", id),
      isPlayer ? sb.from("challenge_messages").select("*").eq("challenge_id", id).order("created_at", { ascending: true }) : Promise.resolve({ data: [] })
    ]);
    if (S.openId !== id) return;
    S.proofs = {}; (p.data || []).forEach(r => { S.proofs[r.user_id] = r; });
    S.votes = {}; (v.data || []).forEach(r => { S.votes[r.voter_id] = r; });
    S.messages = msg.data || [];
    await signPhotos(Object.values(S.proofs).map(r => r.photo_path));
  }

  let reloadTimer = null;
  function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { loadAll().catch(() => {}); }, 250); }
  function subscribe() {
    if (S.channel) return;
    let ch = sb.channel("pot");
    for (const t of ["groups", "group_members", "challenges", "proofs", "votes", "payments", "challenge_messages"]) {
      ch = ch.on("postgres_changes", { event: "*", schema: "public", table: t }, scheduleReload);
    }
    S.channel = ch.subscribe();
  }
  function unsubscribe() { if (S.channel) { sb.removeChannel(S.channel); S.channel = null; } }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.me) scheduleReload(); });
  window.addEventListener("online", () => { if (S.me) scheduleReload(); });
  window.addEventListener("offline", () => banner("Fără internet. Modificările nu se pot salva acum."));

  let bannerEl = null;
  function banner(msg) { if (!bannerEl) { bannerEl = document.createElement("div"); bannerEl.className = "banner"; bannerEl.setAttribute("role", "alert"); document.body.appendChild(bannerEl); } bannerEl.textContent = msg; }
  function clearBanner() { if (bannerEl) { bannerEl.remove(); bannerEl = null; } }

  // ---------- groups UI ----------
  function groupFormsHtml() { return $("groupFormsTpl").innerHTML; }
  function renderStart() {
    closeSheets();
    if (!$("startForms").children.length) $("startForms").innerHTML = groupFormsHtml();
    show("startView");
  }
  function renderGroupsSheet() {
    $("groupList").innerHTML = S.groups.map(g => `<button class="grow" data-switch="${esc(g.id)}">
      <span class="nm">${esc(g.name)}<span class="sub">tu ești ${esc(g.nick)}${g.is_admin ? " · administrator" : ""}</span></span>
      ${g.id === S.gid ? '<span class="tick" aria-label="grupul curent">✓</span>' : ""}</button>`).join("");
    if (!$("groupForms").children.length) $("groupForms").innerHTML = groupFormsHtml();
  }
  async function switchGroup(id) {
    if (id === S.gid) { closeSheets(); return; }
    S.gid = id; store.set("cp-group-" + S.me, id);
    S.members = {}; S.challenges = []; S.payments = []; S.openId = null;
    closeSheets(); go("list");
    $("listBody").innerHTML = `<p class="muted" style="margin-top:20px">Se încarcă…</p>`;
    renderTop();
    await loadAll();
  }
  async function submitGroupForm(form) {
    const msg = form.querySelector(".formmsg"); msg.textContent = "";
    const btn = form.querySelector("button[type=submit]");
    const f = Object.fromEntries(new FormData(form).entries());
    if (form.dataset.form === "join" && !String(f.code || "").trim()) { msg.textContent = "Scrie codul de invitație."; return; }
    if (form.dataset.form === "create" && !String(f.name || "").trim()) { msg.textContent = "Scrie numele grupului."; return; }
    if (!String(f.nick || "").trim()) { msg.textContent = "Scrie cum te cheamă în grup."; return; }
    btn.disabled = true;
    const { data, error } = form.dataset.form === "join"
      ? await sb.rpc("join_group", { p_code: f.code, p_nick: f.nick })
      : await sb.rpc("create_group", { p_name: f.name, p_nick: f.nick });
    btn.disabled = false;
    if (error) { msg.textContent = errText(error); return; }
    form.reset();
    toast(form.dataset.form === "join" ? "Ai intrat în grup" : "Grup creat. Invită-ți prietenii cu codul.");
    S.gid = data; store.set("cp-group-" + S.me, data);
    S.members = {}; S.challenges = []; S.payments = [];
    closeSheets(); subscribe();
    await loadAll();
    go("list");
    if (form.dataset.form === "create") openAccount();
  }

  // ---------- render: list ----------
  function playersOf(c) { return c.kind === "personal" ? [c.creator, ...(c.backers || [])] : (c.participants || []); }
  function potOf(c) { return c.kind === "personal" ? (c.backers || []).length * Number(c.stake) : (c.participants || []).length * Number(c.stake); }
  function slipHtml(c) {
    const people = playersOf(c);
    const thumb = c.photo_path && S.photoUrls[c.photo_path] ? `<img class="slip-thumb" src="${esc(S.photoUrls[c.photo_path])}" alt="" loading="lazy">` : "";
    return `<button class="slip" data-open="${esc(c.id)}">
      <div class="slip-main">
        <div class="slip-meta"><span class="pill ${esc(c.status)}">${esc(STATUS[c.status] || c.status)}</span><span>${c.kind === "personal" ? "Personală · " + esc(nameOf(c.creator)) : "Unul contra altuia"}</span></div>
        <div class="slip-head">${thumb}<div><div class="slip-title">${esc(c.title)}</div>
        <div class="slip-meta"><span class="faces">${people.slice(0, 6).map(id => face(id)).join("")}</span><span>${people.length} ${people.length === 1 ? "jucător" : "jucători"} · ${c.deadline ? "până pe " + esc(fmtDate(c.deadline)) : "fără termen"}</span></div></div></div>
      </div>
      <div class="slip-stake"><span class="lbl">miză</span><span class="amt">${esc(gbp(c.stake))}</span><span class="lbl">${c.kind === "personal" ? "în joc" : "pot"} ${esc(gbp(potOf(c)))}</span></div>
    </button>`;
  }
  function renderList() {
    const live = S.challenges.filter(c => ["open", "active", "voting"].includes(c.status));
    const done = S.challenges.filter(c => c.status === "settled").slice(0, 20);
    const debts = simplify(balances());
    const owe = debts.filter(d => d.from === S.me).reduce((s, d) => s + d.amount, 0);
    const due = debts.filter(d => d.to === S.me).reduce((s, d) => s + d.amount, 0);
    let h = "";
    if (owe > 0 || due > 0) h += `<div class="debt" style="margin-top:14px"><div class="who">${owe > 0 ? `Ai de dat <span class="amt">${esc(gbp(owe))}</span>` : ""}${due > 0 ? `Ai de primit <span class="amt">${esc(gbp(due))}</span>` : ""}</div><button class="btn sm ghost" data-tab="ledger">Socoteala</button></div>`;
    h += `<h2>Active</h2>`;
    h += live.length ? `<div class="stack">${live.map(slipHtml).join("")}</div>`
      : `<div class="empty"><strong>Niciun challenge activ</strong>Apasă „+ Nou” și lansează prima provocare. Prietenii intră cu miza lor.</div>`;
    if (done.length) h += `<h2>Încheiate</h2><div class="stack">${done.map(slipHtml).join("")}</div>`;
    if (Object.keys(S.members).length < 2) h += `<p class="note" style="margin-top:16px">Ești singur în grup deocamdată. Apasă pe numele tău, sus, ca să vezi codul de invitație.</p>`;
    $("listBody").innerHTML = h;
  }

  // ---------- render: ledger ----------
  function renderLedger() {
    const bal = balances();
    const debts = simplify(bal);
    S._debts = debts;
    let h = `<h2>Cine cui datorează</h2>`;
    h += debts.length ? `<div class="stack">${debts.map((d, i) => `
      <div class="debt"><div class="who">${face(d.from)}<b>${esc(nameOf(d.from))}</b><span class="muted">→</span>${face(d.to)}<b>${esc(nameOf(d.to))}</b></div>
      <span class="amt">${esc(gbp(d.amount))}</span>
      ${(d.from === S.me || d.to === S.me) ? `<button class="btn sm" data-paid="${i}">Marchează plătit</button>` : ""}
      </div>`).join("")}</div>`
      : `<div class="empty"><strong>Toată lumea e la zi</strong>Când se închide un challenge, aici apare cine cui are de dat, deja compensat între voi.</div>`;
    const ids = Object.keys(S.members).sort((a, b) => (bal[b] || 0) - (bal[a] || 0));
    if (ids.length) {
      h += `<h2>Clasament</h2><div class="card">${ids.map(id => { const v = r2(bal[id] || 0); return `<div class="bal">${face(id, "av")}<span class="nm">${esc(nameOf(id))}</span><span class="v ${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${v > 0 ? "+" : ""}${esc(gbp(v))}</span></div>`; }).join("")}</div>
      <p class="note">Clasamentul arată cât ai câștigat sau pierdut net în acest grup, după plățile deja făcute.</p>`;
    }
    const pays = S.payments.slice(0, 20);
    if (pays.length) h += `<h2>Plăți bifate</h2><div class="card">${pays.map(p => `<div class="bal"><span class="nm">${esc(nameOf(p.from_id))} → ${esc(nameOf(p.to_id))} <span class="muted">· ${esc(new Date(p.created_at).toLocaleDateString("ro-RO", { day: "numeric", month: "short" }))}</span></span><span class="v">${esc(gbp(p.amount))}</span>${p.created_by === S.me ? `<button class="linkbtn" data-unpay="${esc(p.id)}">anulează</button>` : ""}</div>`).join("")}</div>`;
    h += `<p class="note" style="margin-top:16px">Datoriile sunt compensate automat: dacă Ana îi datorează lui Mihai £10 și Mihai Anei £4, apare doar £6. Banii se trimit direct, prin transfer bancar; aplicația doar ține evidența.</p>`;
    $("ledgerBody").innerHTML = h;
  }

  // ---------- render: detail ----------
  const eligibleVoters = (c) => { const ids = Object.keys(S.members); return c.kind === "personal" ? ids.filter(i => i !== c.creator) : ids; };
  const votesNeeded = (c) => Math.max(1, Math.ceil(eligibleVoters(c).length / 2));
  const tally = () => { const t = {}; for (const v of Object.values(S.votes)) t[v.pick] = (t[v.pick] || 0) + 1; return t; };

  async function openDetail(id) {
    S.openId = id; S.proofs = {}; S.votes = {}; S.messages = [];
    $("pText").value = ""; $("pPhoto").value = ""; $("chatInput").value = "";
    $("detail").hidden = false; $("detail").scrollTop = 0;
    renderDetail();
    try { await loadDetail(id); } catch {}
    renderDetail(true);
  }
  function closeSheets() { S.openId = null; $("detail").hidden = true; $("account").hidden = true; $("groupsSheet").hidden = true; }

  function renderChat(c, scroll) {
    const isPlayer = playersOf(c).includes(S.me);
    const open = c.status !== "cancelled";
    $("chatBox").hidden = !isPlayer;
    $("chatLocked").hidden = isPlayer;
    if (!isPlayer) return;
    const list = $("chatList");
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.innerHTML = S.messages.length ? S.messages.map(m => `<div class="msg ${m.user_id === S.me ? "mine" : ""}">
        <span class="who">${m.user_id === S.me ? "" : `<b>${esc(nameOf(m.user_id))}</b>`}<span>${esc(fmtTime(m.created_at))}</span></span>
        <span class="bubble">${esc(m.body)}</span></div>`).join("")
      : `<div class="chat-empty">Niciun mesaj încă. Scrie primul.</div>`;
    if (scroll || atBottom) list.scrollTop = list.scrollHeight;
    $("chatForm").hidden = !open;
  }

  function renderDetail(scrollChat) {
    if (!S.openId) return;
    const c = S.challenges.find(x => x.id === S.openId);
    if (!c) { $("detailBody").innerHTML = `<div class="empty" style="margin-top:12px"><strong>Challenge-ul nu mai există</strong></div>`; $("detailActions").innerHTML = ""; $("proofForm").hidden = true; $("chatBox").hidden = true; $("chatLocked").hidden = true; return; }
    const isP = c.kind === "personal";
    const players = playersOf(c);
    const inIt = players.includes(S.me);
    let h = `<span class="pill ${esc(c.status)}">${esc(STATUS[c.status])}</span>
      <h1 class="d-title">${esc(c.title)}</h1>
      ${c.photo_path && S.photoUrls[c.photo_path] ? `<a href="${esc(S.photoUrls[c.photo_path])}" target="_blank" rel="noopener"><img class="cover" src="${esc(S.photoUrls[c.photo_path])}" alt="Poza challenge-ului"></a>` : ""}
      ${c.descr ? `<p style="margin:0 0 12px;white-space:pre-wrap;overflow-wrap:anywhere">${esc(c.descr)}</p>` : ""}
      <div class="card"><dl class="kv">
        <dt>Tip</dt><dd>${isP ? `Personală: ${esc(nameOf(c.creator))} încearcă, ceilalți pariază contra` : "Unul contra altuia, câștigătorul ia potul"}</dd>
        <dt>Miză</dt><dd class="mono">${esc(gbp(c.stake))} de persoană</dd>
        <dt>${isP ? "În joc" : "Pot"}</dt><dd class="mono">${esc(gbp(potOf(c)))}${isP ? ` (${esc(gbp(c.stake))} × ${(c.backers || []).length})` : ""}</dd>
        <dt>Termen</dt><dd>${esc(fmtDate(c.deadline))}</dd>
        <dt>Lansat de</dt><dd>${esc(nameOf(c.creator))}</dd>
      </dl></div>`;

    h += `<h2>${isP ? "Jucători" : "Participanți"}</h2><div class="card">${players.map(id => `<div class="person">${face(id, "av")}<span class="nm">${esc(nameOf(id))}</span><span class="muted" style="font-size:12.5px">${isP ? (id === c.creator ? "încearcă" : "pariază contra") : ""}${S.proofs[id] ? (isP ? " · " : "") + "dovadă trimisă" : ""}</span></div>`).join("") || `<p class="muted" style="margin:0">Nimeni încă.</p>`}</div>`;

    const proofs = Object.entries(S.proofs);
    if (proofs.length) h += `<h2>Dovezi</h2><div class="card">${proofs.map(([id, p]) => `<div class="proof"><div style="display:flex;gap:8px;align-items:center">${face(id)}<b>${esc(nameOf(id))}</b></div>${p.photo_path && S.photoUrls[p.photo_path] ? `<a href="${esc(S.photoUrls[p.photo_path])}" target="_blank" rel="noopener"><img src="${esc(S.photoUrls[p.photo_path])}" alt="Dovada lui ${esc(nameOf(id))}" loading="lazy"></a>` : ""}${p.body ? `<p>${esc(p.body)}</p>` : ""}</div>`).join("")}</div>`;

    if (c.status === "voting") {
      const t = tally(), my = S.votes[S.me] && S.votes[S.me].pick;
      const canVote = eligibleVoters(c).includes(S.me);
      const options = isP ? [["success", `${nameOf(c.creator)} a reușit`], ["fail", "N-a reușit"]]
        : players.filter(p => p !== S.me).map(p => [p, nameOf(p)]);
      const cast = Object.keys(S.votes).length, need = votesNeeded(c);
      h += `<h2>Vot · ${cast} din ${eligibleVoters(c).length}</h2>
        <div class="stack">${options.map(([k, label]) => `<button class="vote" data-vote="${esc(k)}" aria-pressed="${my === k}" ${canVote ? "" : "disabled"}>${!isP ? face(k) : ""}<span class="nm">${esc(label)}</span><span class="cnt">${t[k] || 0}</span></button>`).join("")}</div>
        <p class="note">${isP ? `Votează tot grupul în afară de ${esc(nameOf(c.creator))}.` : "Votează tot grupul; nu poți vota pentru tine."} Votul se poate închide după ${need} ${need === 1 ? "vot" : "voturi"}. Îți poți schimba votul până atunci.</p>`;
    }
    if (c.status === "settled") {
      const tr = transfersFor(c);
      const head = isP ? (c.result.success ? `${nameOf(c.creator)} a reușit` : `${nameOf(c.creator)} n-a reușit`)
        : ((c.result.winners || []).length > 1 ? `Egalitate: ${(c.result.winners || []).map(nameOf).join(", ")}` : `Câștigă: ${(c.result.winners || []).map(nameOf).join(", ")}`);
      h += `<h2>Rezultat</h2><div class="result ${isP && !c.result.success ? "bad" : ""}"><b style="font-size:17px">${esc(head)}</b>
        <div style="margin-top:8px;font-size:14px">${tr.map(x => `${esc(nameOf(x.from))} → ${esc(nameOf(x.to))} <span class="mono">${esc(gbp(x.amount))}</span>`).join("<br>") || "Nimeni nu are nimic de dat."}</div></div>
        <p class="note">Sumele au intrat automat în Socoteala.</p>`;
    }
    if (c.status === "cancelled") h += `<div class="empty" style="margin-top:12px"><strong>Anulat</strong>Nimeni nu datorează nimic.</div>`;
    $("detailBody").innerHTML = h;

    const canProof = c.status === "active" && (isP ? S.me === c.creator : inIt);
    $("proofForm").hidden = !canProof;
    $("pSend").textContent = S.proofs[S.me] ? "Actualizează dovada" : "Trimite dovada";

    const a = [];
    if (c.status === "open") {
      if (!inIt) a.push(`<button class="btn block" data-act="join">${isP ? "Pariez contra" : "Intru"} cu ${esc(gbp(c.stake))}</button>`);
      else if (S.me !== c.creator) a.push(`<button class="btn ghost block" data-act="leave">Ies din challenge</button>`);
      if (S.me === c.creator) {
        const enough = isP ? (c.backers || []).length >= 1 : players.length >= 2;
        a.push(`<button class="btn block" data-act="start" ${enough ? "" : "disabled"}>Pornește challenge-ul</button>`);
        if (!enough) a.push(`<p class="note" style="margin:0">${isP ? "Aștepți cel puțin un prieten care pariază contra." : "Aștepți cel puțin încă un participant."}</p>`);
        a.push(`<button class="btn warn block" data-act="cancel">Anulează challenge-ul</button>`);
      } else {
        a.push(`<p class="note" style="margin:0">${esc(nameOf(c.creator))} pornește challenge-ul când s-au strâns jucătorii.</p>`);
      }
    }
    if (c.status === "active" && inIt) a.push(`<button class="btn ghost block" data-act="vote">Gata, trecem la vot</button>`);
    if (c.status === "voting" && inIt) {
      const cast = Object.keys(S.votes).length, need = votesNeeded(c);
      a.push(`<button class="btn block" data-act="settle" ${cast >= need ? "" : "disabled"}>Închide votul și calculează</button>`);
    }
    $("detailActions").innerHTML = a.join("");
    renderChat(c, scrollChat);
  }

  // ---------- account ----------
  async function openAccount() {
    $("account").hidden = false; renderAccount();
    const { data, error } = await sb.rpc("get_invite_code", { p_group: S.gid });
    $("inviteCode").textContent = error ? "—" : data;
  }
  function renderAccount() {
    const g = curGroup();
    $("accEmail").textContent = (S.session && S.session.user && S.session.user.email) || "";
    $("accTitle").textContent = g ? g.name : "Contul meu";
    if (g && document.activeElement !== $("accNick")) $("accNick").value = g.nick;
    if (g && document.activeElement !== $("grpRename")) $("grpRename").value = g.name;
    $("adminTools").hidden = !(g && g.is_admin);
  }
  function renderTop() {
    const g = curGroup();
    $("grpName").textContent = g ? g.name : "";
    const me = S.members[S.me];
    $("meBtn").innerHTML = me ? `${face(S.me, "av")}<span>${esc(me.nick)}</span>` : "";
  }
  function renderAll() {
    if (!S.me) return;
    if (!S.gid) { renderStart(); return; }
    renderTop(); renderList(); renderLedger(); renderDetail(); renderAccount();
    if (!$("groupsSheet").hidden) renderGroupsSheet();
    if (!$("startView").hidden || !$("loading").hidden || !$("authView").hidden) go(S.tab);
  }

  // ---------- actions ----------
  async function act(kind) {
    const c = S.challenges.find(x => x.id === S.openId); if (!c) return;
    const map = {
      join: ["join_challenge", "Ai intrat. Miza ta: " + gbp(c.stake)], leave: ["leave_challenge", "Ai ieșit."],
      start: ["start_challenge", "Challenge pornit."], cancel: ["cancel_challenge", "Challenge anulat."],
      vote: ["open_voting", "S-a deschis votul."], settle: ["settle_challenge", "Gata. Socoteala e actualizată."]
    };
    if (kind === "cancel" && !confirmInline("cancel")) return;
    const [fn, msg] = map[kind];
    await rpc(fn, { p_id: c.id }, msg);
  }
  let armed = null, armTimer = null;
  function confirmInline(key) {
    if (armed === key) { armed = null; clearTimeout(armTimer); return true; }
    armed = key; toast("Apasă încă o dată ca să confirmi.");
    clearTimeout(armTimer); armTimer = setTimeout(() => { armed = null; }, 4000);
    return false;
  }

  function renderStakeChips() {
    const custom = $("nStake").value.trim();
    $("stakeChips").innerHTML = [5, 10, 20, 50].map(v => `<button type="button" data-stake="${v}" aria-pressed="${!custom && S.stake === v}">£${v}</button>`).join("");
  }

  async function shrinkImage(file) {
    if (!file.type.startsWith("image/") || file.size < 900 * 1024) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
      cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
      const blob = await new Promise(r => cv.toBlob(r, "image/jpeg", 0.85));
      return blob || file;
    } catch { return file; }
  }
  async function uploadPhoto(file, tag) {
    const blob = await shrinkImage(file);
    if (blob.size > 10 * 1024 * 1024) throw new Error("Poza e prea mare (maxim 10 MB).");
    const ext = blob.type === "image/jpeg" ? "jpg" : ((file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg");
    const path = `${S.me}/${tag}-${Date.now()}.${ext}`;
    const up = await sb.storage.from("proofs").upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: false });
    if (up.error) throw new Error(/mime|type/i.test(up.error.message) ? "Formatul pozei nu e acceptat. Folosește JPG sau PNG." : errText(up.error));
    return path;
  }

  // ---------- events ----------
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button"); if (!t || t.disabled) return;
    if (t.dataset.open) openDetail(t.dataset.open);
    else if (t.dataset.tab) { closeSheets(); go(t.dataset.tab); }
    else if (t.dataset.act) act(t.dataset.act);
    else if (t.dataset.close !== undefined) closeSheets();
    else if (t.dataset.switch) switchGroup(t.dataset.switch);
    else if (t.dataset.logout !== undefined) { unsubscribe(); await sb.auth.signOut(); }
    else if (t.dataset.stake) { S.stake = +t.dataset.stake; $("nStake").value = ""; renderStakeChips(); }
    else if (t.dataset.vote) { if (S.openId) await rpc("cast_vote", { p_id: S.openId, p_pick: t.dataset.vote }, "Vot înregistrat"); }
    else if (t.dataset.paid !== undefined) {
      const d = S._debts && S._debts[+t.dataset.paid]; if (!d) return;
      if (!confirmInline("pay" + t.dataset.paid)) return;
      await rpc("record_payment", { p_group: S.gid, p_from: d.from, p_to: d.to, p_amount: d.amount }, "Plată bifată");
    }
    else if (t.dataset.unpay) { if (!confirmInline("unpay" + t.dataset.unpay)) return; await rpc("delete_payment", { p_id: t.dataset.unpay }, "Plată anulată"); }
  });
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault(); submitGroupForm(form);
  });

  $("grpBtn").onclick = () => { $("groupsSheet").hidden = false; renderGroupsSheet(); };
  $("meBtn").onclick = openAccount;
  $("copyInvite").onclick = async () => {
    const g = curGroup();
    const text = `Hai în grupul „${g ? g.name : ""}” pe Challenge Pot: ${location.origin + location.pathname.replace(/index\.html$/, "")}\nFă-ți cont, apoi intră cu codul: ${$("inviteCode").textContent}`;
    try { await navigator.clipboard.writeText(text); toast("Invitația e copiată. Lipește-o pe WhatsApp."); }
    catch { toast("Copiază manual codul de mai sus."); }
  };
  $("newCodeBtn").onclick = async () => {
    if (!confirmInline("newcode")) return;
    const r = await rpc("new_invite_code", { p_group: S.gid }, "Cod nou generat");
    if (r.ok && r.data) $("inviteCode").textContent = r.data;
  };
  $("renameForm").addEventListener("submit", async (e) => { e.preventDefault(); await rpc("rename_group", { p_group: S.gid, p_name: $("grpRename").value }, "Nume salvat"); });
  $("nickForm").addEventListener("submit", async (e) => { e.preventDefault(); await rpc("set_nick", { p_group: S.gid, p_nick: $("accNick").value }, "Nume salvat"); });

  $("kindDuel").onclick = () => { S.kind = "duel"; $("kindDuel").setAttribute("aria-pressed", "true"); $("kindPersonal").setAttribute("aria-pressed", "false"); };
  $("kindPersonal").onclick = () => { S.kind = "personal"; $("kindPersonal").setAttribute("aria-pressed", "true"); $("kindDuel").setAttribute("aria-pressed", "false"); };
  $("nStake").addEventListener("input", renderStakeChips);

  $("newForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("newMsg"); msg.textContent = "";
    const title = $("nTitle").value.trim();
    const raw = $("nStake").value.trim().replace(",", ".").replace(/[£\s]/g, "");
    const stake = raw ? Number(raw) : S.stake;
    if (!title) { msg.textContent = "Scrie ce trebuie făcut."; $("nTitle").focus(); return; }
    if (!Number.isFinite(stake) || stake < 0.5 || stake > 1000) { msg.textContent = "Miza trebuie să fie între £0.50 și £1000."; $("nStake").focus(); return; }
    $("createBtn").disabled = true;
    let photo = null;
    try {
      const file = $("nPhoto").files && $("nPhoto").files[0];
      if (file) { $("createBtn").textContent = "Se încarcă poza…"; photo = await uploadPhoto(file, "challenge"); }
      const r = await rpc("create_challenge", { p_group: S.gid, p_title: title, p_descr: $("nDesc").value.trim(), p_kind: S.kind, p_stake: r2(stake), p_deadline: $("nDeadline").value || null, p_photo_path: photo }, "Challenge lansat");
      if (r.ok) { $("newForm").reset(); S.stake = 10; renderStakeChips(); go("list"); if (r.data) openDetail(r.data); }
      else if (r.error) msg.textContent = errText(r.error);
    } catch (err) { msg.textContent = err.message || errText(err); }
    finally { $("createBtn").disabled = false; $("createBtn").textContent = "Lansează challenge-ul"; }
  });

  $("pSend").onclick = async () => {
    const id = S.openId; if (!id) return;
    const text = $("pText").value.trim();
    const file = $("pPhoto").files && $("pPhoto").files[0];
    if (!text && !file) { toast("Scrie ceva sau adaugă o poză."); return; }
    $("pSend").disabled = true; $("pSend").textContent = file ? "Se încarcă poza…" : "Se trimite…";
    try {
      const path = file ? await uploadPhoto(file, id) : null;
      const r = await rpc("submit_proof", { p_id: id, p_body: text, p_photo_path: path }, "Dovadă trimisă");
      if (r.ok) { $("pText").value = ""; $("pPhoto").value = ""; }
    } catch (e) { toast(e.message || errText(e)); }
    finally { $("pSend").disabled = false; renderDetail(); }
  };

  $("chatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = S.openId; const body = $("chatInput").value.trim();
    if (!id || !body) return;
    $("chatSend").disabled = true;
    const { error } = await sb.rpc("post_message", { p_id: id, p_body: body });
    $("chatSend").disabled = false;
    if (error) { toast(errText(error)); return; }
    $("chatInput").value = "";
    try { await loadDetail(id); } catch {}
    renderDetail(true);
    $("chatInput").focus();
  });

  // ---------- auth ----------
  function setMode(m) {
    S.mode = m;
    $("modeLogin").setAttribute("aria-pressed", String(m === "login"));
    $("modeSignup").setAttribute("aria-pressed", String(m === "signup"));
    $("authBtn").textContent = m === "login" ? "Intră" : "Creează contul";
    $("aPass").setAttribute("autocomplete", m === "login" ? "current-password" : "new-password");
    $("passHint").hidden = m === "login";
    $("authMsg").textContent = "";
  }
  $("modeLogin").onclick = () => setMode("login");
  $("modeSignup").onclick = () => setMode("signup");
  $("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("authMsg"); msg.textContent = "";
    const email = $("aEmail").value.trim(), password = $("aPass").value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = "Adresa de email nu pare corectă."; $("aEmail").focus(); return; }
    if (password.length < 6) { msg.textContent = "Parola trebuie să aibă minim 6 caractere."; $("aPass").focus(); return; }
    $("authBtn").disabled = true;
    try {
      if (S.mode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          const r = await sb.auth.signInWithPassword({ email, password });
          if (r.error) throw new Error(/not confirmed/i.test(r.error.message) ? "Email not confirmed" : "already registered");
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      $("aPass").value = "";
    } catch (err) { msg.textContent = errText(err); }
    finally { $("authBtn").disabled = false; }
  });

  async function onSession(session) {
    S.session = session;
    const uid = session && session.user ? session.user.id : null;
    if (!uid) {
      S.me = null; S.gid = null; S.groups = []; S.members = {}; S.challenges = []; S.payments = []; S.loaded = false;
      unsubscribe(); closeSheets(); show("authView"); return;
    }
    if (uid === S.me && S.loaded) return;
    S.me = uid; S.loaded = false; S.gid = null;
    show("loading");
    try { await loadAll(); } catch (e) { banner(errText(e)); }
    subscribe();
  }
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "TOKEN_REFRESHED") { S.session = session; return; }
    setTimeout(() => onSession(session), 0);
  });

  renderStakeChips();
  setMode("login");
})();
