// Espace apporteurs d'affaires : dossiers affectés à une société, facturation et classement.
// Un apporteur ne voit que ce qui concerne SA société (règles RLS côté base) ; l'équipe voit tout et gère.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = (n) => n == null ? '' : Number(n).toLocaleString('fr-BE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const pct = (n) => n == null ? '' : Number(n).toLocaleString('fr-BE', { maximumFractionDigits: 1 }) + ' %';
const dateFr = (d) => d ? new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('fr-BE', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
const periodLabel = (p) => p.includes('-T') ? `${p.slice(6)}${p.slice(6) === '1' ? 'er' : 'e'} trimestre ${p.slice(0, 4)}` : `Année ${p}`;
const quarterOf = (d) => `${d.slice(0, 4)}-T${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;

const state = { admin: false, org: null, orgs: [], stats: [], kind: 'trimestre', period: null, dossiers: [], invoices: [] };

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
      ${here.map((p) => `<div><div class="who"${p.me ? ' data-me' : ''}>${esc(p.name)}</div><div class="share">${esc(pct(p.share))}</div></div>`).join('')}
      <div class="block" aria-hidden="true">${r}</div></div>`;
  };
  podium.innerHTML = step(2) + step(1) + step(3);
  if (state.admin) {
    $('#ranking-block').hidden = false;
    $('#ranking').innerHTML = (s.podium ?? []).map((p) => `<tr><td>${p.rank}</td><td>${esc(p.name)}</td><td class="num">${esc(euro(p.amount))}</td><td class="num">${esc(pct(p.share))}</td></tr>`).join('');
  }
}

// ---- Dossiers ---------------------------------------------------------------------

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
      ${answered}${actions}${admin}
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
    rows.push(`<tr data-id="${esc(i.id)}"><td>${esc(dateFr(i.invoice_date))}</td>
      <td>${esc(i.reference)}${state.admin && !state.org ? `<small>${esc(orgName(i.org_id))}</small>` : ''}</td>
      <td>${esc(i.label)}</td><td class="num">${esc(euro(i.amount_eur))}</td>
      ${state.admin ? '<td><button class="link danger" data-del-invoice>Supprimer</button></td>' : ''}</tr>`);
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
    o.people.length ? `<ul class="people">${o.people.map((p) => `<li class="${p.pending ? 'pending' : ''}">${esc(p.name)} · ${esc(p.email)}${p.pending ? ' · invitation en attente' : ''}</li>`).join('')}</ul>`
      : '<span class="muted">Personne pour le moment : les e-mails de dossier ne partiront pas.</span>'}</td></tr>`).join('')
    : '<tr><td colspan="2" class="muted">Aucune société. Créez-en une ci-dessus.</td></tr>';
}

function values(form) {
  const o = {};
  for (const [k, v] of new FormData(form).entries()) o[k] = String(v).trim() === '' ? null : String(v).trim();
  return o;
}

function wireAdmin() {
  $('#org-view').addEventListener('change', (e) => { state.org = e.target.value || null; loadSpace().catch(fail); });

  $('#dossier-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, v = values(f), msg = $('#dossier-msg');
    const org = state.orgs.find((o) => o.id === v.org_id);
    msg.textContent = '';
    if (!org?.people.length && !confirm(`Aucune personne n'est rattachée à ${org?.name}. Le dossier sera créé, mais aucun e-mail ne partira. Continuer ?`)) return;
    try {
      must(await sb.from('amb_dossiers').insert(v));
      f.reset(); f.org_id.value = v.org_id;
      msg.textContent = org.people.length ? `Dossier affecté. E-mail envoyé à ${org.people.map((p) => p.email).join(', ')}.` : 'Dossier créé, sans e-mail.';
      await loadSpace();
    } catch (err) { fail(err, 'Le dossier n\'a pas pu être créé.'); }
  });

  $('#invoice-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, v = values(f);
    try {
      must(await sb.from('amb_org_invoices').insert(v));
      f.reset(); f.org_id.value = v.org_id;
      $('#invoice-msg').textContent = 'Facture enregistrée.';
      await loadSpace();
    } catch (err) { fail(err, 'La facture n\'a pas pu être enregistrée.'); }
  });

  $('#org-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      must(await sb.rpc('amb_create_org', { p_name: values(e.target).name }));
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
