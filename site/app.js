const state = {
  user: null, map: null,
  leads: [], markers: new Map(), selectedId: null, mine: [],
  suggestions: [], suggMarkers: new Map(),
  members: [], memberMarkers: [],
  dossiers: [], dossierMarkers: [],
  candidates: new Map(), candMarkers: new Map(), candSelected: null,
  draft: null, // lieu en cours de proposition : { lat, lng, marker }
};

const $ = (sel, root = document) => root.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shortName(lead) {
  return lead.name.split(' — ')[0].replace(/\s*\(.*\)$/, '');
}

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('fr-BE') : esc(n);
}

// --- Marqueurs ------------------------------------------------------------------

function leadHtml(lead, selected) {
  return `<div class="pin lead${selected ? ' selected' : ''}${lead.convertedAt ? ' converted' : ''}"></div>`
    + `<span class="mk-label ${labelSide(lead)}">${esc(shortName(lead))}</span>`;
}

// Lieu converti ou traité : retiré de la carte (visible par l'équipe avec « Afficher les convertis »).
const isClosed = (s) => s.follow_up === 'Converti' || s.follow_up === 'Traité';

function suggHtml(s, selected) {
  return `<div class="pin sugg${selected ? ' selected' : ''}${isClosed(s) ? ' converted' : ''}">+</div><span class="mk-label right">${esc(s.place_name)}</span>`;
}

// Quand deux immeubles sont très proches, l'étiquette du plus à l'ouest passe à gauche.
function labelSide(lead) {
  const close = state.leads.some((o) => o !== lead && o.lat != null
    && Math.abs(o.lat - lead.lat) < 0.004 && Math.abs(o.lng - lead.lng) < 0.03 && o.lng > lead.lng);
  return close ? 'left' : 'right';
}

function renderMarkers() {
  const map = state.map;
  // Membres d'abord, pour qu'ils restent sous les immeubles.
  state.memberMarkers = state.members.map((m) => map.addMarker({
    lat: m.lat, lng: m.lng, zIndex: 1,
    html: '<div class="member-dot"></div>',
    title: m.name ? `${m.name} — ${m.operation}` : `Membre — ${m.operation}`,
  }));
  for (const lead of state.leads) {
    if (lead.lat == null) continue;
    state.markers.set(lead.id, map.addMarker({
      lat: lead.lat, lng: lead.lng, html: leadHtml(lead, false), title: lead.name, zIndex: 10,
      onClick: () => select(lead.id),
    }));
  }
  state.suggestions.forEach(addSuggestionMarker);
  // Dossiers confiés aux apporteurs d'affaires (toutes Régions) : un clic ouvre l'espace apporteurs.
  state.dossierMarkers = state.dossiers.map((d) => map.addMarker({
    lat: d.lat, lng: d.lng, zIndex: 15, title: `Dossier : ${d.prospect}`,
    html: `<div class="pin dossier">D</div><span class="mk-label right">${esc(d.prospect)}</span>`,
    onClick: () => { location.href = 'dossiers.html'; },
  }));
  applyFilters();
  const pts = [...state.leads, ...state.dossiers].filter((l) => l.lat != null).map((l) => [l.lat, l.lng]);
  if (pts.length) map.fitBounds(pts);
}

function addSuggestionMarker(s) {
  const m = state.map.addMarker({
    lat: s.lat, lng: s.lng, html: suggHtml(s, false), title: s.place_name, zIndex: 20,
    onClick: () => selectSuggestion(s.id),
  });
  state.suggMarkers.set(s.id, m);
  return m;
}

// Les étiquettes ne s'affichent qu'à partir d'un certain zoom pour éviter les chevauchements.
function updateLabels() {
  document.body.classList.toggle('hide-labels', state.map.getZoom() < 12);
}

// --- Entreprises à démarcher (candidats de l'outil Zoning as Community) --------
// Chargées pour la zone affichée seulement, à partir d'un certain zoom : la base en compte plusieurs milliers.

const CAND_ZOOM = 14;
const CAND_CATEGORIES = {
  bureaux: 'Bureaux', horeca: 'Horeca', logistique: 'Logistique', commerce: 'Commerce', industrie: 'Industrie',
  industrie_lourde: 'Industrie lourde', construction: 'Construction', sante: 'Santé', data_tech: 'Données et technologies',
  sport_loisirs: 'Sport et loisirs', enseignement: 'Enseignement', autre: 'Autre activité',
};
const candHtml = (selected) => `<div class="pin cand${selected ? ' selected' : ''}"></div>`;
const mwh = (kwh) => Math.round(kwh / 1000).toLocaleString('fr-BE');

