(() => {
  "use strict";
  const I = window.I18N;
  const t = (k, v) => I.t(k, v);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const r2 = (n) => Math.round(Number(n) * 100) / 100;
  const gbp = (n) => { const v = r2(n); return (v < 0 ? "-£" : "£") + (Number.isInteger(v) ? Math.abs(v).toString() : Math.abs(v).toFixed(2)); };
  const fmtDate = (d) => { if (!d) return t("noDeadline"); try { return new Date(d + "T12:00:00").toLocaleDateString(I.locale, { day: "numeric", month: "short" }); } catch { return d; } };
  const fmtTime = (x) => { try { const d = new Date(x); const today = new Date().toDateString() === d.toDateString(); return d.toLocaleString(I.locale, today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  const fmtStamp = (x) => { try { return new Date(x).toLocaleString(I.locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  const toast = (msg) => { const el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 2600); };
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  const errText = (e) => {
    const m = (e && (e.message || e.error_description)) || "";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return t("err.network");
    if (/Invalid login credentials/i.test(m)) return t("err.login");
    if (/already registered|already been registered/i.test(m)) return t("err.exists");
    if (/Password should be at least/i.test(m)) return t("err.passLen");
    if (/valid email|invalid format|Unable to validate email/i.test(m)) return t("err.email");
    if (/rate limit|too many/i.test(m)) return t("err.rate");
    if (/Email not confirmed/i.test(m)) return t("err.unconfirmed");
    if (/JWT|token/i.test(m)) return t("err.session");
    return I.serverMsg(m) || t("err.generic");
  };

  I.apply();

  const cfg = window.CHALLENGE_POT_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase) {
    $("loading").innerHTML = `<div class="hero"><h1>Challenge <em>Pot</em></h1></div><div class="empty"><strong>${esc(t("err.notConfigured"))}</strong>${esc(t("err.notConfiguredSub"))}</div>`;
    return;
  }
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  const S = {
    session: null, me: null,
    groups: [], gid: null,
    members: {}, challenges: [], payments: [], proofs: [], votes: {}, messages: [], offers: [], invites: [], photoUrls: {}, newInvite: new Set(), addInvite: new Set(),
    tab: "list", month: null, openId: null, kind: "duel", stake: 10, mode: "login", channel: null, loaded: false, busy: false
  };
  const curGroup = () => S.groups.find(g => g.id === S.gid) || null;

  // ---------- views ----------
  const VIEWS = ["loading", "authView", "startView", "tabList", "tabNew", "tabLedger"];
  function show(view) {
    VIEWS.forEach(v => { $(v).hidden = v !== view; });
    const inGroup = ["tabList", "tabNew", "tabLedger"].includes(view);
    $("nav").hidden = !inGroup;
    $("grpBtn").hidden = !inGroup;
    $("langTop").hidden = inGroup;
  }
  function go(tab) {
    S.tab = tab;
    show({ list: "tabList", new: "tabNew", ledger: "tabLedger" }[tab]);
    document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-current", b.dataset.tab === tab ? "page" : "false"));
    if (tab === "new") renderTargets();
    window.scrollTo(0, 0);
  }

  // ---------- people ----------
  const nickOf = (id) => (S.members[id] && S.members[id].nick) || t("nick.formerMember");
  const nameOf = (id) => id === S.me ? t("you") : nickOf(id);
  const colorOf = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 45% 42%)`; };
  const face = (id, cls = "av sm") => {
    const n = (S.members[id] && S.members[id].nick) || "?";
    return `<span class="${cls}" style="background:${colorOf(id)}" aria-hidden="true">${esc(n.trim().charAt(0) || "?")}</span>`;
  };

  // ---------- challenge roles ----------
  const isSolo = (c) => c.kind === "personal" || c.kind === "dare";          // one person does it, others bet against
  const doerOf = (c) => c.kind === "dare" ? c.target : c.creator;
  const targetAccepted = (c) => c.kind === "dare" && (c.participants || []).includes(c.target);
  function playersOf(c) {
    if (c.kind === "duel") return c.participants || [];
    if (c.kind === "dare") return [c.target, ...(c.backers || [])];
    return [c.creator, ...(c.backers || [])];
  }
  const isPlayer = (c, id) => playersOf(c).includes(id);
  function windowEnd(c) {
    if (c.status !== "active" || !c.started_at) return null;
    const start = new Date(c.started_at).getTime();
    if (!c.deadline) return new Date(start + 24 * 3600e3);
    const [y, m, d] = c.deadline.split("-").map(Number);
    const end = Date.UTC(y, m - 1, d + 1);
    return new Date(start + Math.max(0, end - start) * 0.1);
  }
  const canJoinNow = (c) => c.status === "open" || (c.status === "active" && windowEnd(c) && Date.now() <= windowEnd(c).getTime());
  const pendingFor = (cid) => S.invites.filter(r => r.challenge_id === cid);
  const potOf = (c) => isSolo(c) ? (c.backers || []).length * Number(c.stake) : (c.participants || []).length * Number(c.stake);

  // ---------- settlement math ----------
  function transfersFor(c) {
    const out = [];
    if (c.status !== "settled" || !c.result) return out;
    const stake = Number(c.stake) || 0;
    if (isSolo(c)) {
      const doer = doerOf(c);
      for (const b of (c.backers || [])) {
        if (b === doer) continue;
        if (c.result.success) out.push({ from: b, to: doer, amount: stake });
        else out.push({ from: doer, to: b, amount: stake });
      }
    } else {
      const winners = c.result.winners || [];
      if (!winners.length) return out;
      const losers = (c.participants || []).filter(p => !winners.includes(p));
      for (const l of losers) for (const w of winners) out.push({ from: l, to: w, amount: stake / winners.length });
    }
    return out;
  }
  const pad = (n) => String(n).padStart(2, "0");
  const monthKey = (d) => { const x = d ? new Date(d) : new Date(); return x.getFullYear() + "-" + pad(x.getMonth() + 1); };
  const thisMonth = () => monthKey();
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const monthLabel = (k) => { const [y, m] = k.split("-").map(Number); return cap(new Date(y, m - 1, 15).toLocaleDateString(I.locale, { month: "long", year: "numeric" })); };
  const monthShort = (k) => { const [y, m] = k.split("-").map(Number); const s = new Date(y, m - 1, 15).toLocaleDateString(I.locale, { month: "short" }).replace(".", ""); return cap(s) + (y !== new Date().getFullYear() ? " " + y : ""); };
  const challengeMonth = (c) => c.settled_at ? monthKey(c.settled_at) : null;
  const paymentMonth = (p) => /^\d{4}-\d{2}/.test(String(p.period || "")) ? String(p.period).slice(0, 7) : monthKey(p.created_at);
  function balances(month) {
    const bal = {};
    const add = (id, v) => { bal[id] = (bal[id] || 0) + v; };
    for (const c of S.challenges) { if (month && challengeMonth(c) !== month) continue; for (const x of transfersFor(c)) { add(x.from, -x.amount); add(x.to, x.amount); } }
    for (const p of S.payments) { if (month && paymentMonth(p) !== month) continue; add(p.from_id, Number(p.amount)); add(p.to_id, -Number(p.amount)); }
    return bal;
  }
  // every month from the group's first activity up to now (newest first)
  function ledgerMonths() {
    const keys = [thisMonth()];
    Object.values(S.members).forEach(m => m.joined_at && keys.push(monthKey(m.joined_at)));
    S.challenges.forEach(c => { keys.push(monthKey(c.created_at)); const k = challengeMonth(c); if (k) keys.push(k); });
    S.payments.forEach(p => keys.push(paymentMonth(p)));
    const first = keys.sort()[0], out = [];
    let [y, m] = thisMonth().split("-").map(Number);
    while (true) { const k = y + "-" + pad(m); out.push(k); if (k <= first || out.length > 120) break; m--; if (!m) { m = 12; y--; } }
    return out;
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
  function allDebts() { return ledgerMonths().flatMap(k => simplify(balances(k)).map(d => ({ ...d, month: k }))); }
  window.__cpMath = { transfersFor, simplify, S };

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
      .sort((a, b) => a.name.localeCompare(b.name, I.locale));
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
    const [m, c, p, iv] = await Promise.all([
      sb.from("group_members").select("user_id,nick,is_admin,joined_at").eq("group_id", gid),
      sb.from("challenges").select("*").eq("group_id", gid).order("created_at", { ascending: false }),
      sb.from("payments").select("*").eq("group_id", gid).order("created_at", { ascending: false }),
      sb.from("challenge_invites").select("*").eq("status", "pending").order("created_at", { ascending: true })
    ]);
    if (seq !== loadSeq || gid !== S.gid) return;
    const err = m.error || c.error || p.error;
    if (err) { banner(errText(err)); return; }
    clearBanner();
    S.members = {}; (m.data || []).forEach(r => { S.members[r.user_id] = r; });
    S.challenges = (c.data || []).map(x => x.target ? { ...x, kind: "dare" } : x);   // "challenge a friend" = personal + target
    S.payments = p.data || [];
    const ids = new Set(S.challenges.map(x => x.id));
    S.invites = (iv && !iv.error ? iv.data || [] : []).filter(r => ids.has(r.challenge_id));
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
    const player = c ? isPlayer(c, S.me) : false;
    const [p, v, msg, off] = await Promise.all([
      sb.from("proof_log").select("*").eq("challenge_id", id),
      sb.from("votes").select("*").eq("challenge_id", id),
      player ? sb.from("challenge_messages").select("*").eq("challenge_id", id).order("created_at", { ascending: true }) : Promise.resolve({ data: [] }),
      sb.from("challenge_offers").select("*").eq("challenge_id", id).order("created_at", { ascending: true })
    ]);
    if (S.openId !== id) return;
    S.proofs = (p.data || []).slice().sort((a, b) => String(b.created_at || b.updated_at).localeCompare(String(a.created_at || a.updated_at)));
    S.votes = {}; (v.data || []).forEach(r => { S.votes[r.voter_id] = r; });
    S.messages = msg.data || [];
    S.offers = off.data || [];
    await signPhotos(S.proofs.map(r => r.photo_path));
  }

  let reloadTimer = null;
  function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { loadAll().catch(() => {}); }, 250); }
  function subscribe() {
    if (S.channel) return;
    let ch = sb.channel("pot");
    for (const tb of ["groups", "group_members", "challenges", "proof_log", "votes", "payments", "challenge_messages", "challenge_offers", "challenge_invites"]) {
      ch = ch.on("postgres_changes", { event: "*", schema: "public", table: tb }, scheduleReload);
    }
    S.channel = ch.subscribe();
  }
  function unsubscribe() { if (S.channel) { sb.removeChannel(S.channel); S.channel = null; } }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.me) scheduleReload(); });
  window.addEventListener("online", () => { if (S.me) scheduleReload(); });
  window.addEventListener("offline", () => banner(t("offline")));

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
  function groupListHtml() {
    return S.groups.map(g => `<button class="grow" data-switch="${esc(g.id)}">
      <span class="nm">${esc(g.name)}<span class="sub">${esc(t("groups.youAre", { nick: g.nick }))}${g.is_admin ? esc(t("groups.admin")) : ""}</span></span>
      ${g.id === S.gid ? `<span class="tick" aria-label="${esc(t("groups.current"))}">✓</span>` : ""}</button>`).join("");
  }
  async function switchGroup(id) {
    if (id === S.gid) { closeSheets(); return; }
    S.gid = id; store.set("cp-group-" + S.me, id);
    S.members = {}; S.challenges = []; S.payments = []; S.openId = null; S.month = null;
    closeSheets(); go("list");
    $("listBody").innerHTML = `<p class="muted" style="margin-top:20px">${esc(t("loading"))}</p>`;
    renderTop();
    await loadAll();
  }
  async function submitGroupForm(form) {
    const msg = form.querySelector(".formmsg"); msg.textContent = "";
    const btn = form.querySelector("button[type=submit]");
    const f = Object.fromEntries(new FormData(form).entries());
    if (form.dataset.form === "join" && !String(f.code || "").trim()) { msg.textContent = t("start.needCode"); return; }
    if (form.dataset.form === "create" && !String(f.name || "").trim()) { msg.textContent = t("start.needName"); return; }
    if (!String(f.nick || "").trim()) { msg.textContent = t("start.needNick"); return; }
    btn.disabled = true;
    const { data, error } = form.dataset.form === "join"
      ? await sb.rpc("join_group", { p_code: f.code, p_nick: f.nick })
      : await sb.rpc("create_group", { p_name: f.name, p_nick: f.nick });
    btn.disabled = false;
    if (error) { msg.textContent = errText(error); return; }
    form.reset();
    toast(form.dataset.form === "join" ? t("toast.joinedGroup") : t("toast.groupCreated"));
    S.gid = data; store.set("cp-group-" + S.me, data);
    S.members = {}; S.challenges = []; S.payments = []; S.month = null;
    closeSheets(); subscribe();
    await loadAll();
    go("list");
    if (form.dataset.form === "create") openAccount();
  }

  // ---------- render: list ----------
  function kindLine(c) {
    if (c.kind === "personal") return t("slip.personal", { name: nameOf(c.creator) });
    if (c.kind === "dare") return c.creator === S.me ? t("slip.dareMe", { target: nameOf(c.target) }) : c.target === S.me ? t("slip.dareYou", { name: nameOf(c.creator) }) : t("slip.dare", { name: nameOf(c.creator), target: nameOf(c.target) });
    return t("slip.duel");
  }
  function slipHtml(c) {
    const people = playersOf(c);
    const thumb = c.photo_path && S.photoUrls[c.photo_path] ? `<img class="slip-thumb" src="${esc(S.photoUrls[c.photo_path])}" alt="" loading="lazy">` : "";
    const n = people.length;
    return `<button class="slip" data-open="${esc(c.id)}">
      <div class="slip-main">
        <div class="slip-meta"><span class="pill ${esc(c.status)}">${esc(t("status." + c.status))}</span><span>${esc(kindLine(c))}</span></div>
        <div class="slip-head">${thumb}<div><div class="slip-title">${esc(c.title)}</div>
        <div class="slip-meta"><span class="faces">${people.slice(0, 6).map(id => face(id)).join("")}</span><span>${esc(t(n === 1 ? "slip.players1" : "slip.playersN", { n }))} · ${esc(c.deadline ? t("slip.until", { date: fmtDate(c.deadline) }) : t("noDeadline"))}</span></div></div></div>
      </div>
      <div class="slip-stake"><span class="lbl">${esc(t("slip.stake"))}</span><span class="amt">${esc(gbp(c.stake))}</span><span class="lbl">${esc(t(isSolo(c) ? "slip.atStake" : "slip.pot"))} ${esc(gbp(potOf(c)))}</span></div>
    </button>`;
  }
  function renderList() {
    const live = S.challenges.filter(c => ["open", "active", "voting"].includes(c.status));
    const done = S.challenges.filter(c => c.status === "settled").slice(0, 20);
    const debts = allDebts();
    const owe = debts.filter(d => d.from === S.me).reduce((s, d) => s + d.amount, 0);
    const due = debts.filter(d => d.to === S.me).reduce((s, d) => s + d.amount, 0);
    const amt = (v) => `<span class="amt">${esc(gbp(v))}</span>`;
    let h = "";
    if (owe > 0 || due > 0) h += `<div class="debt" style="margin-top:14px"><div class="who">${owe > 0 ? esc(t("list.owe", { amt: "§" })).replace("§", amt(owe)) : ""}${due > 0 ? esc(t("list.due", { amt: "§" })).replace("§", amt(due)) : ""}</div><button class="btn sm ghost" data-tab="ledger">${esc(t("list.ledger"))}</button></div>`;
    const forYou = [];
    S.challenges.forEach(c => {
      if (!["open", "active"].includes(c.status)) return;
      const myInv = S.invites.find(r => r.challenge_id === c.id && r.user_id === S.me && r.kind === "invite");
      const reqs = c.creator === S.me ? S.invites.filter(r => r.challenge_id === c.id && r.kind === "request").length : 0;
      let why = "";
      if (c.kind === "dare" && c.target === S.me && c.status === "open" && !targetAccepted(c)) why = t("list.dared", { name: nameOf(c.creator) });
      else if (myInv) why = t("list.invited", { name: nameOf(myInv.created_by) });
      else if (reqs) why = t(reqs === 1 ? "list.req1" : "list.reqN", { n: reqs });
      if (why) forYou.push([c, why]);
    });
    if (forYou.length) h += `<h2>${esc(t("list.forYou"))}</h2><div class="stack">${forYou.map(([c, why]) => `<div class="foryou"><span class="pill open">${esc(why)}</span>${slipHtml(c)}</div>`).join("")}</div>`;
    h += `<h2>${esc(t("list.active"))}</h2>`;
    h += live.length ? `<div class="stack">${live.map(slipHtml).join("")}</div>`
      : `<div class="empty"><strong>${esc(t("list.emptyT"))}</strong>${esc(t("list.emptyS"))}</div>`;
    if (done.length) h += `<h2>${esc(t("list.closed"))}</h2><div class="stack">${done.map(slipHtml).join("")}</div>`;
    if (Object.keys(S.members).length < 2) h += `<p class="note" style="margin-top:16px">${esc(t("list.alone"))}</p>`;
    $("listBody").innerHTML = h;
  }

  // ---------- render: ledger (per month) ----------
  function renderLedger() {
    const months = ledgerMonths();
    if (!S.month || !months.includes(S.month)) S.month = thisMonth();
    const M = S.month, cur = thisMonth(), ML = monthLabel(M), MLi = I.lang === "ro" ? ML.toLowerCase() : ML;
    const debts = simplify(balances(M));
    S._debts = debts;
    let h = "";
    const old = months.filter(k => k < cur).map(k => ({ k, d: simplify(balances(k)) })).filter(x => x.d.length);
    if (old.length) h += `<div class="result bad" style="margin-top:14px"><b>${esc(t("ledger.oldUnpaid"))}</b>${old.map(x => `<div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span style="flex:1;min-width:0">${esc(monthLabel(x.k))}: ${x.d.map(d => `${esc(nameOf(d.from))} → ${esc(nameOf(d.to))} <span class="mono">${esc(gbp(d.amount))}</span>`).join(", ")}</span><button class="btn sm ghost" data-month="${esc(x.k)}">${esc(t("ledger.seeMonth"))}</button></div>`).join("")}</div>`;
    const idx = months.indexOf(M), older = months[idx + 1], newer = months[idx - 1];
    h += `<div class="monthnav" role="group">
      <button type="button" class="mnav" ${older ? `data-month="${esc(older)}"` : "disabled"} aria-label="${esc(t("ledger.prev"))}">‹</button>
      <div class="mname"><b>${esc(ML)}</b>${M === cur ? `<span>${esc(t("month.this"))}</span>` : ""}</div>
      <button type="button" class="mnav" ${newer ? `data-month="${esc(newer)}"` : "disabled"} aria-label="${esc(t("ledger.next"))}">›</button>
    </div>`;
    {
      const wonM = {};
      S.challenges.forEach(c => { if (challengeMonth(c) !== M) return; transfersFor(c).forEach(x => { wonM[x.from] = (wonM[x.from] || 0) - x.amount; wonM[x.to] = (wonM[x.to] || 0) + x.amount; }); });
      const best = Object.entries(wonM).map(([id, v]) => [id, r2(v)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      const top = best.length ? best.filter(([, v]) => v === best[0][1]) : [];
      h += top.length
        ? `<div class="winner"><span class="lbl">${esc(t("ledger.winner"))}</span><div class="wrow">${top.map(([id]) => `${face(id, "av")}<b>${esc(nameOf(id))}</b>`).join("")}<span class="amt">+${esc(gbp(top[0][1]))}</span></div></div>`
        : `<div class="winner none"><span class="lbl">${esc(t("ledger.winner"))}</span><div class="wrow muted">${esc(M === cur ? t("ledger.noWinner") : t("ledger.noWinnerOld", { month: MLi }))}</div></div>`;
    }
    h += `<h2>${esc(t("ledger.whoOwes", { month: ML }))}</h2>`;
    h += debts.length ? `<div class="stack">${debts.map((d, i) => `
      <div class="debt"><div class="who">${face(d.from)}<b>${esc(nameOf(d.from))}</b><span class="muted">→</span>${face(d.to)}<b>${esc(nameOf(d.to))}</b></div>
      <span class="amt">${esc(gbp(d.amount))}</span>
      ${(d.from === S.me || d.to === S.me) ? `<button class="btn sm" data-paid="${i}">${esc(t("ledger.markPaid"))}</button>` : ""}
      </div>`).join("")}</div>
      <p class="note">${esc(M === cur ? t("ledger.noteNow") : t("ledger.noteOld", { month: MLi }))}</p>`
      : `<div class="empty"><strong>${esc(M === cur ? t("ledger.emptyNowT") : t("ledger.emptyOldT"))}</strong>${esc(M === cur ? t("ledger.emptyNowS") : t("ledger.emptyOldS", { month: MLi }))}</div>`;
    const ids = Object.keys(S.members);
    const won = {};
    S.challenges.forEach(c => { if (challengeMonth(c) !== M) return; transfersFor(c).forEach(x => { won[x.from] = (won[x.from] || 0) - x.amount; won[x.to] = (won[x.to] || 0) + x.amount; }); });
    ids.sort((a, b) => (won[b] || 0) - (won[a] || 0));
    if (ids.length) {
      h += `<h2>${esc(t("ledger.rank", { month: ML }))}</h2><div class="card">${ids.map(id => { const v = r2(won[id] || 0); return `<div class="bal">${face(id, "av")}<span class="nm">${esc(nameOf(id))}</span><span class="v ${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${v > 0 ? "+" : ""}${esc(gbp(v))}</span></div>`; }).join("")}</div>
      <p class="note">${esc(t("ledger.rankNote", { month: MLi }))}</p>`;
    }
    const pays = S.payments.filter(p => paymentMonth(p) === M).slice(0, 30);
    if (pays.length) h += `<h2>${esc(t("ledger.paid", { month: ML }))}</h2><div class="card">${pays.map(p => `<div class="bal"><span class="nm">${esc(nameOf(p.from_id))} → ${esc(nameOf(p.to_id))} <span class="muted">· ${esc(new Date(p.created_at).toLocaleDateString(I.locale, { day: "numeric", month: "short" }))}</span></span><span class="v">${esc(gbp(p.amount))}</span>${p.created_by === S.me ? `<button class="linkbtn" data-unpay="${esc(p.id)}">${esc(t("ledger.undo"))}</button>` : ""}</div>`).join("")}</div>`;
    h += `<p class="note" style="margin-top:16px">${esc(t("ledger.netting"))}</p>`;
    $("ledgerBody").innerHTML = h;
  }

  // ---------- render: detail ----------
  const eligibleVoters = (c) => { const ids = Object.keys(S.members); return isSolo(c) ? ids.filter(i => i !== doerOf(c)) : ids; };
  const votesNeeded = (c) => Math.max(1, Math.ceil(eligibleVoters(c).length / 2));
  const tally = () => { const r = {}; for (const v of Object.values(S.votes)) r[v.pick] = (r[v.pick] || 0) + 1; return r; };

  async function openDetail(id) {
    S.openId = id; S.proofs = []; S.votes = {}; S.messages = []; S.offers = [];
    $("pText").value = ""; $("pPhoto").value = ""; $("chatInput").value = "";
    $("offerForm").hidden = true; $("oMsg").textContent = ""; $("inviteForm").hidden = true; S.addInvite = new Set();
    $("detail").hidden = false; $("detail").scrollTop = 0;
    renderDetail();
    try { await loadDetail(id); } catch {}
    renderDetail(true);
  }
  function closeSheets() { S.openId = null; $("detail").hidden = true; $("account").hidden = true; }

  function renderChat(c, scroll) {
    const player = isPlayer(c, S.me);
    $("chatBox").hidden = !player;
    $("chatLocked").hidden = player;
    if (!player) return;
    const list = $("chatList");
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.innerHTML = S.messages.length ? S.messages.map(m => `<div class="msg ${m.user_id === S.me ? "mine" : ""}">
        <span class="who">${m.user_id === S.me ? "" : `<b>${esc(nameOf(m.user_id))}</b>`}<span>${esc(fmtTime(m.created_at))}</span></span>
        <span class="bubble">${esc(m.body)}</span></div>`).join("")
      : `<div class="chat-empty">${esc(t("chat.empty"))}</div>`;
    if (scroll || atBottom) list.scrollTop = list.scrollHeight;
    $("chatForm").hidden = c.status === "cancelled";
  }

  function renderDetail(scrollChat) {
    if (!S.openId) return;
    const c = S.challenges.find(x => x.id === S.openId);
    if (!c) { $("detailBody").innerHTML = `<div class="empty" style="margin-top:12px"><strong>${esc(t("d.goneT"))}</strong></div>`; $("detailActions").innerHTML = ""; $("proofForm").hidden = true; $("chatBox").hidden = true; $("chatLocked").hidden = true; $("offerBox").hidden = true; return; }
    const solo = isSolo(c), dare = c.kind === "dare";
    const doer = doerOf(c);
    const players = playersOf(c);
    const inIt = players.includes(S.me);
    const typeText = c.kind === "personal" ? (c.creator === S.me ? t("d.typePersonalMe") : t("d.typePersonal", { name: nameOf(c.creator) }))
      : dare ? (c.creator === S.me ? t("d.typeDareMe", { target: nameOf(c.target) }) : c.target === S.me ? t("d.typeDareYou", { name: nameOf(c.creator) }) : t("d.typeDare", { name: nameOf(c.creator), target: nameOf(c.target) }))
      : t("d.typeDuel");
    const acc = S.offers.filter(o => o.status === "accepted").pop();
    let h = `<span class="pill ${esc(c.status)}">${esc(t("status." + c.status))}</span>
      <h1 class="d-title">${esc(c.title)}</h1>
      ${c.photo_path && S.photoUrls[c.photo_path] ? `<a href="${esc(S.photoUrls[c.photo_path])}" target="_blank" rel="noopener"><img class="cover" src="${esc(S.photoUrls[c.photo_path])}" alt="${esc(t("d.coverAlt"))}"></a>` : ""}
      ${c.descr ? `<p style="margin:0 0 12px;white-space:pre-wrap;overflow-wrap:anywhere">${esc(c.descr)}</p>` : ""}
      ${acc ? `<p class="note" style="margin:0 0 12px">${esc(t("d.termsChanged", { name: nameOf(acc.proposer) }))}${c.status === "open" ? esc(t("d.rejoin")) : ""}</p>` : ""}
      <div class="card"><dl class="kv">
        <dt>${esc(t("d.type"))}</dt><dd>${esc(typeText)}</dd>
        <dt>${esc(t("d.stake"))}</dt><dd class="mono">${esc(t("d.perPerson", { amt: gbp(c.stake) }))}</dd>
        <dt>${esc(t(solo ? "d.atStake" : "d.pot"))}</dt><dd class="mono">${esc(gbp(potOf(c)))}${solo ? ` (${esc(gbp(c.stake))} × ${(c.backers || []).length})` : ""}</dd>
        <dt>${esc(t("d.deadline"))}</dt><dd>${esc(fmtDate(c.deadline))}</dd>
        <dt>${esc(t("d.by"))}</dt><dd>${esc(nameOf(c.creator))}</dd>
      </dl></div>`;

    const roleOf = (id) => {
      if (!solo) return "";
      if (id === doer) return dare ? `${t("d.challenged")} · ${targetAccepted(c) ? t("d.accepted") : t("d.notAnswered")}` : t("d.tries");
      return t("d.betsAgainst");
    };
    h += `<h2>${esc(t(solo ? "d.players" : "d.participants"))}</h2><div class="card">${players.map(id => `<div class="person">${face(id, "av")}<span class="nm">${esc(nameOf(id))}</span><span class="muted" style="font-size:12.5px">${esc(roleOf(id))}${(() => { const n = S.proofs.filter(p => p.user_id === id).length; return n ? esc((solo || dare ? " · " : "") + t(n === 1 ? "d.proofs1" : "d.proofsN", { n })) : ""; })()}</span></div>`).join("") || `<p class="muted" style="margin:0">${esc(t("d.nobody"))}</p>`}</div>`;

    if (S.proofs.length) h += `<h2>${esc(t("d.proofs"))} · ${S.proofs.length}</h2><div class="card">${S.proofs.map(p => { const id = p.user_id; return `<div class="proof"><div class="proof-head">${face(id)}<b>${esc(nameOf(id))}</b><time class="stamp" datetime="${esc(p.created_at || p.updated_at)}">${esc(fmtStamp(p.created_at || p.updated_at))}</time></div>${p.photo_path && S.photoUrls[p.photo_path] ? `<a href="${esc(S.photoUrls[p.photo_path])}" target="_blank" rel="noopener"><img src="${esc(S.photoUrls[p.photo_path])}" alt="${esc(t("d.proofAlt", { name: nameOf(id) }))}" loading="lazy"></a>` : ""}${p.body ? `<p>${esc(p.body)}</p>` : ""}</div>`; }).join("")}</div>`;

    if (c.status === "voting") {
      const tl = tally(), my = S.votes[S.me] && S.votes[S.me].pick;
      const canVote = eligibleVoters(c).includes(S.me);
      const options = solo ? [["success", t("d.voteSuccess", { name: nameOf(doer) })], ["fail", t("d.voteFail")]]
        : players.filter(p => p !== S.me).map(p => [p, nameOf(p)]);
      const cast = Object.keys(S.votes).length, need = votesNeeded(c);
      h += `<h2>${esc(t("d.vote", { cast, total: eligibleVoters(c).length }))}</h2>
        <div class="stack">${options.map(([k, label]) => `<button class="vote" data-vote="${esc(k)}" aria-pressed="${my === k}" ${canVote ? "" : "disabled"}>${!solo ? face(k) : ""}<span class="nm">${esc(label)}</span><span class="cnt">${tl[k] || 0}</span></button>`).join("")}</div>
        <p class="note">${esc(solo ? t("d.voteNotePersonal", { name: nameOf(doer) }) : t("d.voteNoteDuel"))}${esc(t(need === 1 ? "d.voteClose1" : "d.voteCloseN", { n: need }))}</p>`;
    }
    if (c.status === "settled") {
      const tr = transfersFor(c);
      const winners = (c.result.winners || []).map(nameOf).join(", ");
      const head = solo ? (doer === S.me ? t(c.result.success ? "d.didItMe" : "d.didntMe") : t(c.result.success ? "d.didIt" : "d.didnt", { name: nameOf(doer) }))
        : t((c.result.winners || []).length > 1 ? "d.tie" : "d.wins", { names: winners });
      h += `<h2>${esc(t("d.result"))}</h2><div class="result ${solo && !c.result.success ? "bad" : ""}"><b style="font-size:17px">${esc(head)}</b>
        <div style="margin-top:8px;font-size:14px">${tr.map(x => `${esc(nameOf(x.from))} → ${esc(nameOf(x.to))} <span class="mono">${esc(gbp(x.amount))}</span>`).join("<br>") || esc(t("d.nobodyPays"))}</div></div>
        <p class="note">${esc(t("d.inLedger", { month: monthLabel(challengeMonth(c) || thisMonth()) }))}</p>`;
    }
    if (c.status === "cancelled") h += `<div class="empty" style="margin-top:12px"><strong>${esc(t("d.cancelledT"))}</strong>${esc(t("d.cancelledS"))}</div>`;
    $("detailBody").innerHTML = h;

    const canProof = c.status === "active" && (solo ? S.me === doer : inIt);
    $("proofForm").hidden = !canProof;
    $("pSend").textContent = t("proof.send");

    const a = [];
    if (c.status === "open") {
      if (dare && S.me === c.target) {
        if (!targetAccepted(c)) {
          a.push(`<p class="note" style="margin:0">${esc(t("d.dareYou", { name: nameOf(c.creator) }))}</p>`);
          a.push(`<button class="btn block" data-act="join">${esc(t("d.acceptDare"))}</button>`);
        } else {
          a.push(`<p class="note" style="margin:0">${esc(t("d.creatorStarts", { name: nameOf(c.creator) }))}</p>`);
        }
        a.push(`<button class="btn warn block" data-act="decline">${esc(t("d.declineDare"))}</button>`);
      } else if (S.me === c.creator) {
        if (c.kind === "duel" && !inIt) a.push(`<button class="btn block" data-act="join">${esc(t("d.join", { amt: gbp(c.stake) }))}</button>`);
        const enough = c.kind === "personal" ? (c.backers || []).length >= 1 : dare ? targetAccepted(c) : players.length >= 2;
        a.push(`<button class="btn block" data-act="start" ${enough ? "" : "disabled"}>${esc(t("d.start"))}</button>`);
        if (!enough) a.push(`<p class="note" style="margin:0">${esc(c.kind === "personal" ? t("d.waitBacker") : dare ? t("d.waitTarget", { name: nameOf(c.target) }) : t("d.waitPlayer"))}</p>`);
        a.push(`<button class="btn warn block" data-act="cancel">${esc(t("d.cancel"))}</button>`);
      } else {
        if (!inIt) a.push(`<button class="btn block" data-act="join">${esc(t(solo ? "d.betAgainst" : "d.join", { amt: gbp(c.stake) }))}</button>`);
        else a.push(`<button class="btn ghost block" data-act="leave">${esc(t("d.leave"))}</button>`);
        a.push(`<p class="note" style="margin:0">${esc(dare && !targetAccepted(c) ? t("d.waitTarget", { name: nameOf(c.target) }) : t("d.creatorStarts", { name: nameOf(c.creator) }))}</p>`);
      }
    }
    if (c.status === "active" && inIt) a.push(`<button class="btn ghost block" data-act="vote">${esc(t("d.toVote"))}</button>`);
    if (c.status === "voting" && inIt) {
      const cast = Object.keys(S.votes).length, need = votesNeeded(c);
      a.push(`<button class="btn block" data-act="settle" ${cast >= need ? "" : "disabled"}>${esc(t("d.settle"))}</button>`);
    }
    $("detailActions").innerHTML = a.join("");
    renderInvites(c);
    renderOffers(c);
    renderChat(c, scrollChat);
  }

  // ---------- invites & join requests ----------
  function inviteCandidates(c) {
    const pend = new Set(pendingFor(c.id).map(r => r.user_id));
    return Object.values(S.members).filter(m => m.user_id !== S.me && !isPlayer(c, m.user_id) && !(c.kind === "dare" && m.user_id === c.target) && !pend.has(m.user_id));
  }
  function chipsHtml(list, set, attr) {
    return list.map(m => `<button type="button" ${attr}="${esc(m.user_id)}" aria-pressed="${set.has(m.user_id)}">${esc(m.nick)}</button>`).join("");
  }
  function renderInvites(c) {
    const pend = pendingFor(c.id);
    const joinable = canJoinNow(c) && ["open", "active"].includes(c.status);
    const player = isPlayer(c, S.me) || c.creator === S.me;
    const myPending = pend.find(r => r.user_id === S.me);
    const cands = inviteCandidates(c);
    const canInvite = joinable && player && cands.length > 0;
    const canRequest = c.status === "active" && joinable && !player && !myPending && !(c.kind === "dare" && c.target === S.me);
    $("inviteBox").hidden = !(pend.length || canInvite || canRequest);
    if ($("inviteBox").hidden) { $("inviteForm").hidden = true; return; }
    const we = windowEnd(c);
    $("windowNote").textContent = c.status === "active" && we ? t("inv.window", { when: fmtStamp(we) }) : c.status === "open" ? t("inv.openNote") : "";
    $("inviteList").innerHTML = pend.map(r => {
      let line, btns = "";
      if (r.kind === "invite") {
        line = r.user_id === S.me ? t("inv.invitedYou", { by: nameOf(r.created_by) }) : r.created_by === S.me ? t("inv.youInvited", { name: nameOf(r.user_id) }) : t("inv.invitedBy", { by: nameOf(r.created_by), name: nameOf(r.user_id) });
        if (r.user_id === S.me) btns = `<div class="btns"><button class="btn sm" data-join-accept="${esc(r.id)}">${esc(t("inv.accept"))}</button><button class="btn sm ghost" data-join-decline="${esc(r.id)}">${esc(t("inv.decline"))}</button></div>`;
        else if (r.created_by === S.me) btns = `<div class="btns"><button class="btn sm ghost" data-join-cancel="${esc(r.id)}">${esc(t("inv.withdraw"))}</button></div><span class="state">${esc(t("inv.waitUser", { name: nameOf(r.user_id) }))}</span>`;
        else btns = `<span class="state">${esc(t("inv.waitUser", { name: nameOf(r.user_id) }))}</span>`;
      } else {
        line = t("inv.asks", { name: nameOf(r.user_id) });
        if (c.creator === S.me) btns = `<div class="btns"><button class="btn sm" data-join-accept="${esc(r.id)}">${esc(t("inv.accept"))}</button><button class="btn sm ghost" data-join-decline="${esc(r.id)}">${esc(t("inv.decline"))}</button></div>`;
        else if (r.created_by === S.me) btns = `<div class="btns"><button class="btn sm ghost" data-join-cancel="${esc(r.id)}">${esc(t("inv.withdraw"))}</button></div><span class="state">${esc(t("inv.waitCreator", { name: nameOf(c.creator) }))}</span>`;
        else btns = `<span class="state">${esc(t("inv.waitCreator", { name: nameOf(c.creator) }))}</span>`;
      }
      return `<div class="offer pending"><div class="head">${face(r.user_id)}${esc(line)}</div>${btns}</div>`;
    }).join("");
    $("inviteToggle").hidden = !canInvite || !$("inviteForm").hidden;
    $("requestBtn").hidden = !canRequest;
    if (!canInvite) $("inviteForm").hidden = true;
    else if (!$("inviteForm").hidden) $("inviteFormChips").innerHTML = chipsHtml(cands, S.addInvite, "data-add-inv");
  }

  // ---------- counter-offers ----------
  function renderOffers(c) {
    const open = c.status === "open";
    const pending = S.offers.filter(o => o.status === "pending");
    const decided = S.offers.filter(o => o.status === "accepted" || o.status === "rejected");
    const canPropose = open && c.creator !== S.me;
    $("offerBox").hidden = !(canPropose || pending.length || (open && decided.length));
    if ($("offerBox").hidden) return;
    const terms = (o) => `<dl class="terms">
        ${o.descr != null ? `<dt>${esc(t("o.rules"))}</dt><dd>${c.descr && o.status === "pending" ? `<span class="was">${esc(c.descr)}</span>` : ""}${esc(o.descr)}</dd>` : ""}
        ${o.stake != null ? `<dt>${esc(t("o.stake"))}</dt><dd class="mono">${o.status === "pending" ? `<span class="was">${esc(gbp(c.stake))}</span>` : ""}${esc(t("d.perPerson", { amt: gbp(o.stake) }))}</dd>` : ""}
      </dl>`;
    const items = pending.map(o => {
      let btns;
      if (open && c.creator === S.me) btns = `<div class="btns"><button class="btn sm" data-offer-accept="${esc(o.id)}">${esc(t("o.accept"))}</button><button class="btn sm ghost" data-offer-reject="${esc(o.id)}">${esc(t("o.reject"))}</button></div>
        <span class="state">${esc(t("o.acceptNote"))}</span>`;
      else if (o.proposer === S.me) btns = `<div class="btns"><button class="btn sm ghost" data-offer-withdraw="${esc(o.id)}">${esc(t("o.withdraw"))}</button></div><span class="state">${esc(t("o.waiting", { name: nameOf(c.creator) }))}</span>`;
      else btns = `<span class="state">${esc(t("o.waiting", { name: nameOf(c.creator) }))}</span>`;
      return `<div class="offer pending"><div class="head">${face(o.proposer)}${esc(o.proposer === S.me ? t("o.youPropose") : t("o.proposes", { name: nameOf(o.proposer) }))}</div>${terms(o)}${btns}</div>`;
    });
    const history = decided.slice(-3).map(o => `<div class="offer"><div class="head">${face(o.proposer)}${esc(nameOf(o.proposer))}</div>${terms(o)}<span class="state">${esc(t(o.status === "accepted" ? "o.accepted" : "o.rejected"))}</span></div>`);
    $("offerList").innerHTML = items.concat(history).join("");
    $("offerList").hidden = !items.length && !history.length;
    $("offerToggle").hidden = !canPropose || !$("offerForm").hidden;
    if (!canPropose) $("offerForm").hidden = true;
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
    $("inviteTitle").textContent = t("invite.titleTo", { group: g ? g.name : "" });
    if (g && document.activeElement !== $("accNick")) $("accNick").value = g.nick;
    if (g && document.activeElement !== $("grpRename")) $("grpRename").value = g.name;
    $("adminTools").hidden = !(g && g.is_admin);
    $("accGroupList").innerHTML = groupListHtml();
    if (!$("accGroupForms").children.length) $("accGroupForms").innerHTML = groupFormsHtml();
  }
  function renderTop() {
    const g = curGroup();
    $("grpName").textContent = g ? g.name : "";
  }
  function renderAll() {
    if (!S.me) return;
    if (!S.gid) { renderStart(); return; }
    renderTop(); renderList(); renderLedger(); renderDetail(); renderAccount(); renderTargets();
    if (!$("startView").hidden || !$("loading").hidden || !$("authView").hidden) go(S.tab);
  }

  // ---------- new challenge form ----------
  function setKind(k) {
    S.kind = k;
    document.querySelectorAll("[data-kind]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.kind === k)));
    $("targetField").hidden = k !== "dare";
    renderTargets();
  }
  function renderTargets() {
    const sel = $("nTarget"); const keep = sel.value;
    const others = Object.values(S.members).filter(m => m.user_id !== S.me).sort((a, b) => a.nick.localeCompare(b.nick, I.locale));
    sel.innerHTML = others.length
      ? `<option value="">${esc(t("new.targetPick"))}</option>` + others.map(m => `<option value="${esc(m.user_id)}">${esc(m.nick)}</option>`).join("")
      : `<option value="">${esc(t("new.noFriends"))}</option>`;
    if (others.some(m => m.user_id === keep)) sel.value = keep;
    renderNewInvites();
  }
  function renderNewInvites() {
    const others = Object.values(S.members).filter(m => m.user_id !== S.me && !(S.kind === "dare" && m.user_id === $("nTarget").value))
      .sort((a, b) => a.nick.localeCompare(b.nick, I.locale));
    for (const id of [...S.newInvite]) if (!others.some(m => m.user_id === id)) S.newInvite.delete(id);
    $("inviteField").hidden = !others.length;
    $("inviteChips").innerHTML = chipsHtml(others, S.newInvite, "data-new-inv");
  }
  function renderStakeChips() {
    const custom = $("nStake").value.trim();
    $("stakeChips").innerHTML = [5, 10, 20, 50].map(v => `<button type="button" data-stake="${v}" aria-pressed="${!custom && S.stake === v}">£${v}</button>`).join("");
  }

  // ---------- actions ----------
  async function act(kind) {
    const c = S.challenges.find(x => x.id === S.openId); if (!c) return;
    const dareTarget = c.kind === "dare" && c.target === S.me;
    const map = {
      join: ["join_challenge", dareTarget ? t("toast.acceptedDare") : t("toast.joinedCh", { amt: gbp(c.stake) })],
      leave: ["leave_challenge", t("toast.left")],
      start: ["start_challenge", t("toast.started")], cancel: ["cancel_challenge", t("toast.cancelled")],
      decline: ["cancel_challenge", t("toast.declinedDare")],
      vote: ["open_voting", t("toast.voteOpen")], settle: ["settle_challenge", t("toast.settled")]
    };
    if ((kind === "cancel" || kind === "decline") && !confirmInline(kind)) return;
    const [fn, msg] = map[kind];
    await rpc(fn, { p_id: c.id }, msg);
  }
  let armed = null, armTimer = null;
  function confirmInline(key) {
    if (armed === key) { armed = null; clearTimeout(armTimer); return true; }
    armed = key; toast(t("toast.confirm"));
    clearTimeout(armTimer); armTimer = setTimeout(() => { armed = null; }, 4000);
    return false;
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
    if (blob.size > 10 * 1024 * 1024) throw new Error(t("photo.tooBig"));
    const ext = blob.type === "image/jpeg" ? "jpg" : ((file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg");
    const path = `${S.me}/${tag}-${Date.now()}.${ext}`;
    const up = await sb.storage.from("proofs").upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: false });
    if (up.error) throw new Error(/mime|type/i.test(up.error.message) ? t("photo.badType") : errText(up.error));
    return path;
  }

  // ---------- events ----------
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    if (b.dataset.lang) { I.setLang(b.dataset.lang); return; }
    if (b.dataset.open) openDetail(b.dataset.open);
    else if (b.dataset.tab) { closeSheets(); go(b.dataset.tab); }
    else if (b.dataset.act) act(b.dataset.act);
    else if (b.dataset.close !== undefined) closeSheets();
    else if (b.dataset.switch) switchGroup(b.dataset.switch);
    else if (b.dataset.kind) setKind(b.dataset.kind);
    else if (b.dataset.logout !== undefined) { unsubscribe(); await sb.auth.signOut(); }
    else if (b.dataset.month) { S.month = b.dataset.month; renderLedger(); window.scrollTo(0, 0); }
    else if (b.dataset.stake) { S.stake = +b.dataset.stake; $("nStake").value = ""; renderStakeChips(); }
    else if (b.dataset.vote) { if (S.openId) await rpc("cast_vote", { p_id: S.openId, p_pick: b.dataset.vote }, t("toast.voted")); }
    else if (b.dataset.paid !== undefined) {
      const d = S._debts && S._debts[+b.dataset.paid]; if (!d) return;
      if (!confirmInline("pay" + b.dataset.paid)) return;
      await rpc("record_payment", { p_group: S.gid, p_period: S.month + "-01", p_from: d.from, p_to: d.to, p_amount: d.amount }, t("toast.paid"));
    }
    else if (b.dataset.offerAccept) { if (!confirmInline("acc" + b.dataset.offerAccept)) return; await rpc("respond_counter", { p_offer: b.dataset.offerAccept, p_accept: true }, t("toast.offerAccepted")); }
    else if (b.dataset.offerReject) { await rpc("respond_counter", { p_offer: b.dataset.offerReject, p_accept: false }, t("toast.offerRejected")); }
    else if (b.dataset.offerWithdraw) { await rpc("withdraw_counter", { p_offer: b.dataset.offerWithdraw }, t("toast.offerWithdrawn")); }
    else if (b.dataset.newInv) { const id = b.dataset.newInv; S.newInvite.has(id) ? S.newInvite.delete(id) : S.newInvite.add(id); b.setAttribute("aria-pressed", String(S.newInvite.has(id))); }
    else if (b.dataset.addInv) { const id = b.dataset.addInv; S.addInvite.has(id) ? S.addInvite.delete(id) : S.addInvite.add(id); b.setAttribute("aria-pressed", String(S.addInvite.has(id))); }
    else if (b.dataset.joinAccept) { const r = S.invites.find(x => x.id === b.dataset.joinAccept); await rpc("respond_join", { p_req: b.dataset.joinAccept, p_accept: true }, t(r && r.kind === "request" ? "toast.requestAccepted" : "toast.inviteAccepted")); }
    else if (b.dataset.joinDecline) { await rpc("respond_join", { p_req: b.dataset.joinDecline, p_accept: false }, t("toast.inviteDeclined")); }
    else if (b.dataset.joinCancel) { await rpc("cancel_join", { p_req: b.dataset.joinCancel }, t("toast.withdrawn")); }
    else if (b.dataset.unpay) { if (!confirmInline("unpay" + b.dataset.unpay)) return; await rpc("delete_payment", { p_id: b.dataset.unpay }, t("toast.unpaid")); }
  });
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault(); submitGroupForm(form);
  });
  window.addEventListener("cp-lang", () => {
    setMode(S.mode);
    renderStakeChips();
    if (S.me && S.gid && S.loaded) renderAll();
  });

  $("grpBtn").onclick = openAccount;
  $("copyInvite").onclick = async () => {
    const g = curGroup();
    const text = t("invite.text", { group: g ? g.name : "", url: location.origin + location.pathname.replace(/index\.html$/, ""), code: $("inviteCode").textContent });
    try { await navigator.clipboard.writeText(text); toast(t("toast.inviteCopied")); }
    catch { toast(t("toast.copyManual")); }
  };
  $("newCodeBtn").onclick = async () => {
    if (!confirmInline("newcode")) return;
    const r = await rpc("new_invite_code", { p_group: S.gid }, t("toast.newCode"));
    if (r.ok && r.data) $("inviteCode").textContent = r.data;
  };
  $("renameForm").addEventListener("submit", async (e) => { e.preventDefault(); await rpc("rename_group", { p_group: S.gid, p_name: $("grpRename").value }, t("toast.saved")); });
  $("nickForm").addEventListener("submit", async (e) => { e.preventDefault(); await rpc("set_nick", { p_group: S.gid, p_nick: $("accNick").value }, t("toast.saved")); });
  $("nStake").addEventListener("input", renderStakeChips);
  $("nTarget").addEventListener("change", renderNewInvites);

  $("newForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("newMsg"); msg.textContent = "";
    const title = $("nTitle").value.trim();
    const raw = $("nStake").value.trim().replace(",", ".").replace(/[£\s]/g, "");
    const stake = raw ? Number(raw) : S.stake;
    const target = S.kind === "dare" ? $("nTarget").value : null;
    if (S.kind === "dare" && !target) { msg.textContent = t("new.needTarget"); $("nTarget").focus(); return; }
    if (!title) { msg.textContent = t("new.needWhat"); $("nTitle").focus(); return; }
    if (!Number.isFinite(stake) || stake < 0.5 || stake > 1000) { msg.textContent = t("stakeRange"); $("nStake").focus(); return; }
    $("createBtn").disabled = true;
    let photo = null;
    try {
      const file = $("nPhoto").files && $("nPhoto").files[0];
      if (file) { $("createBtn").textContent = t("photo.uploading"); photo = await uploadPhoto(file, "challenge"); }
      const args = { p_group: S.gid, p_title: title, p_descr: $("nDesc").value.trim(), p_kind: S.kind, p_stake: r2(stake), p_deadline: $("nDeadline").value || null, p_photo_path: photo };
      if (target) args.p_target = target;
      if (S.newInvite.size) args.p_invite = [...S.newInvite];
      const r = await rpc("create_challenge_v2", args, t("toast.launched"));
      if (r.ok) { $("newForm").reset(); S.stake = 10; S.newInvite = new Set(); setKind("duel"); renderStakeChips(); go("list"); if (r.data) openDetail(r.data); }
      else if (r.error) msg.textContent = errText(r.error);
    } catch (err) { msg.textContent = err.message || errText(err); }
    finally { $("createBtn").disabled = false; $("createBtn").textContent = t("new.launch"); }
  });

  $("pSend").onclick = async () => {
    const id = S.openId; if (!id) return;
    const text = $("pText").value.trim();
    const file = $("pPhoto").files && $("pPhoto").files[0];
    if (!text && !file) { toast(t("toast.writeOrPhoto")); return; }
    $("pSend").disabled = true; $("pSend").textContent = t(file ? "photo.uploading" : "sending");
    try {
      const path = file ? await uploadPhoto(file, id) : null;
      const r = await rpc("submit_proof", { p_id: id, p_body: text, p_photo_path: path }, t("toast.proofSent"));
      if (r.ok) { $("pText").value = ""; $("pPhoto").value = ""; }
    } catch (err) { toast(err.message || errText(err)); }
    finally { $("pSend").disabled = false; renderDetail(); }
  };

  $("inviteToggle").onclick = () => {
    const c = S.challenges.find(x => x.id === S.openId); if (!c) return;
    S.addInvite = new Set(); $("inviteForm").hidden = false; $("inviteToggle").hidden = true;
    $("inviteFormChips").innerHTML = chipsHtml(inviteCandidates(c), S.addInvite, "data-add-inv");
  };
  $("inviteSend").onclick = async () => {
    const c = S.challenges.find(x => x.id === S.openId); if (!c) return;
    if (!S.addInvite.size) { toast(t("inv.pick")); return; }
    const r = await rpc("invite_to_challenge", { p_id: c.id, p_users: [...S.addInvite] }, t("toast.invitesSent"));
    if (r.ok) { S.addInvite = new Set(); $("inviteForm").hidden = true; renderDetail(); }
  };
  $("requestBtn").onclick = async () => {
    const c = S.challenges.find(x => x.id === S.openId); if (!c) return;
    await rpc("request_join", { p_id: c.id }, t("toast.requestSent"));
  };

  $("offerToggle").onclick = () => {
    const c = S.challenges.find(x => x.id === S.openId); if (!c) return;
    $("oDescr").value = c.descr || ""; $("oStake").value = String(Number(c.stake));
    $("oMsg").textContent = ""; $("offerForm").hidden = false; $("offerToggle").hidden = true; $("oDescr").focus();
  };
  $("offerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const c = S.challenges.find(x => x.id === S.openId); if (!c) return;
    const msg = $("oMsg"); msg.textContent = "";
    const descr = $("oDescr").value.trim();
    const raw = $("oStake").value.trim().replace(",", ".").replace(/[£\s]/g, "");
    const stake = raw ? Number(raw) : null;
    if (stake !== null && (!Number.isFinite(stake) || stake < 0.5 || stake > 1000)) { msg.textContent = t("stakeRange"); return; }
    const sameDescr = descr === (c.descr || "").trim(), sameStake = stake === null || r2(stake) === r2(c.stake);
    if ((sameDescr || !descr) && sameStake) { msg.textContent = t("offer.needChange"); return; }
    $("oSend").disabled = true;
    const r = await rpc("propose_counter", { p_id: c.id, p_descr: sameDescr ? null : descr, p_stake: sameStake ? null : r2(stake) }, t("toast.offerSent"));
    $("oSend").disabled = false;
    if (r.ok) { $("offerForm").hidden = true; renderDetail(); }
    else if (r.error) msg.textContent = errText(r.error);
  });

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
    $("authBtn").textContent = t(m === "login" ? "auth.signIn" : "auth.create");
    $("aPass").setAttribute("autocomplete", m === "login" ? "current-password" : "new-password");
    $("passHint").hidden = m === "login";
  }
  $("modeLogin").onclick = () => { setMode("login"); $("authMsg").textContent = ""; };
  $("modeSignup").onclick = () => { setMode("signup"); $("authMsg").textContent = ""; };
  $("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("authMsg"); msg.textContent = "";
    const email = $("aEmail").value.trim(), password = $("aPass").value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = t("err.email"); $("aEmail").focus(); return; }
    if (password.length < 6) { msg.textContent = t("err.passLen"); $("aPass").focus(); return; }
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
