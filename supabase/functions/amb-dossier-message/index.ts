// Fil de discussion des dossiers apporteurs : à chaque nouveau message,
//   1. e-mail à l'autre partie (message de l'équipe -> personnes de la société ; message de l'apporteur -> équipe) ;
//   2. note interne sur la fiche Odoo du prospect, quand le dossier est relié à une fiche du CRM.
// Appelée par la base (trigger) avec { id } uniquement : la fonction relit le message et ne traite chaque étape qu'une fois.
// Secrets (les mêmes que amb-notify) : ODOO_USERNAME, ODOO_API_KEY ; optionnels : ODOO_URL, ODOO_DB, NOTIFY_EMAIL.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SITE = 'https://citywatt-ambassadeurs.netlify.app';
const ODOO_URL = Deno.env.get('ODOO_URL') ?? 'https://raysun.odoo.com';
const NOTIFY_EMAIL = Deno.env.get('NOTIFY_EMAIL') ?? 'eric.rw@raysun.solar';
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const texte = (s: string) => esc(s).replace(/\n/g, '<br>');

async function odoo(service: string, method: string, args: unknown[]) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args } }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.data?.message ?? j.error.message);
  return j.result;
}

let session: { db: string; uid: number; key: string } | null = null;
async function odooKw(model: string, method: string, a: unknown[], k: unknown = {}) {
  if (!session) {
    const login = Deno.env.get('ODOO_USERNAME'), key = Deno.env.get('ODOO_API_KEY');
    if (!login || !key) throw new Error('Secrets ODOO_USERNAME / ODOO_API_KEY manquants');
    let db = Deno.env.get('ODOO_DB');
    if (!db) {
      const list = await odoo('db', 'list', []).catch(() => null);
      db = Array.isArray(list) && list.length === 1 ? list[0] : new URL(ODOO_URL).hostname.split('.')[0];
    }
    const uid = await odoo('common', 'login', [db, login, key]);
    if (!uid) throw new Error('Connexion Odoo refusée');
    session = { db: db!, uid, key };
  }
  return odoo('object', 'execute_kw', [session.db, session.uid, session.key, model, method, a, k]);
}

async function orgEmails(orgId: string) {
  const emails = new Set<string>();
  const { data: members } = await sb.from('amb_members').select('user_id').eq('org_id', orgId);
  for (const m of members ?? []) {
    const { data } = await sb.auth.admin.getUserById(m.user_id);
    if (data?.user?.email) emails.add(data.user.email.toLowerCase());
  }
  const { data: invites } = await sb.from('amb_invites').select('email').eq('org_id', orgId);
  for (const i of invites ?? []) emails.add(i.email);
  return [...emails];
}

// Réserve une étape (colonne de date) pour ne la traiter qu'une fois ; renvoie false si elle est déjà faite.
async function reserver(id: string, col: string) {
  const { data } = await sb.from('amb_dossier_messages').update({ [col]: new Date().toISOString() }).eq('id', id).is(col, null).select('id').maybeSingle();
  return !!data;
}
const liberer = (id: string, col: string) => sb.from('amb_dossier_messages').update({ [col]: null }).eq('id', id);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const { id } = await req.json().catch(() => ({}));
  if (typeof id !== 'string') return new Response('Bad request', { status: 400 });
  const { data: m } = await sb.from('amb_dossier_messages').select('*').eq('id', id).maybeSingle();
  if (!m) return new Response('Introuvable', { status: 200 });
  const { data: d } = await sb.from('amb_dossiers').select('*').eq('id', m.dossier_id).maybeSingle();
  if (!d) return new Response('Dossier introuvable', { status: 200 });
  const { data: org } = await sb.from('amb_orgs').select('name').eq('id', d.org_id).maybeSingle();
  const qui = `${m.author_name ?? 'Quelqu’un'} (${m.from_team ? 'RaYSun' : org?.name ?? 'apporteur'})`;
  const erreurs: string[] = [];

  // 1. E-mail à l'autre partie
  if (await reserver(id, 'notified_at')) {
    try {
      const to = m.from_team ? (await orgEmails(d.org_id)).join(',') : NOTIFY_EMAIL;
      if (to) {
        const mailId = await odooKw('mail.mail', 'create', [{
          subject: `[RaYSun] Message sur le dossier ${d.prospect}`,
          body_html: `<p><b>${esc(qui)}</b> a écrit sur le dossier <b>${esc(d.prospect)}</b> :</p>` +
            `<p style="background:#FBEBDB;border-radius:10px;padding:10px 14px">${texte(m.body)}</p>` +
            `<p>Pour répondre, ouvrez le dossier : <a href="${SITE}/dossiers.html">${SITE}/dossiers.html</a></p>`,
          email_to: to, reply_to: NOTIFY_EMAIL.split(',')[0].trim(), auto_delete: false,
        }]);
        await odooKw('mail.mail', 'send', [[mailId]]).catch(() => {});
      }
    } catch (e) { console.error(e); erreurs.push('e-mail : ' + e); await liberer(id, 'notified_at'); }
  }

  // 2. Note interne sur la fiche Odoo du prospect
  if (d.odoo_lead_id && await reserver(id, 'odoo_at')) {
    try {
      await odooKw('crm.lead', 'message_post', [[d.odoo_lead_id]], {
        body: `<p><b>Espace apporteurs</b> · ${esc(qui)} · dossier confié à ${esc(org?.name)}</p><p>${texte(m.body)}</p>`,
        body_is_html: true, message_type: 'comment', subtype_xmlid: 'mail.mt_note',
      });
    } catch (e) { console.error(e); erreurs.push('note Odoo : ' + e); await liberer(id, 'odoo_at'); }
  }
  return new Response(erreurs.length ? erreurs.join(' ; ').slice(0, 400) : 'ok', { status: erreurs.length ? 500 : 200 });
});