let candSeq = 0;
async function refreshCandidates() {
  const hint = $('#cand-hint');
  const on = $('#show-candidates').checked;
  const hideAll = () => state.candMarkers.forEach((m) => m.hide());
  if (!on) { hint.hidden = true; hideAll(); return; }
  hint.hidden = false;
  if (state.map.getZoom() < CAND_ZOOM) { hideAll(); hint.textContent = 'Zoomez sur un quartier ou un zoning pour voir les entreprises à démarcher.'; return; }
  const b = state.map.getBounds();
  if (!b) return;
  const n = ++candSeq;
  const { data, error } = await sb.rpc('amb_candidates', { p_min_lat: b.minLat, p_max_lat: b.maxLat, p_min_lng: b.minLng, p_max_lng: b.maxLng });
  if (n !== candSeq) return;                         // la carte a encore bougé entre-temps
  if (error) { console.error(error); hint.textContent = 'Les entreprises ne peuvent pas être chargées pour le moment.'; return; }
  const visible = new Set();
  for (const c of data) {
    visible.add(c.id);
    state.candidates.set(c.id, c);
    if (!state.candMarkers.has(c.id)) {
      state.candMarkers.set(c.id, state.map.addMarker({
        lat: c.lat, lng: c.lng, zIndex: 5, title: c.nom, html: candHtml(c.id === state.candSelected),
        onClick: () => selectCandidate(c.id),
      }));
    }
  }
  state.candMarkers.forEach((m, id) => (visible.has(id) ? m.show() : m.hide()));
  const total = data.length ? Number(data[0].total) : 0;
  hint.textContent = !total ? 'Aucune entreprise à démarcher dans cette zone.'
    : total > data.length ? `${data.length} entreprises affichées sur ${total} dans cette zone (les plus grands sites). Zoomez pour voir les autres.`
      : `${total} entreprise${total > 1 ? 's' : ''} à démarcher dans cette zone.`;
}

function selectCandidate(id) {
  const c = state.candidates.get(id);
  if (!c) return;
  cancelDraft();
  clearSelection();
  state.candSelected = id;
  state.candMarkers.get(id)?.setHtml(candHtml(true));
  const row = (k, v) => (v ? `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>` : '');
  const conso = c.conso_max_kwh ? `${c.conso_min_kwh ? mwh(c.conso_min_kwh) + ' à ' : 'jusqu’à '}${mwh(c.conso_max_kwh)} MWh/an` : '';
  $('#panel-body').innerHTML = `
    <div class="panel-head">
      <span class="tag" style="background:#E3EDF7;color:#2E5E8C">Entreprise à démarcher</span>
      <h2>${esc(c.nom)}</h2>
      <p class="muted">${esc(c.adresse)}</p>
    </div>
    <dl>
      ${row('Activité', esc(CAND_CATEGORIES[c.categorie] || c.categorie))}
      ${row('Consommation estimée', esc(conso))}
      ${row('Toiture', c.surface_toit_m2 ? `${Number(c.surface_toit_m2).toLocaleString('fr-BE')} m²` : '')}
      ${row('Potentiel solaire', c.pv_max_kwh_an ? `${mwh(c.pv_max_kwh_an)} MWh/an` : '')}
    </dl>
    <p class="muted small">Estimations automatiques d’après l’activité et la toiture : des ordres de grandeur, pas des mesures.</p>
    <div class="pitch"><strong>Vous connaissez cette entreprise ?</strong><br>Une introduction ou un simple nom de contact nous aide à ouvrir la porte.</div>
    <button type="button" class="btn primary" id="cand-propose" style="margin-top:12px">Je connais quelqu’un ici</button>`;
  $('#cand-propose').addEventListener('click', () => startSuggestion({ name: c.nom, address: c.adresse, lat: c.lat, lng: c.lng }));
  openPanel();
}

// --- Liste et filtres --------------------------------------------------------

// Points convertis : retirés de la carte. Seule l'équipe peut les réafficher.
const showConverted = () => state.user.role === 'admin' && $('#show-converted').checked;

function matches(lead, q) {
  if (lead.convertedAt && !showConverted()) return false;
  if (!q) return true;
  const hay = [lead.name, lead.address, lead.municipality, lead.companies, lead.owner].join(' ').toLowerCase();
  return hay.includes(q);
}

function applyFilters() {
  const q = $('#search').value.trim().toLowerCase();
  const showMembers = $('#show-members').checked;
  const showSugg = $('#show-suggestions').checked;
  const visible = state.leads
    .filter((l) => matches(l, q))
    .sort((a, b) => shortName(a).localeCompare(shortName(b), 'fr'));

  for (const lead of state.leads) {
    const m = state.markers.get(lead.id);
    if (m) (visible.includes(lead) ? m.show() : m.hide());
  }
  state.memberMarkers.forEach((m) => (showMembers ? m.show() : m.hide()));
  const showDossiers = $('#show-dossiers').checked;
  state.dossierMarkers.forEach((m) => (showDossiers ? m.show() : m.hide()));
  const visibleSugg = state.suggestions.filter((s) => showSugg
    && (!isClosed(s) || showConverted())
    && (!q || s.place_name.toLowerCase().includes(q)));
  state.suggestions.forEach((s) => {
    const m = state.suggMarkers.get(s.id);
    if (m) (visibleSugg.includes(s) ? m.show() : m.hide());
  });

  const list = $('#lead-list');
  list.innerHTML = '';
  for (const lead of visible) {
    const li = document.createElement('li');
    li.className = lead.id === state.selectedId ? 'active' : '';
    const mine = state.mine.some((c) => c.lead_id === lead.id);
    li.innerHTML = `
      <i class="dot lead"></i>
      <div>
        <strong>${esc(shortName(lead))}</strong>
        <small>${lead.convertedAt ? 'Converti · ' : ''}${esc(lead.municipality)}</small>
      </div>
      ${mine ? '<span class="badge mine" title="Vous avez déjà proposé un contact">✓</span>'
        : lead.contributionCount ? `<span class="badge" title="Contacts déjà proposés">${lead.contributionCount}</span>` : ''}`;
    li.addEventListener('click', () => select(lead.id));
    list.appendChild(li);
  }
  if (visibleSugg.length) {
    list.insertAdjacentHTML('beforeend', `<li class="list-title">${state.user.role === 'admin' ? 'Lieux proposés' : 'Vos lieux proposés'}</li>`);
    for (const s of visibleSugg) {
      const li = document.createElement('li');
      li.className = s.id === state.selectedId ? 'active' : '';
      li.innerHTML = `<i class="dot sugg"></i><div><strong>${esc(s.place_name)}</strong>
        <small>${esc(s.follow_up)}${state.user.role === 'admin' ? ` · par ${esc(s.author_name)}` : ''}</small></div>`;
      li.addEventListener('click', () => selectSuggestion(s.id));
      list.appendChild(li);
    }
  }
  if (!visible.length && !visibleSugg.length) list.innerHTML = '<li class="empty">Aucun résultat.</li>';
}

