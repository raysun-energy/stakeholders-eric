const state = {
  user: null, map: null,
  leads: [], markers: new Map(), selectedId: null, mine: [],
  suggestions: [], suggMarkers: new Map(),
  members: [], memberMarkers: [],
  dossiers: [], dossierMarkers: [],
  search: null, candPin: null, // recherche d'entreprises en cours : { pt, filter, rows, done } et repère de l'entreprise montrée
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
  // Un clic sur un membre ouvre la recherche d'entreprises autour de lui.
  state.memberMarkers = state.members.map((m) => map.addMarker({
    lat: m.lat, lng: m.lng, zIndex: 1,
    html: '<div class="member-dot clickable"></div>',
    title: m.name ? `${m.name} — ${m.operation}` : `Membre — ${m.operation}`,
    onClick: () => openSearch({ kind: 'membre', name: m.name || 'Membre', operation: m.operation, lat: m.lat, lng: m.lng, id: m.id }),
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

// --- Entreprises à démarcher (outil Zoning as Community) ---------------------
// Elles ne sont pas affichées sur la carte : elles sortent en liste après une recherche autour d'un point
// (membre, lieu cliqué ou adresse), pour un rayon et des critères donnés.
const CAND_CATEGORIES = {
  bureaux: 'Bureaux', horeca: 'Horeca', logistique: 'Logistique', commerce: 'Commerce', industrie: 'Industrie',
  industrie_lourde: 'Industrie lourde', construction: 'Construction', sante: 'Santé', data_tech: 'Données et technologies',
  sport_loisirs: 'Sport et loisirs', enseignement: 'Enseignement', autre: 'Autre activité',
};
const mwh = (kwh) => Math.round(kwh / 1000).toLocaleString('fr-BE');

// Critères « gros consommateurs / gros producteurs potentiels », appliqués côté base (liste et export).
function candFilter(v = '') {
  return { p_min_conso_kwh: v === 'conso' || v === 'both' ? 100000 : 0, p_min_toit_m2: v === 'prod' || v === 'both' ? 500 : 0 };
}

// Export en bloc de toutes les entreprises à démarcher (CSV lisible par Excel), par pages de 1000.
async function exportCandidates(btn) {
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      btn.textContent = `Préparation… ${rows.length} entreprises`;
      const { data, error } = await sb.rpc('amb_candidates_export', { p_offset: offset, ...candFilter() });
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Nom', 'Adresse', 'Région', 'Activité', 'Conso min (MWh/an)', 'Conso max (MWh/an)', 'Toiture (m²)', 'Potentiel solaire (MWh/an)', 'Téléphone', 'E-mail', 'Site web', 'Latitude', 'Longitude'];
    const lines = rows.map((c) => [c.nom, c.adresse, c.region, CAND_CATEGORIES[c.categorie] || c.categorie,
      c.conso_min_kwh != null ? Math.round(c.conso_min_kwh / 1000) : '', c.conso_max_kwh != null ? Math.round(c.conso_max_kwh / 1000) : '',
      c.surface_toit_m2, c.pv_max_kwh_an != null ? Math.round(c.pv_max_kwh_an / 1000) : '', c.telephone, c.email, c.site_web, c.lat, c.lng].map(cell).join(';'));
    const blob = new Blob(['\ufeff' + [head.map(cell).join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `entreprises-a-demarcher-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    console.error(e);
    $('#cand-export-msg').textContent = 'L’export a échoué. Réessayez dans un instant.';
  }
  btn.disabled = false; btn.textContent = label;
}

// --- Zonings : contours dessinés pour la zone affichée, à partir d'un certain zoom ---
const ZONING_ZOOM = 11;
let zoningSeq = 0;
async function refreshZonings() {
  if (!$('#show-zonings').checked || state.map.getZoom() < ZONING_ZOOM) { state.map.setShapes([]); return; }
  const b = state.map.getBounds();
  if (!b) return;
  const n = ++zoningSeq;
  const { data, error } = await sb.rpc('amb_zonings', { p_min_lat: b.minLat, p_max_lat: b.maxLat, p_min_lng: b.minLng, p_max_lng: b.maxLng });
  if (n !== zoningSeq) return;
  if (error) { console.error(error); return; }
  state.map.setShapes(data.map((z) => ({ id: z.id, name: z.nom, geometry: z.geometry })));
}

// --- Équipe : mise à jour des zonings depuis les géoportails régionaux ---
// Même import que l'ancien outil Zoning as Community (fonction zc-import-zonings, côté serveur) : pour chaque Région,
// les zonings existants sont remplacés par la version actuelle du géoportail, page par page.
const ZC_IMPORT_URL = 'https://meek-florentine-28add5.netlify.app/.netlify/functions/zc-import-zonings';
const ZONING_SOURCES = [
  { region: 'Wallonie', type: 'arcgis', url: 'https://geoservices.wallonie.be/arcgis/rest/services/AMENAGEMENT_TERRITOIRE/PRE/MapServer/0', where: "NATURE='PRE'", champ_nom: 'LIBELLE', champ_gestionnaire: 'CODESERVICE', nom_defaut: 'Périmètre de reconnaissance économique' },
  { region: 'Flandre', type: 'wfs', url: 'https://geo.api.vlaanderen.be/Bedrijventerreinen/wfs?typeNames=Bedrijventerreinen:Bedrter', champ_nom: '', champ_gestionnaire: '', nom_defaut: 'Bedrijventerrein' },
  { region: 'Bruxelles', type: 'wfs', url: 'https://gis.urban.brussels/geoserver/ows?typeNames=PERSPECTIVE_FR:PRDD_A10_C5_PRAS_ZIU',
    cql: "NAME_FR ILIKE '%industri%' OR NAME_FR ILIKE '%entreprise%' OR NAME_FR ILIKE '%portuaire%' OR NAME_FR ILIKE '%transport%'",
    champ_nom: 'NAME_FR', champ_gestionnaire: '', nom_defaut: 'Zone économique (PRAS)' },
];
async function importZonings(btn) {
  const msg = $('#zoning-import-msg');
  if (!confirm('Mettre à jour les zonings depuis les géoportails ?\n\nPour chaque Région, les zonings actuels sont remplacés par la version en ligne du géoportail. Compter une à deux minutes.')) return;
  btn.disabled = true;
  const bilan = [];
  try {
    const { data: { session } } = await sb.auth.getSession();
    for (const src of ZONING_SOURCES) {
      let offset = 0, total = 0, reset = true, erreur = null;
      for (let page = 0; page < 200; page++) {
        msg.textContent = `${src.region} : ${total} zonings…`;
        try {
          const res = await fetch(ZC_IMPORT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify({ ...src, offset, taille: 300, reset }),
          });
          const r = await res.json().catch(() => ({}));
          if (!res.ok || !r.ok) throw new Error(r.error || `Erreur ${res.status}`);
          total += r.importes; offset = r.offset; reset = false;
          if (!r.suite || !r.importes) break;
        } catch (e) { erreur = e.message; break; }
      }
      bilan.push(`${src.region} : ${erreur ? `erreur (${erreur})${total ? `, ${total} zonings importés avant` : ''}` : `${total} zonings`}`);
    }
  } catch (e) { console.error(e); bilan.push(`Import interrompu : ${e.message}`); }
  msg.textContent = `Mise à jour terminée.\n${bilan.join('\n')}`;
  btn.disabled = false;
  refreshZonings().catch(console.error);
}

// --- Recherche d'entreprises autour d'un point ---
// 1. zc-voisins (outil Zoning as Community, côté serveur) cherche dans la BCE les entreprises du rayon et estime leur
//    consommation. Pour l'équipe, il analyse aussi les toitures des plus prometteuses (Google Solar, payant).
// 2. La liste est relue dans la base (amb_candidates_around) : entreprises pas encore suivies par RaYSun.
const ZC_VOISINS_URL = 'https://meek-florentine-28add5.netlify.app/.netlify/functions/zc-voisins';
const ZC_ODOO_URL = 'https://meek-florentine-28add5.netlify.app/.netlify/functions/zc-opportunite';
const SEARCH_TAGS = { membre: ['Membre', '#E3F2E9;color:#1E7F4E'], adresse: ['Adresse', '#FBEBDB;color:#9A5415'], point: ['Point sur la carte', '#FBEBDB;color:#9A5415'] };

async function zcCall(url, body) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || `Erreur ${res.status}`);
  return j;
}

function clearRadius() {
  state.search = null;
  state.candPin?.hide(); state.candPin = null;
  state.map.setCircle(null);
}

function openSearch(pt) {
  cancelDraft();
  clearSelection();
  clearRadius();
  state.search = { pt, rows: [], done: false };
  const team = state.user.role === 'admin';
  const [tag, color] = SEARCH_TAGS[pt.kind] || SEARCH_TAGS.point;
  $('#panel-body').innerHTML = `
    <div class="panel-head">
      <span class="tag" style="background:${color}">${tag}</span>
      <h2>${esc(pt.name)}</h2>
      <p class="muted">${esc(pt.operation || '')}</p>
    </div>
    <div class="admin-actions"><strong>Chercher des entreprises autour de ce point</strong>
      <div class="search-fields">
        <label class="small">Rayon
          <select id="member-radius"><option value="500">500 m</option><option value="1000" selected>1 km</option><option value="2000">2 km</option><option value="5000">5 km</option></select>
        </label>
        <label class="small">Critère
          <select id="cand-filter">
            <option value="">Toutes les entreprises</option>
            <option value="conso">Gros consommateurs (100 MWh/an et plus)</option>
            <option value="prod">Gros producteurs potentiels (toiture de 500 m² et plus)</option>
            <option value="both">Les deux</option>
          </select>
        </label>
      </div>
      <div class="admin-buttons" style="margin-top:10px"><button type="button" class="btn primary" id="member-search">Chercher les entreprises</button></div>
      <p class="muted small" style="margin:8px 0 0">${team ? 'Équipe : la recherche analyse aussi les toitures des entreprises les plus prometteuses. Compter 10 à 30 secondes et quelques centimes d’API Google par recherche.' : state.user.role === 'apporteur' ? 'La recherche analyse aussi les toitures des entreprises les plus prometteuses. Compter 10 à 30 secondes.' : 'La recherche prend quelques secondes.'}</p>
      <p class="small" id="member-search-msg" style="margin:8px 0 0"></p>
    </div>
    <div id="cand-results"></div>`;
  const radius = () => Number($('#member-radius').value);
  const drawRadius = () => state.map.setCircle({ lat: pt.lat, lng: pt.lng, radius: radius() });
  const msg = $('#member-search-msg');

  // Relit la liste dans la base, pour le rayon et le critère choisis.
  const list = async () => {
    const { data, error } = await sb.rpc('amb_candidates_around', { p_lat: pt.lat, p_lng: pt.lng, p_radius_m: radius(), ...candFilter($('#cand-filter').value) });
    if (error) throw error;
    state.search.rows = data ?? [];
    renderCandList();
  };
  $('#member-radius').addEventListener('change', () => { drawRadius(); state.search.done = false; $('#cand-results').innerHTML = ''; msg.textContent = ''; });
  $('#cand-filter').addEventListener('change', () => { if (state.search.done) list().catch((e) => { console.error(e); msg.className = 'small error'; msg.textContent = 'La liste ne peut pas être chargée pour le moment.'; }); });
  $('#member-search').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; msg.className = 'small muted'; msg.textContent = 'Recherche en cours…';
    let warn = '';
    try {
      await zcCall(ZC_VOISINS_URL, { lat: pt.lat, lng: pt.lng, rayon_m: radius(), membre_id: pt.id ?? null, source: 'bce' });
    } catch (err) {
      console.error(err);
      warn = ` La recherche de nouvelles entreprises a échoué${team ? ' (' + err.message + ')' : ''} ; voici celles déjà connues dans ce rayon.`;
    }
    try {
      await list();
      state.search.done = true;
      msg.className = warn ? 'small error' : 'small'; msg.textContent = warn.trim();
    } catch (err) {
      console.error(err);
      msg.className = 'small error'; msg.textContent = 'La liste ne peut pas être chargée pour le moment.';
    }
    btn.disabled = false;
  });
  openPanel();
  drawRadius();
}

function candCardHtml(c) {
  const team = state.user.role === 'admin';
  const tel = (v) => `<a href="tel:${esc(v.replace(/[^+\d]/g, ''))}">${esc(v)}</a>`;
  const mail = (v) => `<a href="mailto:${esc(v)}">${esc(v)}</a>`;
  const site = c.site_web ? (/^https?:\/\//i.test(c.site_web) ? c.site_web : `https://${c.site_web}`) : '';
  const conso = c.conso_max_kwh ? `${c.conso_min_kwh ? mwh(c.conso_min_kwh) + ' à ' : 'jusqu’à '}${mwh(c.conso_max_kwh)} MWh/an` : '';
  const facts = [CAND_CATEGORIES[c.categorie] || c.categorie, conso && `Consommation estimée : ${conso}`,
    c.surface_toit_m2 && `Toiture : ${Number(c.surface_toit_m2).toLocaleString('fr-BE')} m²`,
    c.pv_max_kwh_an && `Potentiel solaire : ${mwh(c.pv_max_kwh_an)} MWh/an`].filter(Boolean).map(esc).join(' · ');
  const coords = [c.telephone && tel(c.telephone), c.email && mail(c.email),
    site && `<a href="${esc(site)}" target="_blank" rel="noopener">${esc(site.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`].filter(Boolean).join(' · ');
  const contact = c.contact_nom || c.contact_tel || c.contact_email
    ? [esc([c.contact_nom, c.contact_fonction].filter(Boolean).join(', ')), c.contact_tel && tel(c.contact_tel), c.contact_email && mail(c.contact_email)].filter(Boolean).join(' · ') : '';
  const callTo = c.contact_tel || c.telephone, mailTo = c.contact_email || c.email;
  return `<article class="cand-card" data-id="${esc(c.id)}">
    <h3><button type="button" class="cand-name" data-locate title="Montrer sur la carte">${esc(c.nom)}</button></h3>
    <p class="muted small">${esc(c.adresse)} · à ${c.distance_m >= 1000 ? (c.distance_m / 1000).toLocaleString('fr-BE', { maximumFractionDigits: 1 }) + ' km' : c.distance_m + ' m'}</p>
    ${facts ? `<p class="small">${facts}</p>` : ''}
    <p class="small">${coords || '<span class="muted">Pas de téléphone ni d’e-mail connus.</span>'}</p>
    ${contact ? `<p class="small"><strong>Personne de contact :</strong> ${contact}</p>` : ''}
    ${c.perdu_le ? `<p class="small" style="background:#FBE4E0;border-radius:10px;padding:6px 10px"><strong>Déjà tenté :</strong> un autre apporteur a travaillé ce prospect sans succès. Dossier classé perdu le ${new Date(c.perdu_le).toLocaleDateString('fr-BE', { day: 'numeric', month: 'long', year: 'numeric' })}.</p>` : ''}
    <div class="cand-actions">
      ${callTo ? `<a class="btn secondary" href="tel:${esc(callTo.replace(/[^+\d]/g, ''))}">Appeler</a>` : ''}
      ${mailTo ? `<a class="btn secondary" href="mailto:${esc(mailTo)}">E-mail</a>` : ''}
      <button type="button" class="btn primary" data-odoo>${state.user.role === 'apporteur' ? 'Créer la fiche Odoo + ajouter à mes dossiers' : 'Créer la fiche Odoo'}</button>
      <button type="button" class="btn secondary" data-know>Je connais quelqu’un ici</button>
    </div>
    ${team ? `<details class="cand-contact"><summary>Équipe : personne de contact</summary>
      <form data-contact>
        <input name="nom" placeholder="Nom" value="${esc(c.contact_nom || '')}">
        <input name="fonction" placeholder="Fonction (responsable énergie…)" value="${esc(c.contact_fonction || '')}">
        <input name="tel" placeholder="Téléphone" value="${esc(c.contact_tel || '')}">
        <input name="email" type="email" placeholder="E-mail" value="${esc(c.contact_email || '')}">
        <button type="submit" class="btn secondary">Enregistrer</button>
      </form></details>` : ''}
    <p class="small" data-msg></p>
  </article>`;
}

function renderCandList() {
  const box = $('#cand-results');
  if (!box || !state.search) return;
  const rows = state.search.rows;
  const total = rows.length ? Number(rows[0].total) : 0;
  box.innerHTML = `<p class="small" style="margin:12px 0 8px"><strong>${!total ? 'Aucune entreprise ne correspond dans ce rayon.'
    : total > rows.length ? `${rows.length} entreprises affichées sur ${total} (les plus grands sites). Réduisez le rayon ou ajoutez un critère pour voir les autres.`
      : `${total} entreprise${total > 1 ? 's' : ''} dans ce rayon.`}</strong></p>
    ${total ? '<p class="muted small" style="margin:0 0 8px">Estimations automatiques d’après l’activité et la toiture : des ordres de grandeur, pas des mesures.</p>' : ''}
    ${rows.map(candCardHtml).join('')}`;
  box.querySelectorAll('.cand-card').forEach((card) => {
    const c = rows.find((r) => r.id === card.dataset.id);
    $('[data-locate]', card).addEventListener('click', () => {
      state.candPin?.hide();
      state.candPin = state.map.addMarker({ lat: c.lat, lng: c.lng, zIndex: 25, title: c.nom, html: `<div class="pin cand selected"></div><span class="mk-label right">${esc(c.nom)}</span>` });
      state.candPin.show();
      box.querySelectorAll('.cand-card.active').forEach((x) => x.classList.remove('active'));
      card.classList.add('active');
    });
    $('[data-odoo]', card).addEventListener('click', (e) => createOdooFiche(c, card, e.currentTarget));
    $('[data-know]', card).addEventListener('click', () => {
      const prefill = { name: c.nom, address: c.adresse, lat: c.lat, lng: c.lng };
      clearRadius();
      startSuggestion(prefill);
    });
    $('[data-contact]', card)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements, msg = $('[data-msg]', card);
      const { error } = await sb.rpc('amb_candidate_set_contact', { p_place_id: c.id, p_nom: f.nom.value, p_fonction: f.fonction.value, p_tel: f.tel.value, p_email: f.email.value });
      if (error) { console.error(error); msg.className = 'small error'; msg.textContent = 'La personne de contact n’a pas pu être enregistrée.'; return; }
      Object.assign(c, { contact_nom: f.nom.value.trim() || null, contact_fonction: f.fonction.value.trim() || null, contact_tel: f.tel.value.trim() || null, contact_email: f.email.value.trim() || null });
      renderCandList();
    });
  });
}

// Crée la société et l'opportunité dans Odoo (fonction zc-opportunite, côté serveur).
// Équipe : la fiche est à son nom. Apporteur : elle entre dans les dossiers de sa société. Ambassadeur : l'équipe la voit dans son suivi.
async function createOdooFiche(c, card, btn) {
  const msg = $('[data-msg]', card);
  const deja = c.perdu_le ? `Un autre apporteur a déjà tenté ce prospect, sans succès (dossier classé perdu le ${new Date(c.perdu_le).toLocaleDateString('fr-BE')}).\n\n` : '';
  if (!confirm(`${deja}Créer la fiche de « ${c.nom} » dans Odoo${state.user.role === 'apporteur' ? ' et l’ajouter à vos dossiers' : ''} ?`)) return;
  btn.disabled = true; msg.className = 'small muted'; msg.textContent = 'Création de la fiche dans Odoo…';
  try {
    const j = await zcCall(ZC_ODOO_URL, { place_id: c.id });
    const role = state.user.role;
    if (role === 'admin') {
      const url = j.url || `https://raysun.odoo.com/odoo/crm/${Number(j.odoo_lead_id)}`;
      msg.innerHTML = `${j.deja ? 'Cette entreprise était déjà dans Odoo.' : 'Fiche créée dans Odoo, à votre nom.'} <a href="${esc(url)}" target="_blank" rel="noopener">Ouvrir la fiche</a>. Elle est aussi listée dans le <a href="admin.html">suivi équipe</a>.`;
    } else if (role === 'apporteur') {
      const { error } = await sb.rpc('amb_candidate_to_dossier', { p_place_id: c.id });
      if (error) throw new Error(/déjà confié/.test(error.message) ? 'cette entreprise est déjà suivie par un autre apporteur' : 'la fiche est créée dans Odoo, mais le dossier n’a pas pu être ajouté. Prévenez l’équipe RaYSun');
      msg.innerHTML = 'Fiche créée dans Odoo et ajoutée à <a href="dossiers.html">vos dossiers</a>.';
    } else {
      msg.textContent = 'Fiche créée dans Odoo. L’équipe RaYSun la retrouve dans son suivi et reviendra vers vous.';
    }
    msg.className = 'small';
    card.classList.add('done');
    $('[data-know]', card).disabled = true;
  } catch (e) {
    console.error(e);
    msg.className = 'small error'; msg.textContent = `La création a échoué : ${e.message}.`;
    btn.disabled = false;
  }
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
  clearRadius();
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
    const { data } = await sb.from('amb_dossiers').select('id, prospect, lat, lng, status').not('lat', 'is', null).not('status', 'in', '("Clôturé","Perdu")');
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
  $('#book-link').hidden = !['admin', 'apporteur'].includes(state.user.role);
  $('#converted-filter').hidden = state.user.role !== 'admin';
  $('#add-lead').hidden = state.user.role !== 'admin';
  $('#tracker-link').hidden = state.user.role !== 'admin';
  const [map] = await Promise.all([createMap($('#map')), loadData()]);
  state.map = map;
  map.onZoom(updateLabels);
  map.onMove(() => { refreshZonings().catch(console.error); });
  $('#show-zonings').addEventListener('change', () => refreshZonings().catch(console.error));
  $('#zoning-import').hidden = state.user.role !== 'admin';
  // Équipe : si Google a refusé la clé, la carte est sur OpenStreetMap ; on affiche la raison donnée par Google.
  try {
    const refus = Date.now() - Number(sessionStorage.getItem('cw-map-fallback') || 0) < 600000;
    if (refus && state.user.role === 'admin') {
      $('.intro').insertAdjacentHTML('beforeend', `<p class="map-notice">Équipe : la carte Google a été refusée pour ${esc(location.origin)} (raison donnée par Google : ${esc(sessionStorage.getItem('cw-map-reason') || 'non précisée')}). La carte OpenStreetMap la remplace ; Google sera réessayé dans dix minutes.</p>`);
    }
  } catch {}
  // Un clic sur la carte (fond ou lieu Google : commerce, entreprise…) ouvre la recherche d'entreprises autour de ce point.
  const short = (a) => a.replace(/, Belgi(que|ë|um)$/i, '');
  map.onPoiClick(async (poi) => {
    const adresse = await map.placeAddress(poi.placeId).catch(() => null);
    openSearch({ kind: adresse ? 'adresse' : 'point', name: short(adresse || 'Lieu choisi sur la carte'), operation: 'Point de recherche', lat: poi.lat, lng: poi.lng, id: null });
  });
  map.onBackgroundClick((lat, lng) => openSearch({ kind: 'point', name: 'Point choisi sur la carte', operation: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, lat, lng, id: null }));
  // Recherche autour d'une adresse (localisée par Google, ou OpenStreetMap en secours).
  $('#around-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#around-msg'), q = $('#around-address').value.trim();
    msg.textContent = '';
    if (!q) return;
    const hit = await state.map.geocode(q).catch(() => null);
    if (!hit) { msg.textContent = 'Adresse introuvable. Précisez la commune ou le code postal.'; return; }
    openSearch({ kind: 'adresse', name: short(hit.address || q), operation: 'Point de recherche', lat: hit.lat, lng: hit.lng, id: null });
  });
  $('#zoning-import-btn').addEventListener('click', (e) => importZonings(e.currentTarget));
  $('#cand-export').addEventListener('click', (e) => exportCandidates(e.currentTarget));
  renderMarkers();
  refreshZonings().catch(console.error);
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
