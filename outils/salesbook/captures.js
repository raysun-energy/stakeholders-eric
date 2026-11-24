// Captures d'écran de la plateforme, vue apporteur d'affaires, avec des données fictives (faux client Supabase, fond de carte schématique).
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const ROOT = '/home/user/stakeholders-eric/site';
const OUT = __dirname + '/shots';
// Fond de carte schématique (les fonds réels ne sont pas accessibles d'ici) : îlots clairs et rues.
const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#EFE9DC"/>
<g fill="#F8F4EA"><rect x="6" y="6" width="112" height="70" rx="3"/><rect x="134" y="6" width="116" height="70" rx="3"/><rect x="6" y="92" width="70" height="72" rx="3"/><rect x="92" y="92" width="158" height="72" rx="3"/><rect x="6" y="180" width="150" height="70" rx="3"/><rect x="172" y="180" width="78" height="70" rx="3"/></g>
<rect x="150" y="100" width="60" height="40" fill="#DCE8D4" rx="6"/><path d="M0 84h256M126 0v84M84 84v88M0 172h256M164 172v84" stroke="#fff" stroke-width="7" fill="none"/></svg>`;
const mock = `
window.supabase = { createClient() {
  const rnd = (s) => { let x = Math.sin(s) * 10000; return x - Math.floor(x); };
  const MEMBERS = Array.from({ length: 34 }, (_, k) => ({ lat: 50.845 + (rnd(k + 1) - .5) * .09, lng: 4.355 + (rnd(k + 50) - .5) * .16, operation: 'Energilia Brussels', name: null, id: null }));
  MEMBERS[0] = { lat: 50.8385, lng: 4.325, operation: 'Energilia Brussels', name: null, id: null };
  const C = (id, nom, adresse, dLat, dLng, categorie, cmin, cmax, toit, pv, d, extra) => ({ id, nom, adresse, lat: 50.8385 + dLat, lng: 4.325 + dLng, categorie, conso_min_kwh: cmin, conso_max_kwh: cmax, surface_toit_m2: toit, pv_max_kwh_an: pv, distance_m: d, total: 4, ...extra });
  const CANDS = [
    C('c1', 'Imprimerie du Canal SRL', 'Quai de l’Industrie 12, 1070 Anderlecht', .002, .003, 'industrie', 180000, 620000, 2150, 240000, 310, { telephone: '02 555 01 23', email: 'info@imprimerie-exemple.be', site_web: 'www.imprimerie-exemple.be', contact_nom: 'Anne Leroy', contact_fonction: 'Responsable énergie', contact_tel: '0470 55 01 24' }),
    C('c2', 'Entrepôts Lemaire SA', 'Rue des Goujons 48, 1070 Anderlecht', -.003, .004, 'logistique', 120000, 400000, 3400, 380000, 540, { telephone: '02 555 01 88', site_web: 'www.entrepots-exemple.be' }),
    C('c3', 'Boulangerie Dumont', 'Chaussée de Mons 210, 1070 Anderlecht', .004, -.002, 'commerce', 100000, 260000, 620, 70000, 720, { telephone: '02 555 01 45', email: 'contact@boulangerie-exemple.be' }),
    C('c4', 'Menuiserie Collard', 'Rue de Birmingham 95, 1070 Anderlecht', -.005, -.005, 'construction', 100000, 180000, 900, 95000, 930, {}),
  ];
  const DOSSIERS = [
    { id: 'd1', org_id: 'o1', created_at: '2026-11-17T09:00:00Z', prospect: 'Entrepôt Dubois', address: 'Rue de l’Industrie 12, 4000 Liège', region: 'Wallonie', project: 'Toiture de 800 m², visite pour une installation solaire', contact_name: 'Marc Dubois', contact_function: 'Gérant', contact_phone: '04 555 01 67', contact_email: 'marc@dubois-exemple.be', available_on: '2026-12-01', available_note: 'le matin', status: 'Proposé', notified_at: '2026-11-17T09:00:05Z', message: 'Bonjour Camille, le gérant attend votre appel cette semaine.', lat: 50.64, lng: 5.57 },
    { id: 'd2', org_id: 'o1', created_at: '2026-11-10T09:00:00Z', prospect: 'Garage Peeters', address: 'Chaussée de Ninove 4, 1080 Molenbeek', region: 'Bruxelles', project: 'Producteur : surplus solaire à valoriser', contact_name: 'Jan Peeters', contact_phone: '02 555 01 33', status: 'Confirmé', answered_at: '2026-11-11T10:00:00Z', answered_by_name: 'Camille Durand', answer_note: 'Je passe mardi', notified_at: '2026-11-10T09:00:05Z', odoo_lead_id: 1, lat: 50.853, lng: 4.31 },
    { id: 'd3', org_id: 'o1', created_at: '2026-11-20T09:00:00Z', prospect: 'Imprimerie du Canal SRL', address: 'Quai de l’Industrie 12, 1070 Anderlecht', region: 'Bruxelles', project: 'Prospect trouvé sur la carte par l’apporteur.', contact_name: 'Anne Leroy', contact_function: 'Responsable énergie', contact_phone: '0470 55 01 24', status: 'Confirmé', answered_at: '2026-11-20T09:00:00Z', answered_by_name: 'Camille Durand', notified_at: '2026-11-20T09:00:00Z', odoo_lead_id: 2, lat: 50.8405, lng: 4.328 }];
  const INV = [
    { id: 'i1', org_id: 'o1', invoice_date: '2026-09-30', amount_eur: 177.5, reference: 'Outil Fees', label: 'Commissions 2026-09', source: 'outil-fees', period_month: '2026-09' },
    { id: 'i2', org_id: 'o1', invoice_date: '2026-08-31', amount_eur: 162.1, reference: 'Outil Fees', label: 'Commissions 2026-08', source: 'outil-fees', period_month: '2026-08' },
    { id: 'i3', org_id: 'o1', invoice_date: '2026-07-31', amount_eur: 149.8, reference: 'Outil Fees', label: 'Commissions 2026-07', source: 'outil-fees', period_month: '2026-07' }];
  const STATS = [
    { period: '2026', kind: 'année', own_amount: 1240.6, own_share: 41.2, own_rank: 2, orgs: 3, total_amount: null, podium: [{ rank: 1, name: null, me: false, share: 46.3, amount: null }, { rank: 2, name: 'Atelier Solaire', me: true, share: 41.2, amount: 1240.6 }, { rank: 3, name: null, me: false, share: 12.5, amount: null }] },
    { period: '2026-T3', kind: 'trimestre', own_amount: 489.4, own_share: 44.0, own_rank: 1, orgs: 3, total_amount: null, podium: [{ rank: 1, name: 'Atelier Solaire', me: true, share: 44.0, amount: 489.4 }, { rank: 2, name: null, me: false, share: 40.1, amount: null }, { rank: 3, name: null, me: false, share: 15.9, amount: null }] }];
  const MSG = [{ id: 'm1', dossier_id: 'd2', created_at: '2026-11-11T09:30:00Z', author_name: 'Eric (RaYSun)', from_team: true, body: 'Bonjour, le gérant préfère un passage avant 10 h.' }, { id: 'm2', dossier_id: 'd2', created_at: '2026-11-11T10:05:00Z', author_name: 'Camille Durand', from_team: false, body: 'Bien noté, je passe mardi à 9 h. Je vous envoie sa facture ensuite.' }];
  const LINES = [{ org_id: 'o1', period_month: '2026-09', operation: 'Energilia Brussels', client: 'Client exemple A', ean: '5414480000000000A1', conso_kwh: 12500, inj_kwh: 0, tarif_conso: 4, tarif_prod: 0, fee_conso: 50, fee_prod: 0 }, { org_id: 'o1', period_month: '2026-09', operation: 'Energilia Brussels', client: 'Client exemple B', ean: '5414480000000000B2', conso_kwh: 0, inj_kwh: 30200, tarif_conso: 0, tarif_prod: 3, fee_conso: 0, fee_prod: 90.6 }, { org_id: 'o1', period_month: '2026-09', operation: 'Energilia Wallonie', client: 'Client exemple C', ean: '5414490000000000C3', conso_kwh: 8200, inj_kwh: 4100, tarif_conso: 3, tarif_prod: 3, fee_conso: 24.6, fee_prod: 12.3 }];
  const T = { amb_members: [{ role: 'apporteur', name: 'Camille Durand' }], amb_leads: [], amb_dossiers: DOSSIERS, amb_settings: [{ key: 'target', value: 'Priorité actuelle : Bruxelles, bâtiments professionnels, entreprises et ASBL.' }],
    amb_dossier_messages: MSG, amb_org_fee_lines: LINES, amb_org_invoices: INV, amb_orgs: [{ id: 'o1', name: 'Atelier Solaire' }], amb_suggestions: [] };
  const q = (rows) => { const b = { insert: () => { const r = Promise.resolve({ data: {}, error: null }); r.select = () => ({ single: () => r }); return r; }, select: () => b, order: () => b, in: () => b, not: () => b, neq: () => b, is: () => b,
    eq: (k, v) => { rows = rows.filter((r) => r[k] === undefined || r[k] === v); return b; },
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }), then: (f, g) => Promise.resolve({ data: rows, error: null }).then(f, g) }; return b; };
  return {
    auth: { getSession: async () => ({ data: { session: { access_token: 'x', user: { id: 'u1', email: 'camille@exemple.be' } } } }), signOut: async () => {} },
    from: (t) => q([...(T[t] ?? [])]),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
    rpc: (f) => Promise.resolve({ data: f === 'amb_candidates_around' ? CANDS : f === 'amb_community_members' ? MEMBERS : f === 'amb_apporteur_stats' ? STATS : f === 'amb_org' ? 'o1'
      : f === 'amb_zonings' ? [{ id: 1, nom: 'Zoning exemple', region: 'Bruxelles', geometry: { type: 'Polygon', coordinates: [[[4.318, 50.832], [4.34, 50.832], [4.34, 50.846], [4.318, 50.846], [4.318, 50.832]]] } }] : [], error: null }),
  };
} };`;
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 });
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (/tile\.openstreetmap|arcgisonline/.test(u.host)) return route.fulfill({ body: tile, contentType: 'image/svg+xml' });
    if (u.protocol !== 'file:') return route.abort();
    if (u.pathname.endsWith('/vendor/supabase.js')) return route.fulfill({ body: mock, contentType: 'text/javascript' });
    if (u.pathname.endsWith('/config.js')) return route.fulfill({ body: "window.CITYWATT_CONFIG = { supabaseUrl: 'x', supabaseAnonKey: 'x', googleMapsApiKey: '', googleMapId: '' };", contentType: 'text/javascript' });
    const f = decodeURIComponent(u.pathname);
    if (!fs.existsSync(f)) return route.abort();
    route.fulfill({ body: fs.readFileSync(f), contentType: { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(f)] || 'application/octet-stream' });
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto('file://' + ROOT + '/index.html');
  await p.waitForTimeout(1200);
  await p.check('#show-members');
  await p.evaluate(() => { window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, odoo_lead_id: 2, total: 4 }) }); window.confirm = () => true; state.map.flyTo(50.845, 4.345, 13); });
  await p.waitForTimeout(900);
  await p.screenshot({ path: OUT + '/1-carte.png' });
  await p.evaluate(() => openSearch({ kind: 'membre', name: 'Membre', operation: 'Energilia Brussels', lat: 50.8385, lng: 4.325, id: null }));
  await p.waitForTimeout(900);
  await p.screenshot({ path: OUT + '/2-recherche.png' });
  await p.selectOption('#cand-filter', 'conso');
  await p.click('#member-search');
  await p.waitForTimeout(700);
  await p.click('.cand-card [data-locate]');
  await p.waitForTimeout(300);
  await p.screenshot({ path: OUT + '/3-liste.png' });
  await (await p.$('.cand-card')).screenshot({ path: OUT + '/4-entreprise.png' });
  await p.click('.cand-card [data-odoo]');
  await p.waitForTimeout(400);
  await (await p.$('.cand-card')).screenshot({ path: OUT + '/5-fiche-creee.png' });
  await p.click('#panel-close');
  await p.click('#add-place');
  await p.waitForTimeout(400);
  await p.mouse.click(620, 380);
  await p.waitForTimeout(300);
  await p.screenshot({ path: OUT + '/6-proposer.png' });
  await p.click('#panel-close');
  await p.click('#support-open');
  await p.fill('#support-dialog textarea', 'Quand je clique sur « Localiser », la carte se place sur une mauvaise adresse.');
  await p.setInputFiles('#support-files', [{ name: 'capture-carte.png', mimeType: 'image/png', buffer: Buffer.from('x') }]);
  await (await p.$('#support-dialog')).screenshot({ path: OUT + '/7-support.png' });

  await p.goto('file://' + ROOT + '/dossiers.html');
  await p.waitForTimeout(900);
  await (await p.$('.topbar')).screenshot({ path: OUT + '/8-entete.png' });
  const hero = await p.$('#hero-main'); const heroBox = await p.evaluateHandle((e) => e.closest('section, .hero, div.card') || e.parentElement, hero);
  await heroBox.asElement().screenshot({ path: OUT + '/9-classement.png' });
  await p.evaluate(() => document.querySelectorAll('details.fil').forEach((d) => { d.open = true; }));
  await (await p.$('#dossiers')).screenshot({ path: OUT + '/10-dossiers.png' });
  for (const id of ['d1', 'd2', 'd3']) { const c = await p.$(`.dossier[data-id="${id}"]`); if (c) await c.screenshot({ path: OUT + `/11-dossier-${id}.png` }); }
  const bd = await p.$('[data-detail]'); if (bd) { await bd.click(); await p.waitForTimeout(300); }
  await (await p.evaluateHandle(() => document.querySelector('#invoices').closest('table').parentElement)).asElement().screenshot({ path: OUT + '/12-commissions.png' });
  await p.screenshot({ path: OUT + '/13-dossiers-page.png', fullPage: true });
  await b.close();
})();