$('#search').addEventListener('input', applyFilters);
document.querySelectorAll('.filters input').forEach((i) => i.addEventListener('change', applyFilters));

// --- Sélection ---------------------------------------------------------------

function clearSelection() {
  if (state.candSelected) { state.candMarkers.get(state.candSelected)?.setHtml(candHtml(false)); state.candSelected = null; }
  const lead = state.leads.find((l) => l.id === state.selectedId);
  if (lead) state.markers.get(lead.id)?.setHtml(leadHtml(lead, false));
  const s = state.suggestions.find((x) => x.id === state.selectedId);
  if (s) state.suggMarkers.get(s.id)?.setHtml(suggHtml(s, false));
  state.selectedId = null;
}

function select(id) {
  cancelDraft();
  clearSelection();
  state.selectedId = id;
  const lead = state.leads.find((l) => l.id === id);
  state.markers.get(id)?.setHtml(leadHtml(lead, true));
  state.map.flyTo(lead.lat, lead.lng, 14);
  renderPanel(lead);
  applyFilters();
}

function selectSuggestion(id) {
  cancelDraft();
  clearSelection();
  state.selectedId = id;
  const s = state.suggestions.find((x) => x.id === id);
  state.suggMarkers.get(id)?.setHtml(suggHtml(s, true));
  state.map.flyTo(s.lat, s.lng, 15);
  $('#panel-body').innerHTML = `
    <div class="panel-head">
      <span class="tag sugg">Lieu proposé</span>
      <span class="tag">${esc(s.follow_up)}</span>
      <h2>${esc(s.place_name)}</h2>
      ${s.address ? `<p class="muted">${esc(s.address)}</p>` : ''}
    </div>
    ${s.reason ? `<p class="pitch">${esc(s.reason)}</p>` : ''}
    <dl>
      ${row('Proposé par', s.author_name)}
      ${row('Le', new Date(s.created_at).toLocaleDateString('fr-BE'))}
      ${row('Contact sur place', s.has_contact ? [s.contact_name, s.contact_function].filter(Boolean).join(', ') : 'Pas de contact')}
      ${s.has_contact ? row('Coordonnées', [s.contact_email, s.contact_phone].filter(Boolean).join(' · ')) : ''}
      ${s.has_contact ? row('Lien', s.relation) : ''}
      ${row('Type de bâtiment', s.building_type)}
      ${row('Région', s.region)}
      ${row('Panneaux solaires', [s.has_pv, s.pv_kwp != null ? `${fmt(s.pv_kwp)} kWc` : null].filter(Boolean).join(' · '))}
      ${energyRowsHtml(s)}
      ${row('Facture', s.invoice_path ? 'Transmise à l’équipe RaYSun' : s.invoice_uploaded_at ? 'Supprimée (conservée 10 jours)' : null)}
    </dl>
    ${s.invoice_path && state.user.role === 'admin' ? '<button type="button" class="btn secondary" id="open-invoice">📄 Voir la facture</button>' : ''}
    ${s.team_notes && state.user.role === 'admin' ? `<div class="status"><strong>Notes équipe</strong><p>${esc(s.team_notes)}</p></div>` : ''}
    <p class="muted small">L’équipe CityWatt suit ce lieu. Le statut évolue au fil de la prospection.</p>
    ${adminConvertBlock(s.follow_up === 'Converti', 'Converti : retirer de la carte', 'Remettre sur la carte', 'convert-sugg',
      '<button type="button" class="btn secondary" id="promote-sugg">Transformer en immeuble</button>')}`;
  $('#open-invoice')?.addEventListener('click', () => openInvoice(s.invoice_path));
  $('#promote-sugg')?.addEventListener('click', () => startLeadForm(null, {
    name: s.place_name, address: s.address, lat: s.lat, lng: s.lng, pitch: s.reason, fromSuggestion: s.id,
  }));
  $('#convert-sugg')?.addEventListener('click', async () => {
    const convert = s.follow_up !== 'Converti';
    const followUp = convert ? 'Converti' : 'Retenu';
    const { error } = await sb.from('amb_suggestions').update({ follow_up: followUp }).eq('id', s.id);
    if (error) { console.error(error); alert('Modification non enregistrée.'); return; }
    s.follow_up = followUp;
    afterConvert(() => selectSuggestion(s.id), convert);
  });
  openPanel();
  applyFilters();
}

function row(label, value) {
  if (value == null || value === '') return '';
  return `<div class="kv"><dt>${esc(label)}</dt><dd>${typeof value === 'number' ? fmt(value) : esc(value)}</dd></div>`;
}

