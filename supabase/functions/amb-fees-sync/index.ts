// Reprend chaque nuit les commissions des apporteurs d'affaires calculées par l'outil Fees (boîte à outils interne).
// L'outil Fees garde un document JSON (référentiel des EAN avec leurs tarifs, volumes mensuels des GRD) dans la table
// fees_courant d'un AUTRE projet Supabase. Cette fonction le lit, refait le même calcul que le moteur de l'outil
// (fee d'un EAN pour un mois = conso partagée × tarif conso + injection partagée × tarif prod, kWh et EUR/MWh),
// additionne par apporteur et par mois, puis remplace les lignes « outil-fees » de l'espace apporteurs.
// Elle enregistre aussi les volumes échangés par opération et par mois (table amb_op_volumes), pour le sales book en ligne.
// Sans paramètre : un appel forgé ne peut que relancer la même lecture.
//
// Secrets à définir (Edge Functions > Secrets) :
//   FEES_SUPABASE_URL          adresse du projet Supabase de la boîte à outils (https://xxxx.supabase.co)
//   FEES_SUPABASE_SERVICE_KEY  clé service_role de CE projet-là (lecture de fees_courant)
import { createClient } from 'npm:@supabase/supabase-js@2';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

async function etat(ok: boolean, message: string, sourceAt: string | null = null) {
  await sb.from('amb_fees_sync').upsert({ id: true, at: new Date().toISOString(), ok, message: message.slice(0, 700), source_at: sourceAt });
}

type Contrat = { id: string; client?: string; operationId: string; ean: string; apporteurId: string; debut: string | null; fin: string | null; tarifConso: number | null; tarifProd: number | null };

