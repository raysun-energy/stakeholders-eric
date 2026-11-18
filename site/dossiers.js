// Espace apporteurs d'affaires : dossiers affectés à une société, facturation et classement.
// Un apporteur ne voit que ce qui concerne SA société (règles RLS côté base) ; l'équipe voit tout et gère.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = (n) => n == null ? '' : Number(n).toLocaleString('fr-BE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const pct = (n) => n == null ? '' : Number(n).toLocaleString('fr-BE', { maximumFractionDigits: 1 }) + ' %';
const dateFr = (d) => d ? new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('fr-BE', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
const periodLabel = (p) => p.includes('-T') ? `${p.slice(6)}${p.slice(6) === '1' ? 'er' : 'e'} trimestre ${p.slice(0, 4)}` : `Année ${p}`;
const quarterOf = (d) => `${d.slice(0, 4)}-T${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;

const state = { admin: false, org: null, orgs: [], stats: [], kind: 'trimestre', period: null, dossiers: [], invoices: [], messages: [], open: new Set() };

function fail(e, msg = 'Une erreur est survenue. Rechargez la page.') {
  console.error(e);
  $('#error').textContent = e?.message && /Réservé|inconnu|invalide|déjà|d’abord|introuvable/i.test(e.message) ? e.message : msg;
}
const must = ({ data, error }) => { if (error) throw error; return data; };

// ---- Chargement ----------------------------------------------------------------

async function loadSpace() {
  $('#error').textContent = '';
  const org = state.org;
  const dq = sb.from('amb_dossiers').select('*').order('created_at', { ascending: false });
  const iq = sb.from('amb_org_invoices').select('*').order('invoice_date', { ascending: false });
  const [stats, dossiers, invoices] = await Promise.all([
    sb.rpc('amb_apporteur_stats', { p_org: state.admin ? org : null }).then(must),
    (org ? dq.eq('org_id', org) : dq).then(must),
    (org ? iq.eq('org_id', org) : iq).then(must),
  ]);
  Object.assign(state, { stats: stats ?? [], dossiers: dossiers ?? [], invoices: invoices ?? [] });
  const ids = state.dossiers.map((d) => d.id);
  state.messages = ids.length ? (must(await sb.from('amb_dossier_messages').select('*').in('dossier_id', ids).order('created_at')) ?? []) : [];
  renderPeriods(); renderHero(); renderDossiers(); renderInvoices();
}

function periodsOfKind() { return state.stats.filter((s) => s.kind === state.kind); }

function renderPeriods() {
  const list = periodsOfKind();
  if (!list.some((s) => s.period === state.period)) state.period = list[0]?.period ?? null;
  $('#period').innerHTML = list.map((s) => `<option value="${esc(s.period)}"${s.period === state.period ? ' selected' : ''}>${esc(periodLabel(s.period))}</option>`).join('');
  $('#period').hidden = !list.length;
}

// ---- Bandeau et podium -----------------------------------------------------------

function renderHero() {
  const s = periodsOfKind().find((x) => x.period === state.period);
  const orgName = state.orgs.find((o) => o.id === state.org)?.name;
  const main = $('#hero-main'), podium = $('#podium');
  $('#ranking-block').hidden = true;
  if (!s) {
    main.innerHTML = `<span class="eyebrow">Classement des apporteurs</span>
      <p style="margin-top:14px">Aucune facture enregistrée pour le moment. Votre part et le podium apparaîtront ici dès la première facture.</p>`;
    podium.innerHTML = '';
    return;
  }
  const label = periodLabel(s.period);
  if (s.own_amount != null) {
    main.innerHTML = `<span class="eyebrow">${esc(label)}</span>
      <div class="big">${esc(pct(s.own_share))}</div>
      <p>${state.admin ? `Part de ${esc(orgName)}` : 'Votre part'} dans le total facturé par tous les apporteurs d'affaires.</p>
      <div class="meter" role="img" aria-label="Part : ${esc(pct(s.own_share))}"><i style="width:${Math.max(2, Math.min(100, Number(s.own_share) || 0))}%"></i></div>
      <div class="facts">
        <div><b>${esc(euro(s.own_amount))}</b><span>facturés hors TVA</span></div>
        <div><b>${s.own_rank}${s.own_rank === 1 ? 'er' : 'e'} sur ${s.orgs}</b><span>au classement</span></div>
        ${s.total_amount != null ? `<div><b>${esc(euro(s.total_amount))}</b><span>total de tous les apporteurs</span></div>` : ''}
      </div>`;
  } else {
    main.innerHTML = `<span class="eyebrow">${esc(label)}</span>
      <p style="margin-top:14px">${state.org ? `${state.admin ? esc(orgName) + ' n\'a' : 'Vous n\'avez'} pas de facture enregistrée sur cette période.` : 'Choisissez une société pour voir sa part.'}</p>
      ${s.total_amount != null ? `<div class="facts"><div><b>${esc(euro(s.total_amount))}</b><span>total de tous les apporteurs</span></div><div><b>${s.orgs}</b><span>sociétés ayant facturé</span></div></div>` : ''}`;
  }
  // Podium : 2e, 1er, 3e (les ex æquo partagent leur marche, la suivante reste vide).
  const top = (s.podium ?? []).filter((p) => p.rank <= 3);
  const at = (r) => top.filter((p) => p.rank === r);
  const step = (r) => {
    const here = at(r);
    if (!here.length) return `<div class="step p${r} empty"><div class="block">${r}</div></div>`;
    return `<div class="step p${r}${!state.admin && here.some((p) => p.me) ? ' me' : ''}">
      ${here.map((p) => `<div><div class="who">${p.name ? esc(p.name) : 'Autre apporteur'}</div><div class="share">${esc(pct(p.share))}</div></div>`).join('')}
      <div class="block" aria-hidden="true">${r}</div></div>`;
  };
  podium.innerHTML = step(2) + step(1) + step(3);
  if (state.admin) {
    $('#ranking-block').hidden = false;
    $('#ranking').innerHTML = (s.podium ?? []).map((p) => `<tr><td>${p.rank}</td><td>${esc(p.name)}</td><td class="num">${esc(euro(p.amount))}</td><td class="num">${esc(pct(p.share))}</td></tr>`).join('');
  }
}

// ---- Dossiers ---------------------------------------------------------------------

// Fil de discussion d'un dossier : messages de l'équipe et de la société, puis champ de réponse.
function fil(d) {
  const msgs = state.messages.filter((m) => m.dossier_id === d.id);
  const heure = (t) => new Date(t).toLocaleString('fr-BE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `<details class="fil"${state.open.has(d.id) ? ' open' : ''}>
    <summary>Discussion${msgs.length ? ` (${msgs.length})` : ''}</summary>
    ${msgs.length ? `<ol>${msgs.map((m) => `<li class="${m.from_team === state.admin ? 'moi' : ''}"><small>${esc(m.author_name || (m.from_team ? 'RaYSun' : 'Apporteur'))}${m.from_team ? ' · RaYSun' : ''} · ${esc(heure(m.created_at))}</small>${esc(m.body)}</li>`).join('')}</ol>`
      : '<p class="meta" style="margin:8px 0">Aucun message pour le moment.</p>'}
    <form data-fil><textarea rows="2" required maxlength="4000" placeholder="Votre message" aria-label="Votre message"></textarea><button class="btn primary" type="submit">Envoyer</button></form>
    ${state.admin ? `<p class="meta" style="margin:6px 0 0">${d.odoo_lead_id ? 'Chaque message est aussi noté sur la fiche Odoo du prospect.' : 'Dossier non relié à une fiche Odoo : les messages restent ici.'}</p>` : ''}
  </details>`;
}

function renderDossiers() {
  const orgName = (id) => state.orgs.find((o) => o.id === id)?.name ?? '';
  $('#dossiers-title').textContent = state.admin ? (state.org ? `Dossiers de ${orgName(state.org)}` : 'Tous les dossiers') : 'Vos dossiers';
  $('#dossiers-intro').hidden = state.admin;
  if (!state.dossiers.length) { $('#dossiers').innerHTML = '<p class="muted">Aucun dossier pour le moment.</p>'; return; }
  const kv = (k, v) => v ? `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>` : '';
  $('#dossiers').innerHTML = state.dossiers.map((d) => {
    const dispo = [dateFr(d.available_on), d.available_note].filter(Boolean).map(esc).join(' · ');
    const contact = [d.contact_name, d.contact_function].filter(Boolean).map(esc).join(', ');
    const answered = d.answered_at ? `<p class="meta">${esc(d.status)} par ${esc(d.answered_by_name || 'un membre')} le ${esc(dateFr(d.answered_at))}${d.answer_note ? ` : « ${esc(d.answer_note)} »` : ''}</p>` : '';
    let actions = '';
    if (state.admin) {
      // L'équipe suit les réponses ; c'est l'apporteur qui confirme.
    } else if (d.status === 'Proposé') {
      actions = `<textarea rows="2" placeholder="Remarque pour RaYSun (facultatif)" aria-label="Remarque pour RaYSun"></textarea>
        <div class="actions"><button class="btn primary" data-answer="Confirmé">Je confirme ce dossier</button>
        <button class="btn secondary" data-answer="Refusé">Je ne peux pas le prendre</button></div>`;
    } else if (d.status === 'Confirmé') {
      actions = `<textarea rows="2" placeholder="Compte rendu de la visite (facultatif)" aria-label="Compte rendu de la visite"></textarea>
        <div class="actions"><button class="btn primary" data-answer="Visite faite">La visite est faite</button></div>`;
    }
    const admin = state.admin ? `<div class="actions">
        <button class="btn secondary" data-resend>Renvoyer l'e-mail</button>
        ${d.status !== 'Clôturé' ? '<button class="btn secondary" data-close>Clôturer</button>' : ''}
        <button class="link danger" data-delete>Supprimer</button></div>
        ${d.odoo_lead_id ? `<p class="meta"><a href="https://raysun.odoo.com/odoo/crm/${Number(d.odoo_lead_id)}" target="_blank" rel="noopener">Fiche Odoo</a></p>` : ''}
        <p class="meta">${d.notified_at ? `E-mail envoyé le ${esc(dateFr(d.notified_at))}` : 'E-mail pas encore envoyé'}</p>` : '';
    return `<article class="dossier" data-id="${esc(d.id)}">
      <div><span class="st st-${esc(d.status.split(' ')[0])}">${esc(d.status)}</span></div>
      <h3>${esc(d.prospect)}</h3>
      <p class="meta">${[state.admin && !state.org ? esc(orgName(d.org_id)) : '', esc(d.region), `reçu le ${esc(dateFr(d.created_at))}`].filter(Boolean).join(' · ')}</p>
      <dl>
        ${kv('Adresse', d.address ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.address)}" target="_blank" rel="noopener">${esc(d.address)}</a>` : '')}
        ${kv('Projet', esc(d.project))}
        ${kv('Contact', contact)}
        ${kv('Téléphone', d.contact_phone ? `<a href="tel:${esc(d.contact_phone.replace(/[^+\d]/g, ''))}">${esc(d.contact_phone)}</a>` : '')}
        ${kv('E-mail', d.contact_email ? `<a href="mailto:${esc(d.contact_email)}">${esc(d.contact_email)}</a>` : '')}
        ${kv('Disponibilité', dispo)}
      </dl>
      ${d.message ? `<p class="msg"><b>Message de RaYSun</b>${esc(d.message)}</p>` : ''}
      ${answered}${actions}${admin}
      ${fil(d)}
    </article>`;
  }).join('');
}

$('#dossiers').addEventListener('click', async (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const card = btn.closest('.dossier'), id = card.dataset.id;
  try {
    if (btn.dataset.answer) {
      btn.disabled = true;
      must(await sb.rpc('amb_dossier_answer', { p_id: id, p_status: btn.dataset.answer, p_note: $('textarea', card)?.value || null }));
    } else if ('resend' in btn.dataset) {
      must(await sb.rpc('amb_dossier_resend', { p_id: id }));
    } else if ('close' in btn.dataset) {
      must(await sb.from('amb_dossiers').update({ status: 'Clôturé' }).eq('id', id));
    } else if ('delete' in btn.dataset) {
      if (!confirm('Supprimer définitivement ce dossier ?')) return;
      must(await sb.from('amb_dossiers').delete().eq('id', id));
    } else return;
    await loadSpace();
  } catch (err) { btn.disabled = false; fail(err, 'Action impossible pour le moment.'); }
});

$('#dossiers').addEventListener('toggle', (e) => {
  const det = e.target.closest?.('details.fil'); if (!det) return;
  const id = det.closest('.dossier').dataset.id;
  det.open ? state.open.add(id) : state.open.delete(id);
}, true);

$('#dossiers').addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-fil]'); if (!form) return;
  e.preventDefault();
  const id = form.closest('.dossier').dataset.id, ta = $('textarea', form), btn = $('button', form);
  if (!ta.value.trim()) return;
  btn.disabled = true;
  try {
    must(await sb.rpc('amb_dossier_post', { p_dossier: id, p_body: ta.value }));
    state.open.add(id);
    await loadSpace();
  } catch (err) { btn.disabled = false; fail(err, 'Le message n\'a pas pu être envoyé.'); }
});

// ---- Facturation --------------------------------------------------------------------

function renderInvoices() {
  const orgName = (id) => state.orgs.find((o) => o.id === id)?.name ?? '';
  $('#inv-actions').hidden = !state.admin;
  if (!state.invoices.length) { $('#invoices').innerHTML = '<tr><td colspan="5" class="muted">Aucune facture enregistrée.</td></tr>'; return; }
  const rows = [];
  let year = null, quarter = null, qSum = 0, ySum = 0;
  const flushQ = () => { if (quarter) rows.push(`<tr class="total"><td colspan="3">Total ${esc(periodLabel(quarter))}</td><td class="num">${esc(euro(qSum))}</td>${state.admin ? '<td></td>' : ''}</tr>`); qSum = 0; };
  const flushY = () => { if (year) rows.push(`<tr class="total"><td colspan="3">Total année ${esc(year)}</td><td class="num">${esc(euro(ySum))}</td>${state.admin ? '<td></td>' : ''}</tr>`); ySum = 0; };
  for (const i of state.invoices) {
    const q = quarterOf(i.invoice_date), y = i.invoice_date.slice(0, 4);
    if (q !== quarter) { flushQ(); if (y !== year) { flushY(); year = y; } quarter = q; }
    qSum += Number(i.amount_eur); ySum += Number(i.amount_eur);
    const mois = i.period_month ? new Date(i.period_month + '-15').toLocaleDateString('fr-BE', { month: 'long', year: 'numeric' }) : dateFr(i.invoice_date);
    rows.push(`<tr data-id="${esc(i.id)}"><td>${esc(mois)}</td>
      <td>${esc(i.reference)}${state.admin && !state.org ? `<small>${esc(orgName(i.org_id))}</small>` : ''}</td>
      <td>${esc(i.label)}</td><td class="num">${esc(euro(i.amount_eur))}</td>
      ${state.admin ? `<td>${i.source === 'outil-fees' ? '' : '<button class="link danger" data-del-invoice>Supprimer</button>'}</td>` : ''}</tr>`);
  }
  flushQ(); flushY();
  $('#invoices').innerHTML = rows.join('');
}

$('#invoices').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del-invoice]'); if (!btn) return;
  if (!confirm('Supprimer cette facture ?')) return;
  try { must(await sb.from('amb_org_invoices').delete().eq('id', btn.closest('tr').dataset.id)); await loadSpace(); }
  catch (err) { fail(err, 'Suppression impossible.'); }
});

// ---- Période -------------------------------------------------------------------------

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  state.kind = b.dataset.kind; state.period = null;
  document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderPeriods(); renderHero();
}));
$('#period').addEventListener('change', (e) => { state.period = e.target.value; renderHero(); });

// ---- Outils de l'équipe ----------------------------------------------------------------

async function loadOrgs() {
  state.orgs = state.admin ? (must(await sb.rpc('amb_list_orgs')) ?? []) : (must(await sb.from('amb_orgs').select('id, name')) ?? []);
  if (!state.admin) return;
  const opts = state.orgs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
  document.querySelectorAll('#admin select[name="org_id"]').forEach((s) => { const v = s.value; s.innerHTML = opts; if (v) s.value = v; });
  const view = $('#org-view'), cur = state.org;
  view.innerHTML = '<option value="">Toutes les sociétés</option>' + opts;
  view.value = state.orgs.some((o) => o.id === cur) ? cur : '';
  state.org = view.value || null;
  $('#orgs').innerHTML = state.orgs.length ? state.orgs.map((o) => `<tr><td><b>${esc(o.name)}</b></td><td>${
    o.people.length ? `<ul class="people">${o.people.map((p) => `<li class="${p.pending ? 'pending' : ''}">${esc(p.name)} · ${esc(p.email)}${p.pending ? ' · invitation en attente' : ''} <button type="button" class="link danger" data-remove="${esc(p.email)}">Retirer</button></li>`).join('')}</ul>`
      : '<span class="muted">Personne pour le moment : les e-mails de dossier ne partiront pas.</span>'}</td></tr>`).join('')
    : '<tr><td colspan="2" class="muted">Aucune société. Créez-en une ci-dessus.</td></tr>';
}

async function loadFeesState() {
  const st = must(await sb.from('amb_fees_sync').select('*').maybeSingle());
  $('#fees-state').textContent = !st ? 'Aucune lecture pour le moment.'
    : `${st.ok ? 'Dernière lecture réussie' : 'Dernière lecture en échec'} le ${new Date(st.at).toLocaleString('fr-BE', { dateStyle: 'long', timeStyle: 'short' })} : ${st.message ?? ''}`
      + (st.ok && st.source_at ? ` (outil Fees modifié le ${dateFr(st.source_at)})` : '');
  $('#fees-state').style.color = st && !st.ok ? '#B83A2C' : '';
}

function values(form) {
  const o = {};
  for (const [k, v] of new FormData(form).entries()) o[k] = String(v).trim() === '' ? null : String(v).trim();
  return o;
}

// Liste de propositions sous un champ : chercher(q) renvoie des éléments, ligne(x) leur affichage, choisir(x) l'action.
function suggest(input, { chercher, ligne, choisir, min = 3 }) {
  const ul = document.createElement('ul');
  ul.className = 'sugg'; ul.hidden = true; ul.setAttribute('role', 'listbox');
  input.after(ul);
  let items = [], timer = null, seq = 0;
  const close = () => { ul.hidden = true; };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < min) return close();
    timer = setTimeout(async () => {
      const n = ++seq;
      let res = [];
      try { res = await chercher(q); } catch (e) { console.error(e); res = { erreur: e.message }; }
      if (n !== seq) return;                       // une frappe plus récente a pris le relais
      if (res?.erreur) { ul.innerHTML = `<li class="info">${esc(res.erreur)}</li>`; ul.hidden = false; items = []; return; }
      items = res ?? [];
      if (!items.length) return close();
      ul.innerHTML = items.map((x, k) => `<li role="option" data-k="${k}">${ligne(x)}</li>`).join('');
      ul.hidden = false;
    }, 300);
  });
  ul.addEventListener('mousedown', (e) => {         // mousedown : avant que le champ ne perde le focus
    const li = e.target.closest('li[data-k]'); if (!li) return;
    e.preventDefault(); close(); choisir(items[Number(li.dataset.k)]);
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

async function odooSearch(type, q) {
  const { data, error } = await sb.functions.invoke('amb-odoo-search', { body: { type, q } });
  if (error || data?.error) return { erreur: 'Recherche Odoo indisponible pour le moment.' };
  return data.results;
}

// Région d'après le code postal belge.
function regionOf(zip) {
  const n = Number(String(zip ?? '').match(/\b\d{4}\b/)?.[0]);
  if (!n) return null;
  if (n <= 1299) return 'Bruxelles';
  if ((n >= 1300 && n <= 1499) || (n >= 4000 && n <= 7999)) return 'Wallonie';
  return 'Flandre';
}

// Position d'une adresse (Google Geocoding), pour afficher le dossier sur la carte. Sans réponse : pas de point.
async function geocodeAddress(address) {
  if (!address || !(await loadPlaces())) return {};
  try {
    const { results } = await new google.maps.Geocoder().geocode({ address, region: 'BE' });
    const loc = results?.[0]?.geometry?.location;
    return loc ? { lat: loc.lat(), lng: loc.lng() } : {};
  } catch { return {}; }
}

// Dossiers créés avant l'affichage sur la carte : on retrouve leur position une fois.
async function backfillGeo() {
  for (const d of state.dossiers.filter((x) => x.address && x.lat == null).slice(0, 20)) {
    const pos = await geocodeAddress(d.address);
    if (pos.lat != null) await sb.from('amb_dossiers').update(pos).eq('id', d.id);
  }
}

// Adresses proposées par Google (Places). Si le service n'est pas disponible avec la clé, le champ reste une saisie libre.
let placesReady = null;
function loadPlaces() {
  const key = window.CITYWATT_CONFIG.googleMapsApiKey;
  if (!key) return Promise.resolve(false);
  placesReady ??= new Promise((resolve) => {
    if (window.google?.maps?.places) return resolve(true);
    window.__amPlacesReady = () => resolve(!!window.google?.maps?.places);
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&language=fr&region=BE&loading=async&callback=__amPlacesReady`;
    s.onerror = () => resolve(false);
    document.head.append(s);
  });
  return placesReady;
}
let placesOff = false;
async function addressSearch(q) {
  if (placesOff || !(await loadPlaces())) return [];
  const svc = new google.maps.places.AutocompleteService();
  return new Promise((resolve) => svc.getPlacePredictions(
    { input: q, componentRestrictions: { country: 'be' }, language: 'fr' },
    (preds, status) => {
      if (status === 'REQUEST_DENIED') placesOff = true;   // API Places non activée pour cette clé : saisie libre
      resolve(status === 'OK' ? preds : []);
    }));
}