function adminConvertBlock(isConverted, convertLabel, restoreLabel, id, extraButton = '') {
  if (state.user.role !== 'admin') return '';
  return `<div class="admin-actions"><strong>Équipe</strong>
    ${isConverted ? '<p class="muted small">Converti : masqué sur la carte des actionnaires et ambassadeurs.</p>' : ''}
    <div class="admin-buttons">${extraButton}
    <button type="button" class="btn secondary" id="${id}">${isConverted ? restoreLabel : convertLabel}</button></div></div>`;
}

// Après conversion, le point disparaît : on ferme la fiche (sauf si l'équipe affiche les convertis).
function afterConvert(reopen, converted) {
  if (converted && !showConverted()) {
    $('#panel').hidden = true;
    clearSelection();
    applyFilters();
  } else {
    reopen();
  }
}

function openPanel() {
  $('#panel').hidden = false;
  $('#panel').scrollTop = 0;
}

function renderPanel(lead) {
  const mine = state.mine.filter((c) => c.lead_id === lead.id);
  $('#panel-body').innerHTML = `
    <div class="panel-head">
      <h2>${esc(lead.name)}</h2>
      <p class="muted">${esc(lead.address)}, ${esc(lead.municipality)}</p>
    </div>
    <p class="pitch">${esc(lead.pitch)}</p>
    <dl>
      ${row('Société(s) identifiée(s)', lead.companies)}
      ${row('Propriétaire / gestionnaire', lead.owner)}
      ${row('Rôle visé dans CityWatt', lead.role)}
      ${row('Fonction à viser', lead.targetFunction)}
      ${row('Solaire (kWc)', lead.solarKwp)}
      ${row('Production estimée (MWh/an)', lead.productionMwh)}
      ${row('Consommation — borne basse (MWh/an)', lead.consumptionMwh)}
    </dl>
    ${lead.status ? `<div class="status"><strong>Où nous en sommes</strong><p>${esc(lead.status)}</p></div>` : ''}
    ${lead.contributionCount ? `<p class="muted small">${lead.contributionCount} proposition(s) déjà reçue(s) pour cet immeuble.</p>` : ''}
    ${mine.length ? `<div class="mine-list"><strong>Vos propositions</strong><ul>${mine.map((c) =>
      `<li>${esc(c.contact_name || 'Données du bâtiment')} — ${MODE_LABELS[c.mode]}${c.invoice_path ? ' · facture jointe' : ''}</li>`).join('')}</ul></div>` : ''}
    ${adminConvertBlock(lead.convertedAt,
      'Converti : retirer de la carte', 'Remettre sur la carte', 'convert-lead',
      '<button type="button" class="btn secondary" id="edit-lead">Modifier l’immeuble</button>')}
    <div id="form-slot"></div>`;
  $('#edit-lead')?.addEventListener('click', () => startLeadForm(lead));
  $('#convert-lead')?.addEventListener('click', async () => {
    const convert = !lead.convertedAt;
    if (convert && !confirm('Marquer cet immeuble comme converti ? Il disparaît de la carte pour les actionnaires et ambassadeurs.')) return;
    const { error } = await sb.rpc('amb_set_lead_converted', { p_id: lead.id, p_converted: convert });
    if (error) { console.error(error); alert('Modification non enregistrée.'); return; }
    lead.convertedAt = convert ? new Date().toISOString() : null;
    afterConvert(() => select(lead.id), convert);
  });
  mountForm(lead);
  openPanel();
}

// --- Données énergie et dernière facture (fiche immeuble et « Proposer un lieu ») -------

const INVOICE_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };

function mountEnergy(form) {
  const block = $('#energy-template').content.firstElementChild.cloneNode(true);
  $('.energy-slot', form).replaceWith(block);
  const f = form.elements;
  f.invoice.addEventListener('change', () => { $('.invoice-confirm', block).hidden = !f.invoice.files.length; });
}

// Colonnes communes à amb_contributions et amb_suggestions ; `filled` : au moins une donnée saisie.
function readEnergy(form) {
  const f = form.elements;
  const num = (v) => (v === '' ? null : Number(v));
  const text = (v) => v.trim() || null;
  const cols = {
    consumption_mwh: num(f.consumptionMwh.value),
    injection_mwh: num(f.injectionMwh.value),
    supplier: text(f.supplier.value),
    offtake_formula: f.offtakeFormula.value || null,
    offtake_bihoraire: f.offtakeBihoraire.checked,
    offtake_detail: text(f.offtakeDetail.value),
    injection_formula: f.injectionFormula.value || null,
    injection_detail: text(f.injectionDetail.value),
  };
  const filled = Object.values(cols).some((v) => v != null && v !== false);
  return { cols, filled, file: f.invoice.files[0] || null };
}

// Vérifie la facture puis la dépose dans le dossier de l'auteur (lisible par l'équipe seulement).
// Renvoie son chemin, ou lève une erreur au message lisible.
async function uploadInvoice(form, file) {
  if (!file) return null;
  const ext = file.name.split('.').pop().toLowerCase();
  const type = file.type || INVOICE_TYPES[ext] || '';
  if (!Object.values(INVOICE_TYPES).includes(type)) throw new Error('La facture doit être un PDF ou une photo (JPG, PNG, HEIC).');
  if (file.size > 10 * 1024 * 1024) throw new Error('La facture dépasse 10 Mo.');
  if (!form.elements.invoiceRecent.checked) throw new Error('Confirmez que la facture date de moins de 3 mois.');
  const cleanExt = Object.keys(INVOICE_TYPES).find((k) => INVOICE_TYPES[k] === type);
  const path = `${state.user.id}/${crypto.randomUUID()}.${cleanExt}`;
  const { error } = await sb.storage.from('amb-invoices').upload(path, file, { contentType: type });
  if (error) { console.error(error); throw new Error('L’envoi de la facture a échoué. Réessayez.'); }
  return path;
}