Deno.serve(async () => {
  try {
    // Seule l'origine compte : une adresse collée avec « /rest/v1 » ou une barre finale est acceptée.
    const brut = (Deno.env.get('FEES_SUPABASE_URL') ?? '').trim();
    const url = (() => { try { return new URL(brut).origin; } catch { return ''; } })();
    const key = (Deno.env.get('FEES_SUPABASE_SERVICE_KEY') ?? '').trim();
    if (!brut || !key) throw new Error('Secrets FEES_SUPABASE_URL / FEES_SUPABASE_SERVICE_KEY à définir');
    if (!url) throw new Error('FEES_SUPABASE_URL n’est pas une adresse valide (attendu : https://xxxx.supabase.co)');

    const res = await fetch(`${url}/rest/v1/fees_courant?select=data,updated_at&order=updated_at.desc&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      // Diagnostic sans secret : hôte interrogé, réponse du serveur et, si la table manque, tables réellement présentes.
      const hote = new URL(url).host;
      const corps = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
      let tables = '';
      if (res.status === 404) {
        const spec = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }).then((r) => r.json()).catch(() => null);
        const noms = Object.keys(spec?.paths ?? {}).map((x) => x.replace(/^\//, '')).filter((x) => x && !x.startsWith('rpc/'));
        tables = spec ? ` ; tables visibles : ${noms.join(', ') || 'aucune'}` : ' ; ce serveur ne répond pas comme un projet Supabase';
      }
      throw new Error(`Lecture de l'outil Fees refusée (HTTP ${res.status}) sur ${hote} : ${corps}${tables}`);
    }
    const [doc] = await res.json();
    if (!doc?.data) {
      // Aucune ligne : soit rien n'est enregistré en ligne, soit la clé n'est pas la clé de service et les règles d'accès masquent tout.
      const genre = key.startsWith('sb_publishable_') ? 'publishable' : key.startsWith('sb_secret_') ? 'secret'
        : (() => { try { return JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role ?? 'inconnu'; } catch { return 'inconnu'; } })();
      throw new Error(['service_role', 'secret'].includes(genre)
        ? "L'outil Fees n'a aucune donnée enregistrée en ligne dans ce projet (table fees_courant vide)"
        : `La clé enregistrée est de type « ${genre} » : il faut la clé service_role (ou « secret »), sinon les données restent invisibles`);
    }
    const d = doc.data as { operations?: { id: string; nom: string }[]; apporteurs?: { id: string; nom: string }[]; contrats?: Contrat[]; imports?: { operationId: string; mois: string; lignes: { ean: string; consoPartagee: number; injPartagee: number }[] }[] };

    // Contrat applicable à un EAN pour un mois dans une opération : le premier trouvé (comme indexContrats du moteur).
    const parEan = new Map<string, Contrat[]>();
    for (const c of d.contrats ?? []) {
      const k = `${c.operationId}|${c.ean}`;
      (parEan.get(k) ?? parEan.set(k, []).get(k)!).push(c);
    }
    const actif = (c: Contrat, mois: string) => (!c.debut || mois >= c.debut) && (!c.fin || mois <= c.fin);
    const nom = new Map((d.apporteurs ?? []).map((a) => [a.id, a.nom]));

    const operation = new Map((d.operations ?? []).map((o) => [o.id, o.nom]));
    const totaux = new Map<string, number>();   // « apporteur|mois » -> EUR
    // Détail du calcul : une ligne par contrat (EAN) et par mois, registres additionnés, comme le moteur de l'outil.
    type Ligne = { apporteur: string; mois: string; operation: string; client: string; ean: string; conso_kwh: number; inj_kwh: number; tarif_conso: number; tarif_prod: number; fee_conso: number; fee_prod: number };
    const detail = new Map<string, Ligne>();
    for (const imp of d.imports ?? []) {
      for (const l of imp.lignes ?? []) {
        const c = parEan.get(`${imp.operationId}|${l.ean}`)?.find((x) => actif(x, imp.mois));
        if (!c) continue;
        const conso = Number(l.consoPartagee) || 0, inj = Number(l.injPartagee) || 0;
        const fc = (conso * (c.tarifConso ?? 0)) / 1000, fp = (inj * (c.tarifProd ?? 0)) / 1000;
        const k = `${c.apporteurId}|${imp.mois}`;
        totaux.set(k, (totaux.get(k) ?? 0) + fc + fp);
        const kd = `${c.id}|${imp.mois}`;
        let li = detail.get(kd);
        if (!li) {
          li = { apporteur: nom.get(c.apporteurId) ?? '', mois: imp.mois, operation: operation.get(imp.operationId) ?? '', client: c.client ?? '', ean: c.ean,
            conso_kwh: 0, inj_kwh: 0, tarif_conso: c.tarifConso ?? 0, tarif_prod: c.tarifProd ?? 0, fee_conso: 0, fee_prod: 0 };
          detail.set(kd, li);
        }
        li.conso_kwh += conso; li.inj_kwh += inj; li.fee_conso += fc; li.fee_prod += fp;
      }
    }
    const rows = [...totaux].map(([k, montant]) => {
      const [id, mois] = k.split('|');
      return { apporteur: nom.get(id) ?? '', mois, montant: Math.round(montant * 100) / 100 };
    }).filter((r) => r.apporteur);

    const { data: n, error } = await sb.rpc('amb_fees_replace', { p_rows: rows });
    if (error) throw new Error(error.message);
    const lignes = [...detail.values()].filter((l) => l.apporteur && (l.conso_kwh || l.inj_kwh));
    const { data: nd, error: e2 } = await sb.rpc('amb_fee_lines_replace', { p_lines: lignes });
    if (e2) throw new Error(e2.message);
    // Volumes échangés par opération et par mois (tous les EAN, pas seulement ceux des apporteurs) : agrégats pour le sales book.
    const vol = new Map<string, { operation: string; mois: string; inj: number; conso: number; eans: Set<string> }>();
    for (const imp of d.imports ?? []) {
      const op = operation.get(imp.operationId); if (!op) continue;
      const k = `${op}|${imp.mois}`;
      const v = vol.get(k) ?? vol.set(k, { operation: op, mois: imp.mois, inj: 0, conso: 0, eans: new Set() }).get(k)!;
      for (const l of imp.lignes ?? []) { v.inj += Number(l.injPartagee) || 0; v.conso += Number(l.consoPartagee) || 0; v.eans.add(l.ean); }
    }
    const volumes = [...vol.values()].map((v) => ({ operation: v.operation, mois: v.mois, inj_mwh: Math.round(v.inj) / 1000, conso_mwh: Math.round(v.conso) / 1000, eans: v.eans.size }));
    const { error: e3 } = await sb.rpc('amb_op_volumes_replace', { p_rows: volumes });
    if (e3) console.error('Volumes par opération non enregistrés', e3.message);
    const societes = new Set(rows.map((r) => r.apporteur)).size;
    await etat(true, `${n} mois repris pour ${societes} société(s), ${nd} lignes de détail`, doc.updated_at ?? null);
    return new Response(JSON.stringify({ ok: true, lignes: n, societes }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error(e);
    const message = String((e as Error).message ?? e);
    await etat(false, message).catch(() => {});
    return new Response(JSON.stringify({ ok: false, erreur: message.slice(0, 300) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
