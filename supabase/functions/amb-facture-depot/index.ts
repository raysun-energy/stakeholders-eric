// Dépôt public d'une facture d'électricité (page facture.html, sans connexion).
// POST multipart : campagne et fichier (PDF ou photo, 10 Mo au plus). Rien d'autre à remplir : le nom, l'adresse et le code EAN
// se lisent sur la facture. Les champs nom, email et boite restent acceptés s'ils sont fournis.
// La campagne doit exister et être active (table amb_depot_campagnes) ; 30 dépôts par heure au plus par campagne.
// Le fichier est rangé dans le compartiment privé amb-invoices (purgé après 10 jours) et envoyé par e-mail à l'équipe, via Odoo.
// Secrets : ODOO_USERNAME, ODOO_API_KEY ; optionnels ODOO_URL, ODOO_DB, NOTIFY_EMAIL.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { encodeBase64 } from 'jsr:@std/encoding@1/base64';

const ODOO_URL = Deno.env.get('ODOO_URL') ?? 'https://raysun.odoo.com';
const NOTIFY_EMAIL = Deno.env.get('NOTIFY_EMAIL') ?? 'eric.rw@raysun.solar';
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json', ...cors } });
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };

async function rpc(service: string, method: string, args: unknown[]) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args } }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.data?.message ?? j.error.message);
  return j.result;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST attendu' }, 405);
  try {
    const form = await req.formData();
    const txt = (k: string, max: number) => String(form.get(k) ?? '').trim().slice(0, max);
    const campagne = txt('campagne', 60), nom = txt('nom', 120), email = txt('email', 160).toLowerCase(), boite = txt('boite', 20);
    const file = form.get('fichier');
    const { data: camp } = await sb.from('amb_depot_campagnes').select('label').eq('slug', campagne).eq('active', true).maybeSingle();
    if (!camp) return json({ error: 'Ce lien de dépôt n’est plus valable.' }, 404);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: 'Adresse e-mail invalide.' }, 400);
    if (!(file instanceof File) || !file.size) return json({ error: 'Joignez votre facture.' }, 400);
    const ext = TYPES[file.type];
    if (!ext) return json({ error: 'Format refusé : envoyez un PDF ou une photo (JPG, PNG, HEIC).' }, 400);
    if (file.size > 10 * 1024 * 1024) return json({ error: 'Fichier trop lourd : 10 Mo au plus.' }, 400);
    const { count } = await sb.from('amb_facture_depots').select('id', { count: 'exact', head: true })
      .eq('campagne', campagne).gt('created_at', new Date(Date.now() - 3600_000).toISOString());
    if ((count ?? 0) >= 30) return json({ error: 'Trop de dépôts en ce moment. Réessayez dans une heure.' }, 429);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const path = `depot/${campagne}/${crypto.randomUUID()}.${ext}`;
    const up = await sb.storage.from('amb-invoices').upload(path, bytes, { contentType: file.type });
    if (up.error) throw new Error(up.error.message);
    const { data: row, error } = await sb.from('amb_facture_depots').insert({ campagne, nom: nom || 'non indiqué', email: email || 'non indiqué', boite: boite || null, path }).select('id').single();
    if (error) throw new Error(error.message);

    // E-mail à l'équipe avec la facture jointe. Un échec d'envoi ne fait pas échouer le dépôt : le fichier est enregistré.
    try {
      const login = Deno.env.get('ODOO_USERNAME'), key = Deno.env.get('ODOO_API_KEY');
      if (!login || !key) throw new Error('Secrets Odoo manquants');
      let db = Deno.env.get('ODOO_DB');
      if (!db) { const l = await rpc('db', 'list', []).catch(() => null); db = Array.isArray(l) && l.length === 1 ? l[0] : new URL(ODOO_URL).hostname.split('.')[0]; }
      const uid = await rpc('common', 'login', [db, login, key]);
      const exec = (model: string, method: string, args: unknown[]) => rpc('object', 'execute_kw', [db, uid, key, model, method, args]);
      const att = await exec('ir.attachment', 'create', [{ name: `Facture ${camp.label}${nom ? ' ' + nom : ''}${boite ? ' boîte ' + boite : ''}.${ext}`, datas: encodeBase64(bytes), mimetype: file.type }]);
      const mail = await exec('mail.mail', 'create', [{
        subject: `[${camp.label}] Facture d'électricité déposée${nom ? ' par ' + nom : ''}${boite ? ' (boîte ' + boite + ')' : ''}`, email_to: NOTIFY_EMAIL, ...(email ? { reply_to: email } : {}), auto_delete: false,
        attachment_ids: [[6, 0, [att]]],
        body_html: `<p>Un occupant vient de déposer sa dernière facture d'électricité pour <b>${esc(camp.label)}</b>, après la signature de son contrat.</p>${nom || email || boite ? `<p>${[nom && 'Nom : ' + esc(nom), email && 'E-mail : ' + esc(email), boite && 'Boîte : ' + esc(boite)].filter(Boolean).join('<br>')}</p>` : ''}<p>La facture est jointe : le nom, l'adresse et le code EAN du logement s'y trouvent. Rapprochez-la du contrat signé dans Odoo Signature.</p>`,
      }]);
      await exec('mail.mail', 'send', [[mail]]).catch(() => {});
      await sb.from('amb_facture_depots').update({ notified_at: new Date().toISOString() }).eq('id', row.id);
    } catch (e) { console.error('E-mail de dépôt non envoyé', e); }
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: 'Le dépôt a échoué. Réessayez, ou envoyez votre facture à hi@raysun.solar.' }, 500);
  }
});