function energyRowsHtml(r) {
  const formula = (f, detail, bi) => [f, bi ? 'bi-horaire' : null, detail].filter(Boolean).join(' · ');
  return row('Consommation (MWh/an)', r.consumption_mwh) + row('Injection (MWh/an)', r.injection_mwh)
    + row('Fournisseur', r.supplier)
    + row('Formule de prélèvement', formula(r.offtake_formula, r.offtake_detail, r.offtake_bihoraire))
    + row('Formule d’injection', formula(r.injection_formula, r.injection_detail));
}

// Lien temporaire (2 min) vers une facture : seule l'équipe y a droit (règles du stockage).
async function openInvoice(path) {
  const win = window.open('', '_blank'); // ouvert tout de suite pour ne pas être bloqué comme pop-up
  const { data, error } = await sb.storage.from('amb-invoices').createSignedUrl(path, 120);
  if (error) { win?.close(); alert('Facture introuvable (elle est supprimée après 10 jours).'); return; }
  if (win) win.location = data.signedUrl; else location.href = data.signedUrl;
}

const MODE_LABELS = { intro: 'introduction', contact: 'contact transmis', data: 'données transmises' };

function mountForm(lead) {
  const form = $('#form-template').content.firstElementChild.cloneNode(true);
  mountEnergy(form);
  const fields = $('.fields', form);
  const setMode = (mode) => {
    fields.hidden = false;
    form.dataset.mode = mode;
    form.elements.contactName.required = mode !== 'data';
    form.querySelectorAll('.path').forEach((p) => p.classList.toggle('checked', $('input', p).checked));
  };
  form.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => setMode(r.value)));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const v = Object.fromEntries(fd.entries());
    const err = $('.error', form);
    err.textContent = '';
    const isData = v.mode === 'data';
    const energy = readEnergy(form);
    const row = {
      lead_id: lead.id,
      mode: v.mode,
      contact_name: isData ? null : v.contactName.trim(),
      contact_function: isData ? null : v.contactFunction || null,
      contact_company: isData ? null : v.contactCompany || null,
      contact_email: v.mode === 'contact' ? v.contactEmail || null : null,
      contact_phone: v.mode === 'contact' ? v.contactPhone || null : null,
      relation: isData ? null : v.relation || null,
      strength: isData ? null : v.strength || null,
      mention_name: v.mode === 'contact' ? fd.has('mentionName') : true,
      when_text: v.mode === 'intro' ? v.when || null : null,
      remarks: v.remarks || null,
      ...energy.cols,
    };
    if (v.mode === 'contact' && !row.contact_email && !row.contact_phone) {
      err.textContent = 'Indiquez au moins un email ou un téléphone pour ce contact.';
      return;
    }
    if (isData && !energy.filled && !energy.file) {
      err.textContent = 'Indiquez au moins une donnée (consommation, injection, prix…) ou joignez la dernière facture.';
      return;
    }
    const submit = $('button[type=submit]', form);
    submit.disabled = true;
    try {
      row.invoice_path = await uploadInvoice(form, energy.file);
    } catch (ex) {
      err.textContent = ex.message;
      submit.disabled = false;
      return;
    }
    const { data: saved, error } = await sb.from('amb_contributions').insert(row).select().single();
    submit.disabled = false;
    if (error) {
      err.textContent = 'L’envoi a échoué. Réessayez, ou écrivez-nous directement.';
      console.error(error);
      return;
    }
    state.mine.push(saved);
    lead.contributionCount = (lead.contributionCount || 0) + 1;
    renderPanel(lead);
    applyFilters();
    const thanks = {
      intro: 'Nous revenons vers vous pour préparer l’introduction.',
      contact: 'Nous prenons contact et vous tenons au courant.',
      data: 'Les données sont transmises à l’équipe RaYSun.',
    }[v.mode];
    $('#form-slot').insertAdjacentHTML('afterbegin',
      `<div class="success">Merci ! ${thanks} Vous pouvez ajouter autre chose ci-dessous.</div>`);
  });
  $('#form-slot').appendChild(form);
}

$('#panel-close').addEventListener('click', () => {
  $('#panel').hidden = true;
  cancelDraft();
  clearSelection();
  applyFilters();
});

// --- Proposer un lieu (bouton « + ») -----------------------------------------------

function draftHtml(kind) {
  return kind === 'lead'
    ? '<div class="pin lead selected"></div><span class="mk-label right">Emplacement de l’immeuble</span>'
    : '<div class="pin sugg selected">+</div><span class="mk-label right">Nouveau lieu</span>';
}

function placeDraft(lat, lng) {
  state.draft?.marker.hide();
  const kind = $('#place-form')?.dataset.kind;
  state.draft = { lat, lng, marker: state.map.addMarker({ lat, lng, html: draftHtml(kind), zIndex: 30 }) };
  state.draft.marker.show();
  const form = $('#place-form');
  if (form) {
    form.querySelector('.where').textContent = 'Point placé sur la carte. Cliquez ailleurs pour le déplacer.';
    form.querySelector('.where').classList.remove('error');
  }
}

