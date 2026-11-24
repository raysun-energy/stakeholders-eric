// E-mails des dossiers affectés aux apporteurs d'affaires (via Odoo, comme amb-notify).
// Appelée par la base (trigger amb_dossier_notify) avec { id, kind } uniquement : la fonction relit le dossier
// elle-même et n'envoie qu'une fois par étape, donc un appel forgé ne peut ni inventer ni répéter un e-mail.
//   kind = 'assigned' : le dossier vient d'être affecté -> e-mail à toutes les personnes de la société.
//   kind = 'answered' : l'apporteur a répondu (confirmé, refusé, fiche traitée, perdu) -> e-mail à l'équipe.
//     Fiche traitée : la facture du prospect est jointe à l'e-mail et à la fiche Odoo, pour la simulation.
//     Perdu : la fiche Odoo est marquée perdue, avec la raison en note.
//
// Secrets (les mêmes que amb-notify) : ODOO_USERNAME, ODOO_API_KEY ; optionnels : ODOO_URL, ODOO_DB, NOTIFY_EMAIL.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { encodeBase64 } from 'jsr:@std/encoding@1/base64';

const SITE = 'https://citywatt-ambassadeurs.netlify.app';
const ODOO_URL = Deno.env.get('ODOO_URL') ?? 'https://raysun.odoo.com';
const NOTIFY_EMAIL = Deno.env.get('NOTIFY_EMAIL') ?? 'eric.rw@raysun.solar';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function table(rows: [string, unknown][]) {
  return '<table cellpadding="4" style="border-collapse:collapse">' + rows
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<tr><td style="color:#6B6A66;vertical-align:top">${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join('') + '</table>';
}

const dateFr = (d: string | null) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('fr-BE', { day: 'numeric', month: 'long', year: 'numeric' }) : null;

async function odoo(service: string, method: string, args: unknown[]) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args } }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.data?.message ?? json.error.message);
  return json.result;
}

async function odooDb() {
  const fromEnv = Deno.env.get('ODOO_DB');
  if (fromEnv) return fromEnv;
  try {
    const list = await odoo('db', 'list', []);
    if (Array.isArray(list) && list.length === 1) return list[0];
  } catch (e) {
    console.error('Liste des bases Odoo indisponible :', e);
  }
  return new URL(ODOO_URL).hostname.split('.')[0];
}

type Exec = (model: string, method: string, args: unknown[], kwargs?: unknown) => Promise<any>;
async function odooSession(): Promise<Exec> {
  const login = Deno.env.get('ODOO_USERNAME');
  const key = Deno.env.get('ODOO_API_KEY');
  if (!login || !key) throw new Error('Secrets ODOO_USERNAME / ODOO_API_KEY manquants');
  const db = await odooDb();
  const uid = await odoo('common', 'login', [db, login, key]);
  if (!uid) throw new Error('Connexion Odoo refusée (login, clé API ou base incorrects)');
  return (model, method, args, kwargs = {}) => odoo('object', 'execute_kw', [db, uid, key, model, method, args, kwargs]);
}

async function sendViaOdoo(exec: Exec, to: string, subject: string, html: string, attachmentIds: number[] = []) {
  const mailId = await exec('mail.mail', 'create', [{
    subject, body_html: html, email_to: to, reply_to: NOTIFY_EMAIL.split(',')[0].trim(), auto_delete: false,
    attachment_ids: [[6, 0, attachmentIds]],
  }]);
  await exec('mail.mail', 'send', [[mailId]]).catch(() => {});
}

// Adresses de toutes les personnes de la société : comptes actifs et invitations en attente.
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