function wireAdmin() {
  // Retirer l'accès d'une personne (compte ou invitation en attente).
  $('#orgs').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]'); if (!b) return;
    if (!confirm(`Retirer l'accès de ${b.dataset.remove} ? Cette personne ne recevra plus les e-mails de dossier.`)) return;
    try { must(await sb.rpc('amb_remove_member', { p_email: b.dataset.remove })); await loadOrgs(); }
    catch (err) { fail(err, 'Le retrait a échoué.'); }
  });
  // Prospect : fiches du CRM Odoo
  const df = $('#dossier-form');
  suggest(df.prospect, {
    chercher: (q) => odooSearch('leads', q),
    ligne: (l) => `<b>${esc(l.company || l.name)}</b><small>${[l.company ? l.name : null, l.contact_name, l.stage].filter(Boolean).map(esc).join(' · ')}</small>`,
    choisir: (l) => {
      df.prospect.value = l.company || l.name || '';
      df.odoo_lead_id.value = l.id;
      for (const k of ['contact_name', 'contact_function', 'contact_phone', 'contact_email', 'address']) if (l[k]) df[k].value = l[k];
      if (l.name && l.company && !df.project.value) df.project.value = l.name;
      const r = regionOf(l.zip || l.address); if (r) df.region.value = r;
    },
  });
  df.prospect.addEventListener('input', () => { df.odoo_lead_id.value = ''; });
  // Adresse : propositions Google
  suggest(df.address, {
    chercher: addressSearch,
    ligne: (p) => `${esc(p.structured_formatting?.main_text ?? p.description)}<small>${esc(p.structured_formatting?.secondary_text ?? '')}</small>`,
    choisir: (p) => {
      df.address.value = p.description.replace(/, Belgi(que|ë|um)$/i, '');
      new google.maps.Geocoder().geocode({ placeId: p.place_id }).then(({ results }) => {
        const zip = results?.[0]?.address_components?.find((c) => c.types.includes('postal_code'))?.short_name;
        const r = regionOf(zip); if (r) df.region.value = r;
        if (results?.[0]?.formatted_address) df.address.value = results[0].formatted_address.replace(/, Belgi(que|ë|um)$/i, '');
      }).catch(() => {});
    },
  });
  // Société : fiches contact Odoo
  const of = $('#org-form');
  suggest(of.name, {
    chercher: (q) => odooSearch('partners', q),
    ligne: (p) => `<b>${esc(p.name)}</b><small>${[p.address, `${p.people.length} personne(s) avec e-mail`].filter(Boolean).map(esc).join(' · ')}</small>`,
    choisir: async (p) => {
      try {
        const id = must(await sb.rpc('amb_create_org', { p_name: p.name, p_odoo_partner: p.id }));
        of.reset(); $('#org-msg').textContent = `${p.name} est ajoutée depuis Odoo.`;
        await loadOrgs();
        document.querySelectorAll('#admin select[name="org_id"]').forEach((s) => { s.value = id; });
        const box = $('#odoo-people');
        box.hidden = false;
        box.innerHTML = p.people.length
          ? `<b>Personnes de ${esc(p.name)} dans Odoo</b><ul>${p.people.map((c, k) => `<li><span>${esc(c.name)} · ${esc(c.email)}${c.function ? ` · ${esc(c.function)}` : ''}</span><button type="button" class="btn secondary" data-k="${k}">Rattacher</button></li>`).join('')}</ul>`
          : `<b>${esc(p.name)}</b> n'a aucune personne avec une adresse e-mail dans Odoo. Rattachez-les à la main ci-dessous.`;
        box.onclick = async (e) => {
          const b = e.target.closest('button[data-k]'); if (!b) return;
          const c = p.people[Number(b.dataset.k)];
          try {
            must(await sb.rpc('amb_upsert_apporteur', { p_email: c.email, p_name: c.name, p_org: id }));
            b.disabled = true; b.textContent = 'Rattaché';
            await loadOrgs();
          } catch (err) { fail(err, 'La personne n\'a pas pu être rattachée.'); }
        };
      } catch (err) { fail(err, 'La société n\'a pas pu être créée.'); }
    },
  });

  $('#org-view').addEventListener('change', (e) => { state.org = e.target.value || null; loadSpace().catch(fail); });

  $('#dossier-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, v = values(f), msg = $('#dossier-msg');
    const org = state.orgs.find((o) => o.id === v.org_id);
    msg.textContent = '';
    if (!org?.people.length && !confirm(`Aucune personne n'est rattachée à ${org?.name}. Le dossier sera créé, mais aucun e-mail ne partira. Continuer ?`)) return;
    try {
      if (v.odoo_lead_id) v.odoo_lead_id = Number(v.odoo_lead_id);
      Object.assign(v, await geocodeAddress(v.address));   // position sur la carte
      must(await sb.from('amb_dossiers').insert(v));
      f.reset(); f.org_id.value = v.org_id; f.odoo_lead_id.value = '';
      msg.textContent = org.people.length ? `Dossier affecté. E-mail envoyé à ${org.people.map((p) => p.email).join(', ')}.` : 'Dossier créé, sans e-mail.';
      await loadSpace();
    } catch (err) { fail(err, 'Le dossier n\'a pas pu être créé.'); }
  });

  $('#fees-now').addEventListener('click', async (e) => {
    e.target.disabled = true; $('#fees-state').textContent = 'Lecture en cours…';
    try {
      must(await sb.rpc('amb_fees_sync_now'));
      await new Promise((r) => setTimeout(r, 6000));
      await Promise.all([loadFeesState(), loadOrgs()]); await loadSpace();
    } catch (err) { fail(err, 'La lecture n\'a pas pu être lancée.'); }
    e.target.disabled = false;
  });
  loadFeesState().catch(console.error);
  setTimeout(() => backfillGeo().catch(console.error), 1500);

  $('#org-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      must(await sb.rpc('amb_create_org', { p_name: values(e.target).name, p_odoo_partner: null }));
      e.target.reset(); $('#org-msg').textContent = 'Société créée.';
      await loadOrgs();
    } catch (err) { fail(err, 'La société n\'a pas pu être créée.'); }
  });

  $('#person-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, v = values(f);
    try {
      must(await sb.rpc('amb_upsert_apporteur', { p_email: v.email, p_name: v.name, p_org: v.org_id }));
      f.reset(); f.org_id.value = v.org_id; $('#org-msg').textContent = `${v.name} est rattaché(e).`;
      await loadOrgs();
    } catch (err) { fail(err, 'La personne n\'a pas pu être rattachée.'); }
  });
}

// ---- Démarrage ---------------------------------------------------------------------------

async function start() {
  const who = await currentMember();
  if (!who) { $('#login').hidden = false; return; }
  if (!who.member) { location.href = './'; return; }   // compte sans accès : la carte gère la demande d'accès
  $('#login').hidden = true; $('#content').hidden = false;
  $('#user-name').textContent = who.member.name;
  state.admin = who.member.role === 'admin';
  $('#admin-link').hidden = $('#tools-link').hidden = !state.admin;
  $('#admin').hidden = $('#org-bar').hidden = !state.admin;
  if (state.admin) wireAdmin();
  else state.org = must(await sb.rpc('amb_org'));
  await loadOrgs();
  if (!state.admin && !state.org) { $('#no-org').hidden = false; return; }
  $('#space').hidden = false;
  await loadSpace();
}

wireLoginForm(start);
start().catch(fail);