function cancelDraft() {
  if (!state.draft && !document.body.classList.contains('placing')) return;
  state.draft?.marker.hide();
  state.draft = null;
  state.map.onMapClick(null);
  document.body.classList.remove('placing');
}

function startSuggestion(prefill) {
  clearSelection();
  applyFilters();
  document.body.classList.add('placing');
  state.map.onMapClick(placeDraft);

  const form = $('#sugg-template').content.firstElementChild.cloneNode(true);
  form.id = 'place-form';
  mountEnergy(form);
  const f = form.elements;
  $('#panel-body').innerHTML = '';
  $('#panel-body').appendChild(form);
  openPanel();

  const contactFields = $('.contact-fields', form);
  f.hasContact.forEach((r) => r.addEventListener('change', () => {
    contactFields.hidden = f.hasContact.value !== 'yes';
    form.querySelectorAll('.path').forEach((p) => p.classList.toggle('checked', $('input', p).checked));
  }));

  wireLocate(form, () => [f.address.value, f.placeName.value], f.address);
  // Depuis une entreprise à démarcher : nom, adresse et position déjà connus.
  if (prefill && prefill.lat != null) {
    f.placeName.value = prefill.name || '';
    f.address.value = prefill.address || '';
    placeDraft(prefill.lat, prefill.lng);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.error', form);
    err.textContent = '';
    if (!state.draft) { err.textContent = 'Placez le lieu sur la carte (clic sur la carte ou bouton « Localiser »).'; return; }
    const hasContact = f.hasContact.value === 'yes';
    const energy = readEnergy(form);
    const row = {
      place_name: f.placeName.value.trim(),
      address: f.address.value.trim() || null,
      lat: state.draft.lat,
      lng: state.draft.lng,
      reason: f.reason.value.trim() || null,
      has_contact: hasContact,
      contact_name: hasContact ? f.contactName.value.trim() || null : null,
      contact_function: hasContact ? f.contactFunction.value.trim() || null : null,
      contact_email: hasContact ? f.contactEmail.value.trim() || null : null,
      contact_phone: hasContact ? f.contactPhone.value.trim() || null : null,
      relation: hasContact ? f.relation.value.trim() || null : null,
      building_type: f.buildingType.value || null,
      region: f.region.value || null,
      has_pv: f.hasPv.value || null,
      pv_kwp: f.pvKwp.value === '' ? null : Number(f.pvKwp.value),
      ...energy.cols,
    };
    if (hasContact && !row.contact_name) { err.textContent = 'Indiquez le nom de votre contact.'; return; }
    const submit = $('button[type=submit]', form);
    submit.disabled = true;
    try {
      row.invoice_path = await uploadInvoice(form, energy.file);
    } catch (ex) {
      err.textContent = ex.message;
      submit.disabled = false;
      return;
    }
    const { data: saved, error } = await sb.from('amb_suggestions').insert(row).select().single();
    submit.disabled = false;
    if (error) { console.error(error); err.textContent = 'L’envoi a échoué. Réessayez dans un instant.'; return; }
    cancelDraft();
    state.suggestions.push(saved);
    addSuggestionMarker(saved);
    $('#show-suggestions').checked = true;
    selectSuggestion(saved.id);
    $('#panel-body').insertAdjacentHTML('afterbegin',
      '<div class="success">Merci ! Le lieu est transmis à l’équipe CityWatt.</div>');
  });
}

$('#add-place').addEventListener('click', startSuggestion);

// Bouton « Localiser » : cherche l'adresse et place le point ; sinon clic sur la carte.
function wireLocate(form, parts, addressInput) {
  $('.locate', form).addEventListener('click', async () => {
    const q = parts().map((x) => x.trim()).filter(Boolean).join(', ');
    const where = $('.where', form);
    if (!q) { where.textContent = 'Indiquez d’abord une adresse ou un nom de lieu.'; where.classList.add('error'); return; }
    where.textContent = 'Recherche…';
    const hit = await state.map.geocode(`${q}, Belgique`);
    if (!hit) { where.textContent = 'Adresse introuvable : cliquez directement sur la carte.'; where.classList.add('error'); return; }
    placeDraft(hit.lat, hit.lng);
    state.map.flyTo(hit.lat, hit.lng, 16);
    if (!addressInput.value.trim()) addressInput.value = hit.address;
  });
}

// --- Immeubles : ajout et modification par l'équipe ----------------------------------

function slugify(text) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

const LEAD_FIELDS = [ // champ du formulaire, colonne amb_leads, clé dans state.leads
  ['name', 'name', 'name'], ['address', 'address', 'address'], ['municipality', 'municipality', 'municipality'],
  ['pitch', 'pitch', 'pitch'], ['companies', 'companies', 'companies'], ['owner', 'owner', 'owner'],
  ['targetRole', 'target_role', 'role'], ['targetFunction', 'target_function', 'targetFunction'],
  ['solarKwp', 'solar_kwp', 'solarKwp'],
];

