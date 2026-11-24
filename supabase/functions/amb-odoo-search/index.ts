// Recherche dans Odoo pour l'espace apporteurs (lecture seule, réservée à l'équipe) :
//   { type: 'leads', q }     -> opportunités et pistes du CRM (prospect, contact, adresse)
//   { type: 'lead', id }      -> une fiche du CRM par son numéro (lien collé), complétée par la société liée
//   { type: 'partners', q }  -> sociétés des fiches contact, avec leurs personnes qui ont une adresse e-mail
// L'appelant doit être connecté et avoir le rôle admin (vérifié avec son propre jeton).
// Secrets : ODOO_USERNAME, ODOO_API_KEY (les mêmes que amb-notify) ; optionnels : ODOO_URL, ODOO_DB.
import { createClient } from 'npm:@supabase/supabase-js@2';

const ODOO_URL = Deno.env.get('ODOO_URL') ?? 'https://raysun.odoo.com';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });

async function odoo(service: string, method: string, args: unknown[]) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args } }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.data?.message ?? j.error.message);
  return j.result;
}

async function odooDb() {
  const fromEnv = Deno.env.get('ODOO_DB');
  if (fromEnv) return fromEnv;
  try {
    const list = await odoo('db', 'list', []);
    if (Array.isArray(list) && list.length === 1) return list[0];
  } catch (_) { /* on retombe sur le sous-domaine */ }
  return new URL(ODOO_URL).hostname.split('.')[0];
}

const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const adresse = (r: Record<string, unknown>) =>
  [txt(r.street), [txt(r.zip), txt(r.city)].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Méthode refusée' }, 405);
  try {
    const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false },
    });
    const { data: role } = await asUser.rpc('amb_role');
    if (role !== 'admin') return json({ error: 'Réservé à l’équipe' }, 403);

    const { type, q, id } = await req.json().catch(() => ({}));
    const terme = String(q ?? '').trim().slice(0, 80);
    const leadId = type === 'lead' && Number.isInteger(id) && id > 0 ? id : null;
    if (!leadId && (!['leads', 'partners'].includes(type) || terme.length < 2)) return json({ results: [] });

    const login = Deno.env.get('ODOO_USERNAME'), key = Deno.env.get('ODOO_API_KEY');
    if (!login || !key) throw new Error('Secrets ODOO_USERNAME / ODOO_API_KEY manquants');
    const db = await odooDb();
    const uid = await odoo('common', 'login', [db, login, key]);
    if (!uid) throw new Error('Connexion Odoo refusée');
    const kw = (model: string, method: string, a: unknown[], k: unknown = {}) =>
      odoo('object', 'execute_kw', [db, uid, key, model, method, a, k]);

    if (type === 'leads' || leadId) {
      const rows = await kw('crm.lead', 'search_read',
        [leadId ? [['id', '=', leadId]] : ['|', '|', ['name', 'ilike', terme], ['partner_name', 'ilike', terme], ['contact_name', 'ilike', terme]]],
        { fields: ['name', 'partner_name', 'contact_name', 'function', 'phone', 'email_from', 'street', 'zip', 'city', 'stage_id', 'partner_id'],
          limit: 8, order: 'write_date desc' });
      // Fiche lue par son lien : l'adresse, le téléphone et l'e-mail manquants sont repris de la société liée.
      if (leadId && rows[0] && Array.isArray(rows[0].partner_id)) {
        const [p] = await kw('res.partner', 'read', [[rows[0].partner_id[0]]], { fields: ['street', 'zip', 'city', 'phone', 'email'] });
        const r = rows[0];
        if (p) {
          if (!txt(r.street) && !txt(r.city)) Object.assign(r, { street: p.street, zip: p.zip, city: p.city });
          if (!txt(r.phone)) r.phone = p.phone;
          if (!txt(r.email_from)) r.email_from = p.email;
        }
      }
      return json({ results: rows.map((r: Record<string, any>) => ({
        id: r.id, name: txt(r.name), company: txt(r.partner_name) ?? (Array.isArray(r.partner_id) ? r.partner_id[1] : null),
        contact_name: txt(r.contact_name), contact_function: txt(r.function),
        contact_phone: txt(r.phone), contact_email: txt(r.email_from),
        address: adresse(r), zip: txt(r.zip), stage: Array.isArray(r.stage_id) ? r.stage_id[1] : null,
      })) });
    }

    const rows = await kw('res.partner', 'search_read',
      [[['is_company', '=', true], ['name', 'ilike', terme]]],
      { fields: ['name', 'email', 'phone', 'street', 'zip', 'city', 'child_ids'], limit: 8, order: 'name' });
    const childIds = rows.flatMap((r: Record<string, any>) => r.child_ids ?? []).slice(0, 200);
    const children = childIds.length
      ? await kw('res.partner', 'read', [childIds], { fields: ['name', 'email', 'function', 'parent_id'] })
      : [];
    return json({ results: rows.map((r: Record<string, any>) => ({
      id: r.id, name: txt(r.name), email: txt(r.email), phone: txt(r.phone), address: adresse(r),
      people: children
        .filter((c: Record<string, any>) => Array.isArray(c.parent_id) && c.parent_id[0] === r.id && txt(c.email))
        .map((c: Record<string, any>) => ({ name: txt(c.name), email: txt(c.email)!.toLowerCase(), function: txt(c.function) }))
        .slice(0, 12),
    })) });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e).slice(0, 200) }, 500);
  }
});
