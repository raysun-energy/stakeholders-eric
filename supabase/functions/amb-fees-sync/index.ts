// Reprend chaque nuit les commissions des apporteurs d'affaires calculées par l'outil Fees (boîte à outils interne).
// L'outil Fees garde un document JSON (référentiel des EAN avec leurs tarifs, volumes mensuels des GRD) dans la table
// fees_courant d'un AUTRE projet Supabase. Cette fonction le lit, refait le même calcul que le moteur de l'outil
// (fee d'un EAN pour un mois = conso partagée × tarif conso + injection partagée × tarif prod, kWh et EUR/MWh),
// additionne par apporteur et par mois, puis remplace les lignes « outil-fees » de l'espace apporteurs.
// Sans paramètre : un appel forgé ne peut que relancer la même lecture.
//
// Secrets à définir (Edge Functions > Secrets) :
//   FEES_SUPABASE_URL          adresse du projet Supabase de la boîte à outils (https://xxxx.supabase.co)
//   FEES_SUPABASE_SERVICE_KEY  clé service_role de CE projet-là (lecture de fees_courant)
import { createClient } from 'npm:@supabase/supabase-js@2';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

async function etat(ok: boolean, message: string, sourceAt: string | null = null) {
  await sb.from('amb_fees_sync').upsert({ id: true, at: new Date().toISOString(), ok, message: message.slice(0, 300), source_at: sourceAt });
}

type Contrat = { operationId: string; ean: string; apporteurId: string; debut: string | null; fin: string | null; tarifConso: number | null; tarifProd: number | null };

Deno.serve(async () => {
  try {
    const url = (Deno.env.get('FEES_SUPABASE_URL') ?? '').trim().replace(/\/+$/, '');
    const key = (Deno.env.get('FEES_SUPABASE_SERVICE_KEY') ?? '').trim();
    if (!url || !key) throw new Error('Secrets FEES_SUPABASE_URL / FEES_SUPABASE_SERVICE_KEY à définir');

    const res = await fetch(`${url}/rest/v1/fees_courant?select=data,updated_at&order=updated_at.desc&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Lecture de l'outil Fees refusée (HTTP ${res.status})`);
    const [doc] = await res.json();
    if (!doc?.data) throw new Error("L'outil Fees n'a pas encore de données enregistrées en ligne");
    const d = doc.data as { apporteurs?: { id: string; nom: string }[]; contrats?: Contrat[]; imports?: { operationId: string; mois: string; lignes: { ean: string; consoPartagee: number; injPartagee: number }[] }[] };

    // Contrat applicable à un EAN pour un mois dans une opération : le premier trouvé (comme indexContrats du moteur).
    const parEan = new Map<string, Contrat[]>();
    for (const c of d.contrats ?? []) {
      const k = `${c.operationId}|${c.ean}`;
      (parEan.get(k) ?? parEan.set(k, []).get(k)!).push(c);
    }
    const actif = (c: Contrat, mois: string) => (!c.debut || mois >= c.debut) && (!c.fin || mois <= c.fin);
    const nom = new Map((d.apporteurs ?? []).map((a) => [a.id, a.nom]));

    const totaux = new Map<string, number>();   // « apporteur|mois » -> EUR
    for (const imp of d.imports ?? []) {
      for (const l of imp.lignes ?? []) {
        const c = parEan.get(`${imp.operationId}|${l.ean}`)?.find((x) => actif(x, imp.mois));
        if (!c) continue;
        const fee = ((Number(l.consoPartagee) || 0) * (c.tarifConso ?? 0) + (Number(l.injPartagee) || 0) * (c.tarifProd ?? 0)) / 1000;
        const k = `${c.apporteurId}|${imp.mois}`;
        totaux.set(k, (totaux.get(k) ?? 0) + fee);
      }
    }
    const rows = [...totaux].map(([k, montant]) => {
      const [id, mois] = k.split('|');
      return { apporteur: nom.get(id) ?? '', mois, montant: Math.round(montant * 100) / 100 };
    }).filter((r) => r.apporteur);

    const { data: n, error } = await sb.rpc('amb_fees_replace', { p_rows: rows });
    if (error) throw new Error(error.message);
    const societes = new Set(rows.map((r) => r.apporteur)).size;
    await etat(true, `${n} mois repris pour ${societes} société(s)`, doc.updated_at ?? null);
    return new Response(JSON.stringify({ ok: true, lignes: n, societes }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error(e);
    const message = String((e as Error).message ?? e);
    await etat(false, message).catch(() => {});
    return new Response(JSON.stringify({ ok: false, erreur: message.slice(0, 300) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