function fiche(d: Record<string, any>) {
  return table([
    ['Prospect', d.prospect], ['Adresse', d.address], ['Région', d.region], ['Projet', d.project],
    ['Contact', [d.contact_name, d.contact_function].filter(Boolean).join(', ')],
    ['Téléphone', d.contact_phone], ['E-mail', d.contact_email],
    ['Disponibilité', [dateFr(d.available_on), d.available_note].filter(Boolean).join(' · ')],
  ]);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const { id, kind } = await req.json().catch(() => ({}));
  if (typeof id !== 'string' || !['assigned', 'answered'].includes(kind)) return new Response('Bad request', { status: 400 });
  const col = kind === 'assigned' ? 'notified_at' : 'answer_notified_at';

  // Réserve le dossier : un seul e-mail par étape, même si la fonction est appelée plusieurs fois.
  let q = sb.from('amb_dossiers').update({ [col]: new Date().toISOString() }).eq('id', id).is(col, null);
  if (kind === 'answered') q = q.not('answered_at', 'is', null);
  const { data: d } = await q.select().maybeSingle();
  if (!d) return new Response('Déjà notifié ou introuvable', { status: 200 });

  try {
    const { data: org } = await sb.from('amb_orgs').select('name').eq('id', d.org_id).maybeSingle();
    if (kind === 'assigned') {
      const to = await orgEmails(d.org_id);
      if (!to.length) throw new Error('Aucune personne rattachée à la société ' + (org?.name ?? ''));
      await sendViaOdoo(await odooSession(), to.join(','), `[RaYSun] Nouveau dossier pour ${org?.name ?? 'vous'} : ${d.prospect}`,
        `<p>Bonjour,</p><p>RaYSun vous confie un nouveau dossier : <b>${esc(d.prospect)}</b>.</p>` +
        (d.message ? `<p style="background:#FBEBDB;border-radius:10px;padding:10px 14px;white-space:pre-line">${esc(d.message)}</p>` : '') + fiche(d) +
        `<p>Merci de confirmer sur la plateforme que vous prenez ce dossier :<br>` +
        `<a href="${SITE}/dossiers.html">${SITE}/dossiers.html</a></p>` +
        `<p>Une question ? Répondez à cet e-mail.</p>`);
    } else {
      const exec = await odooSession();
      const who = `${d.answered_by_name ?? 'Un apporteur'} (${org?.name ?? ''})`;
      const att: number[] = [];
      let suite = '';
      if (d.status === 'Fiche traitée') {
        // La facture du prospect part chez RaYSun : jointe à l'e-mail et, si le dossier y est relié, à la fiche Odoo.
        if (d.invoice_path) {
          const { data: blob, error } = await sb.storage.from('amb-invoices').download(d.invoice_path);
          if (error || !blob) console.error('Facture illisible', d.invoice_path, error);
          else att.push(await exec('ir.attachment', 'create', [{
            name: `Facture ${d.prospect}.${d.invoice_path.split('.').pop()}`, datas: encodeBase64(new Uint8Array(await blob.arrayBuffer())),
            ...(d.odoo_lead_id ? { res_model: 'crm.lead', res_id: d.odoo_lead_id } : {}),
          }]));
        }
        suite = att.length ? '<p><b>La facture du prospect est jointe : la simulation peut être lancée.</b></p>'
          : '<p><b>Aucune facture jointe.</b> Demandez-la à l’apporteur dans la discussion du dossier.</p>';
      }
      if (d.odoo_lead_id && ['Fiche traitée', 'Perdu'].includes(d.status)) {
        const note = d.status === 'Perdu'
          ? `Dossier classé perdu par ${who} sur la plateforme apporteurs. Raison : ${d.answer_note ?? 'non précisée'}`
          : `Fiche traitée par ${who} sur la plateforme apporteurs.${d.answer_note ? ' ' + d.answer_note : ''}${att.length ? ' Facture jointe.' : ''}`;
        await exec('crm.lead', 'message_post', [[d.odoo_lead_id]], { body: note, attachment_ids: att }).catch((e) => console.error('Note Odoo', e));
        if (d.status === 'Perdu') {
          await exec('crm.lead', 'action_set_lost', [[d.odoo_lead_id]])
            .catch(() => exec('crm.lead', 'write', [[d.odoo_lead_id], { active: false, probability: 0 }]))
            .catch((e) => console.error('Fiche Odoo non marquée perdue', e));
          suite = '<p>La fiche Odoo est marquée perdue. Le dossier ne s’affiche plus chez l’apporteur ; un prochain apporteur verra qu’une tentative a déjà échoué.</p>';
        }
      }
      await sendViaOdoo(exec, NOTIFY_EMAIL, `[Apporteurs] ${org?.name ?? ''} : ${d.status} : ${d.prospect}`,
        `<p><b>${esc(d.answered_by_name ?? 'Un apporteur')}</b> (${esc(org?.name)}) a répondu <b>${esc(d.status)}</b> pour le dossier <b>${esc(d.prospect)}</b>.</p>` +
        suite + table([[d.status === 'Perdu' ? 'Raison' : 'Remarque', d.answer_note]]) + fiche(d) +
        (d.odoo_lead_id ? `<p><a href="${ODOO_URL}/odoo/crm/${d.odoo_lead_id}">Fiche Odoo</a></p>` : '') +
        `<p><a href="${SITE}/dossiers.html">Ouvrir les dossiers</a></p>`, att);
    }
    return new Response('ok');
  } catch (e) {
    console.error(e);
    await sb.from('amb_dossiers').update({ [col]: null }).eq('id', id);   // libère pour un nouvel essai
    return new Response(String(e), { status: 500 });
  }
});