// lead : immeuble à modifier (null pour un nouveau) ; prefill : valeurs de départ (lieu proposé transformé).
function startLeadForm(lead = null, prefill = {}) {
  clearSelection();
  applyFilters();
  document.body.classList.add('placing');
  state.map.onMapClick(placeDraft);

  const form = $('#lead-template').content.firstElementChild.cloneNode(true);
  form.id = 'place-form';
  form.dataset.kind = 'lead';
  const f = form.elements;
  $('#panel-body').innerHTML = '';
  $('#panel-body').appendChild(form);
  openPanel();

  const src = lead || prefill;
  for (const [input, , key] of LEAD_FIELDS) if (src[key] != null) f[input].value = src[key];
  if (src.wave) f.wave.value = String(src.wave);
  if (src.priority) f.priority.value = src.priority;
  if (src.productionMwh != null) f.productionMwh.value = src.productionMwh;
  if (src.consumptionMwh != null) f.consumptionMwh.value = src.consumptionMwh;
  if (src.status) f.status.value = src.status;
  if (lead) $('.form-title', form).textContent = 'Modifier l’immeuble';
  if (src.lat != null) { placeDraft(src.lat, src.lng); state.map.flyTo(src.lat, src.lng, 15); }

  wireLocate(form, () => [f.address.value, f.municipality.value, f.name.value], f.address);

  const del = $('.delete-lead', form);
  del.hidden = !lead;
  del.addEventListener('click', async () => {
    const n = lead.contributionCount ? ` et les ${lead.contributionCount} contact(s) proposé(s) pour lui` : '';
    if (!confirm(`Supprimer définitivement « ${lead.name} »${n} ? Pour le garder en historique, utilisez plutôt « Converti ».`)) return;
    const { error } = await sb.from('amb_leads').delete().eq('id', lead.id);
    if (error) { console.error(error); $('.error', form).textContent = 'Suppression impossible.'; return; }
    state.markers.get(lead.id)?.hide();
    state.markers.delete(lead.id);
    state.leads = state.leads.filter((l) => l !== lead);
    cancelDraft();
    $('#panel').hidden = true;
    applyFilters();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.error', form);
    err.textContent = '';
    if (!state.draft) { err.textContent = 'Placez l’immeuble sur la carte (clic sur la carte ou bouton « Localiser »).'; return; }
    const num = (v) => (v === '' ? null : Number(v));
    const row = {
      id: lead ? lead.id : `${slugify(f.name.value)}-${Math.random().toString(36).slice(2, 6)}`,
      wave: Number(f.wave.value),
      priority: f.priority.value,
      production_mwh: num(f.productionMwh.value),
      consumption_mwh: num(f.consumptionMwh.value),
      lat: state.draft.lat,
      lng: state.draft.lng,
      updated_at: new Date().toISOString(),
    };
    for (const [input, col] of LEAD_FIELDS) row[col] = f[input].value.trim() || null;
    const { error } = await sb.from('amb_leads').upsert(row);
    if (error) { console.error(error); err.textContent = 'Enregistrement impossible. Réessayez.'; return; }
    const status = f.status.value.trim() || null;
    const st = await sb.from('amb_lead_status').upsert({ lead_id: row.id, status });
    if (st.error) console.error(st.error);

    const saved = {
      ...(lead || { contributionCount: 0, convertedAt: null }),
      id: row.id, wave: row.wave, priority: row.priority, name: row.name, address: row.address,
      municipality: row.municipality, solarKwp: row.solar_kwp, productionMwh: row.production_mwh,
      companies: row.companies, consumptionMwh: row.consumption_mwh, role: row.target_role, owner: row.owner,
      pitch: row.pitch, targetFunction: row.target_function, lat: row.lat, lng: row.lng, status,
    };
    if (lead) {
      Object.assign(lead, saved);
      state.markers.get(lead.id)?.hide(); // position ou étiquette modifiée : on recrée le marqueur
    } else {
      state.leads.push(saved);
    }
    const target = lead || saved;
    state.markers.set(target.id, state.map.addMarker({
      lat: target.lat, lng: target.lng, html: leadHtml(target, false), title: target.name, zIndex: 10,
      onClick: () => select(target.id),
    }));
    if (prefill.fromSuggestion) await markSuggestionConverted(prefill.fromSuggestion);
    cancelDraft();
    select(target.id);
    $('#panel-body').insertAdjacentHTML('afterbegin', `<div class="success">Immeuble ${lead ? 'modifié' : 'ajouté'}.</div>`);
  });
}

async function markSuggestionConverted(id) {
  const s = state.suggestions.find((x) => x.id === id);
  const { error } = await sb.from('amb_suggestions').update({ follow_up: 'Converti' }).eq('id', id);
  if (error) { console.error(error); return; }
  if (s) s.follow_up = 'Converti';
}

$('#add-lead').addEventListener('click', () => startLeadForm());

// --- Session -----------------------------------------------------------------

