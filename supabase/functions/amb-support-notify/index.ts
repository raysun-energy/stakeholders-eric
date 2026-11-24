// Bouton « Support » de la carte : à chaque demande (bug ou amélioration), crée une tâche dans l'Odoo d'Eric
// et lui envoie un e-mail, captures d'écran jointes aux deux.
// Appelée par la base (trigger amb_support_notify) avec { id } uniquement : la fonction relit la ligne elle-même
// et ne la traite qu'une fois. Secrets : ODOO_USERNAME, ODOO_API_KEY (compte d'Eric), optionnels ODOO_URL, ODOO_DB, NOTIFY_EMAIL.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { encodeBase64 } from 'jsr:@std/encoding@1/base64';

const SITE = 'https://citywatt-ambassadeurs.netlify.app';
const ODOO_URL = Deno.env.get('ODOO_URL') ?? 'https://raysun.odoo.com';
const NOTIFY_EMAIL = Deno.env.get('NOTIFY_EMAIL') ?? 'eric.rw@raysun.solar';
const ROLES: Record<string, string> = { shareholder: 'Actionnaire', ambassador: 'Ambassadeur', apporteur: 'Apporteur d’affaires', admin: 'Équipe' };
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

async function rpc(service: string, method: string, args: unknown[]) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args } }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.data?.message ?? json.error.message);
  return json.result;
}

async function odooSession() {
  const login = Deno.env.get('ODOO_USERNAME'), key = Deno.env.get('ODOO_API_KEY');
  if (!login || !key) throw new Error('Secrets ODOO_USERNAME / ODOO_API_KEY manquants');
  let db = Deno.env.get('ODOO_DB');
  if (!db) {
    const list = await rpc('db', 'list', []).catch(() => null);
    db = Array.isArray(list) && list.length === 1 ? list[0] : new URL(ODOO_URL).hostname.split('.')[0];
  }
  const uid = await rpc('common', 'login', [db, login, key]);
  if (!uid) throw new Error('Connexion Odoo refusée');
  return { uid, exec: (model: string, method: string, args: unknown[]) => rpc('object', 'execute_kw', [db, uid, key, model, method, args]) };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const { id } = await req.json().catch(() => ({}));
  if (typeof id !== 'string') return new Response('Bad request', { status: 400 });
  // Réserve la ligne : un seul traitement, même si la fonction est appelée plusieurs fois.
  const { data: r } = await sb.from('amb_support').update({ notified_at: new Date().toISOString() })
    .eq('id', id).is('notified_at', null).select().maybeSingle();
  if (!r) return new Response('Déjà traité ou introuvable', { status: 200 });

  try {
    const { data: m } = r.author_id ? await sb.from('amb_members').select('role').eq('user_id', r.author_id).maybeSingle() : { data: null };
    const who = `${r.author_name ?? 'Un utilisateur'}${m ? ` (${ROLES[m.role] ?? m.role})` : ''}`;
    const bug = r.kind === 'Bug';
    const title = `[Carte CityWatt] ${bug ? 'Bug' : 'Amélioration'} : ${String(r.message).replace(/\s+/g, ' ').slice(0, 70)}`;
    const body = `<p><b>${esc(who)}</b> ${bug ? 'signale un bug' : 'demande une amélioration'} (page : ${esc(r.page)}).</p>`
      + `<p style="white-space:pre-wrap">${esc(r.message)}</p>`;

    const { uid, exec } = await odooSession();
    // Tâche personnelle d'Eric (le compte Odoo de la fonction), sans projet.
    const taskId = await exec('project.task', 'create', [{ name: title, description: body, user_ids: [[6, 0, [uid]]] }]);
    const attIds: number[] = [];
    for (const [k, path] of (r.screenshots ?? []).entries()) {
      const { data: blob, error } = await sb.storage.from('amb-support').download(path);
      if (error || !blob) { console.error('Capture illisible', path, error); continue; }
      attIds.push(await exec('ir.attachment', 'create', [{
        name: `capture-${k + 1}.${path.split('.').pop()}`, datas: encodeBase64(new Uint8Array(await blob.arrayBuffer())),
        res_model: 'project.task', res_id: taskId, mimetype: blob.type || undefined,
      }]));
    }
    await sb.from('amb_support').update({ odoo_task_id: taskId }).eq('id', id);
    const mailId = await exec('mail.mail', 'create', [{
      subject: title, email_to: NOTIFY_EMAIL, auto_delete: false, attachment_ids: [[6, 0, attIds]],
      body_html: body + `<p><a href="${ODOO_URL}/odoo/action-project.action_view_all_task/${taskId}">Ouvrir la tâche dans Odoo</a> · <a href="${SITE}">Carte</a></p>`,
    }]);
    await exec('mail.mail', 'send', [[mailId]]).catch(() => {});
    return new Response('ok');
  } catch (e) {
    console.error(e);
    await sb.from('amb_support').update({ notified_at: null }).eq('id', id);   // pour pouvoir réessayer
    return new Response(String(e), { status: 500 });
  }
});