async function loadData() {
  const [leads, status, counts, mine, sugg, members, settings] = await Promise.all([
    sb.from('amb_leads').select('*').is('archived_at', null),   // les immeubles archivés ne s'affichent plus
    sb.from('amb_lead_status').select('*'), // vide pour les ambassadeurs (règle RLS)
    sb.rpc('amb_lead_counts'),
    sb.from('amb_contributions').select('*').eq('author_id', state.user.id),
    sb.from('amb_suggestions').select('*').order('created_at'), // les siens, ou tous pour l'équipe (RLS)
    sb.rpc('amb_community_members'),
    sb.from('amb_settings').select('key, value'),
  ]);
  for (const r of [leads, status, counts, mine, sugg, members]) if (r.error) throw r.error;
  // Critères de ciblage : non bloquant si la table n'est pas lisible.
  const target = settings.data?.find((x) => x.key === 'target')?.value?.trim();
  $('#target-text').textContent = target || '';
  $('#target-box').hidden = !target;
  const statusById = new Map(status.data.map((s) => [s.lead_id, s.status]));
  const countById = new Map(counts.data.map((c) => [c.lead_id, Number(c.n)]));
  state.leads = leads.data.map((l) => ({
    id: l.id, wave: l.wave, priority: l.priority, name: l.name, address: l.address,
    municipality: l.municipality, solarKwp: l.solar_kwp, productionMwh: l.production_mwh,
    companies: l.companies, consumptionMwh: l.consumption_mwh, role: l.target_role, owner: l.owner,
    pitch: l.pitch, targetFunction: l.target_function, lat: l.lat, lng: l.lng, convertedAt: l.converted_at,
    status: statusById.get(l.id) || null,
    contributionCount: countById.get(l.id) || 0,
  }));
  state.mine = mine.data;
  state.suggestions = sugg.data;
  state.members = members.data;
  // Dossiers des apporteurs : l'équipe les voit tous, une société voit les siens (règles RLS) ; non bloquant.
  if (['admin', 'apporteur'].includes(state.user.role)) {
    const { data } = await sb.from('amb_dossiers').select('id, prospect, lat, lng, status').not('lat', 'is', null).neq('status', 'Clôturé');
    state.dossiers = data ?? [];
    $('#dossiers-filter').hidden = false;
    $('#dossiers-count').textContent = state.dossiers.length;
  }
  $('#members-count').textContent = state.members.length;
}

function showMessage(html) {
  $('#login').hidden = false;
  // Nouveau formulaire vierge : on se débarrasse des écouteurs du formulaire de connexion.
  const old = $('#login-form');
  const form = old.cloneNode(false);
  old.replaceWith(form);
  form.innerHTML = `<h1>CityWatt <span>Ambassadeurs</span></h1>${html}
    <button type="button" class="link" style="margin-top:12px" onclick="signOut()">Se déconnecter</button>`;
}

// Compte connecté mais pas (encore) autorisé : demande d'accès, validée à la main par l'équipe.
async function showAccessRequest(user) {
  const { data: req } = await sb.from('amb_access_requests').select('status').eq('user_id', user.id).maybeSingle();
  if (req?.status === 'pending') {
    return showMessage(`<p>Votre demande d’accès est bien reçue.</p>
      <p class="muted">L’équipe CityWatt la valide à la main. Vous recevrez une réponse rapidement ; revenez ensuite sur cette page.</p>`);
  }
  if (req?.status === 'rejected') {
    return showMessage('<p>Votre demande d’accès n’a pas été acceptée.</p><p class="muted">Pour en parler : eric.rw@raysun.solar</p>');
  }
  showMessage(`<p>Votre compte (${esc(user.email)}) n’a pas encore accès à l’espace ambassadeurs.</p>
    <p class="muted">Présentez-vous en quelques mots : l’équipe CityWatt valide chaque demande.</p>
    <label>Nom et prénom <input name="name" required></label>
    <label>Société / organisation <input name="company"></label>
    <label>Vous êtes
      <select name="requestedRole">
        <option value="ambassador">Ambassadeur (non-actionnaire)</option>
        <option value="shareholder">Actionnaire</option>
      </select>
    </label>
    <label>Comment connaissez-vous CityWatt ? <textarea name="message" rows="3"></textarea></label>
    <p class="error"></p>
    <button type="submit" class="btn primary">Demander l’accès</button>`);
  const form = $('#login-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    const { error } = await sb.from('amb_access_requests').insert({
      name: f.name.value.trim(),
      company: f.company.value.trim() || null,
      requested_role: f.requestedRole.value,
      message: f.message.value.trim() || null,
    });
    if (error) { console.error(error); $('.error', form).textContent = 'L’envoi a échoué. Réessayez dans un instant.'; return; }
    showAccessRequest(user);
  };
}

async function start() {
  const who = await currentMember();
  if (!who) { $('#login').hidden = false; return; }
  if (!who.member) return showAccessRequest(who.user);
  state.user = { id: who.user.id, ...who.member };
  $('#login').hidden = true;
  $('#user-name').textContent = state.user.name;
  $('#admin-link').hidden = state.user.role !== 'admin';
  $('#dossiers-link').hidden = !['admin', 'apporteur'].includes(state.user.role);
  $('#converted-filter').hidden = state.user.role !== 'admin';
  $('#add-lead').hidden = state.user.role !== 'admin';
  $('#tracker-link').hidden = state.user.role !== 'admin';
  const [map] = await Promise.all([createMap($('#map')), loadData()]);
  state.map = map;
  map.onZoom(updateLabels);
  map.onMove(() => refreshCandidates().catch(console.error));
  $('#show-candidates').addEventListener('change', () => refreshCandidates().catch(console.error));
  renderMarkers();
  updateLabels();
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith('lieu-')) {
    if (state.suggestions.some((s) => s.id === hash.slice(5))) selectSuggestion(hash.slice(5));
  } else if (hash && state.leads.some((l) => l.id === hash)) select(hash);
}

$('#logout').addEventListener('click', signOut);
wireLoginForm(() => start().catch(showError));

function showError(e) {
  console.error(e);
  showMessage('<p class="error">Impossible de charger les données. Réessayez dans un instant.</p>');
}

start().catch(showError);
