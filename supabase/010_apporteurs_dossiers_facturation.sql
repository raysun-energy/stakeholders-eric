-- Apporteurs d'affaires : sociétés, dossiers affectés, facturation et classement.
-- Un apporteur d'affaires est une SOCIÉTÉ (ex. un installateur) ; plusieurs personnes peuvent y être rattachées.
-- Le script peut être relancé sans risque. Il n'enlève rien à l'existant.

-- 1. Sociétés et rattachement des membres ---------------------------------------

create table if not exists public.amb_orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (length(trim(name)) > 0),
  created_at timestamptz not null default now()
);

alter table public.amb_members add column if not exists org_id uuid references public.amb_orgs (id) on delete set null;
alter table public.amb_invites add column if not exists org_id uuid references public.amb_orgs (id) on delete set null;

-- Nouveau rôle « apporteur » (apporteur d'affaires), en plus des trois existants.
alter table public.amb_members drop constraint if exists amb_members_role_check;
alter table public.amb_members add constraint amb_members_role_check
  check (role in ('shareholder', 'ambassador', 'admin', 'apporteur'));
alter table public.amb_invites drop constraint if exists amb_invites_role_check;
alter table public.amb_invites add constraint amb_invites_role_check
  check (role in ('shareholder', 'ambassador', 'admin', 'apporteur'));

-- Société de l'utilisateur connecté (null s'il n'en a pas).
create or replace function public.amb_org()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.amb_members where user_id = auth.uid()
$$;

-- L'invitation transporte aussi la société.
create or replace function public.amb_accept_invite()
returns trigger language plpgsql security definer set search_path = public as $$
declare inv public.amb_invites;
begin
  select * into inv from public.amb_invites where email = lower(new.email);
  if found then
    insert into public.amb_members (user_id, role, name, organisation, org_id)
    values (new.id, inv.role, inv.name, inv.organisation, inv.org_id)
    on conflict (user_id) do update set role = excluded.role, name = excluded.name,
      organisation = coalesce(excluded.organisation, amb_members.organisation),
      org_id = coalesce(excluded.org_id, amb_members.org_id);
    delete from public.amb_invites where email = inv.email;
  end if;
  return new;
end $$;

-- Créer une société. Réservé à l'équipe.
create or replace function public.amb_create_org(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if public.amb_role() is distinct from 'admin' then raise exception 'Réservé à l’équipe'; end if;
  insert into public.amb_orgs (name) values (trim(p_name))
  on conflict (name) do update set name = excluded.name
  returning id into v;
  return v;
end $$;

-- Rattacher une personne à une société d'apporteurs (invitation si elle n'a pas encore de compte). Réservé à l'équipe.
-- Une personne déjà membre de l'équipe garde son rôle ; les autres deviennent « apporteur ».
create or replace function public.amb_upsert_apporteur(p_email text, p_name text, p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid; e text := lower(trim(p_email)); o text;
begin
  if public.amb_role() is distinct from 'admin' then raise exception 'Réservé à l’équipe'; end if;
  select name into o from public.amb_orgs where id = p_org;
  if o is null then raise exception 'Société inconnue'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Adresse e-mail invalide'; end if;
  select id into uid from auth.users where lower(email) = e;
  if uid is null then
    insert into public.amb_invites (email, role, name, organisation, org_id) values (e, 'apporteur', trim(p_name), o, p_org)
    on conflict (email) do update set role = 'apporteur', name = excluded.name, organisation = excluded.organisation, org_id = excluded.org_id;
  else
    insert into public.amb_members (user_id, role, name, organisation, org_id) values (uid, 'apporteur', trim(p_name), o, p_org)
    on conflict (user_id) do update set
      role = case when amb_members.role = 'admin' then 'admin' else 'apporteur' end,
      name = excluded.name, organisation = excluded.organisation, org_id = excluded.org_id;
  end if;
end $$;

-- Sociétés avec leurs personnes (comptes actifs et invitations en attente). Réservé à l'équipe.
create or replace function public.amb_list_orgs()
returns table (id uuid, name text, people jsonb)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, coalesce((
    select jsonb_agg(jsonb_build_object('email', t.email, 'name', t.name, 'pending', t.pending) order by t.pending, t.name)
    from (
      select u.email::text as email, m.name, false as pending
      from public.amb_members m join auth.users u on u.id = m.user_id where m.org_id = o.id
      union all
      select i.email, i.name, true from public.amb_invites i where i.org_id = o.id
    ) t), '[]'::jsonb)
  from public.amb_orgs o
  where public.amb_role() = 'admin'
  order by o.name
$$;

-- 2. Dossiers affectés à une société ----------------------------------------------

create table if not exists public.amb_dossiers (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  created_by          uuid default auth.uid() references auth.users (id) on delete set null,
  org_id              uuid not null references public.amb_orgs (id) on delete restrict,
  prospect            text not null check (length(trim(prospect)) > 0),
  address             text,
  region              text check (region in ('Bruxelles', 'Wallonie', 'Flandre')),
  project             text,
  contact_name        text,
  contact_function    text,
  contact_phone       text,
  contact_email       text,
  available_on        date,
  available_note      text,
  status              text not null default 'Proposé'
                      check (status in ('Proposé', 'Confirmé', 'Refusé', 'Visite faite', 'Clôturé')),
  answered_at         timestamptz,
  answered_by         uuid references auth.users (id) on delete set null,
  answered_by_name    text,
  answer_note         text,
  notified_at         timestamptz,   -- e-mail envoyé à la société
  answer_notified_at  timestamptz    -- e-mail de réponse envoyé à l'équipe
);
create index if not exists amb_dossiers_org_idx on public.amb_dossiers (org_id);

alter table public.amb_orgs     enable row level security;
alter table public.amb_dossiers enable row level security;
revoke all on public.amb_orgs, public.amb_dossiers from anon;

drop policy if exists "équipe gère les sociétés, un membre lit la sienne" on public.amb_orgs;
create policy "équipe gère les sociétés, un membre lit la sienne" on public.amb_orgs
  for select using (public.amb_role() = 'admin' or id = public.amb_org());

drop policy if exists "équipe lit tout, la société lit ses dossiers" on public.amb_dossiers;
create policy "équipe lit tout, la société lit ses dossiers" on public.amb_dossiers
  for select using (public.amb_role() = 'admin' or org_id = public.amb_org());

drop policy if exists "équipe crée les dossiers" on public.amb_dossiers;
create policy "équipe crée les dossiers" on public.amb_dossiers
  for insert with check (public.amb_role() = 'admin');

drop policy if exists "équipe modifie les dossiers" on public.amb_dossiers;
create policy "équipe modifie les dossiers" on public.amb_dossiers
  for update using (public.amb_role() = 'admin') with check (public.amb_role() = 'admin');

drop policy if exists "équipe supprime les dossiers" on public.amb_dossiers;
create policy "équipe supprime les dossiers" on public.amb_dossiers
  for delete using (public.amb_role() = 'admin');

-- Réponse de l'apporteur : il confirme (ou refuse) un dossier de SA société, puis signale la visite faite.
create or replace function public.amb_dossier_answer(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare d public.amb_dossiers;
begin
  select * into d from public.amb_dossiers where id = p_id;
  if not found or public.amb_role() is null
     or (public.amb_role() <> 'admin' and d.org_id is distinct from public.amb_org()) then
    raise exception 'Dossier introuvable';
  end if;
  if p_status not in ('Confirmé', 'Refusé', 'Visite faite') then raise exception 'Réponse inconnue'; end if;
  if p_status in ('Confirmé', 'Refusé') and d.status <> 'Proposé' then raise exception 'Ce dossier a déjà reçu une réponse'; end if;
  if p_status = 'Visite faite' and d.status <> 'Confirmé' then raise exception 'Confirmez d’abord le dossier'; end if;
  update public.amb_dossiers set
    status = p_status, answered_at = now(), answered_by = auth.uid(),
    answered_by_name = (select name from public.amb_members where user_id = auth.uid()),
    answer_note = nullif(trim(coalesce(p_note, '')), ''),
    answer_notified_at = null
  where id = p_id;
end $$;

-- Notifications par e-mail (fonction amb-dossier-notify, envoi par Odoo comme amb-notify) :
--   à la création : e-mail à toutes les personnes de la société ;
--   à chaque réponse de l'apporteur : e-mail à l'équipe.
create or replace function public.amb_dossier_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform net.http_post(
      url := 'https://wrexwthjavagzumuzlxx.supabase.co/functions/v1/amb-dossier-notify',
      body := jsonb_build_object('id', new.id, 'kind', 'assigned'),
      headers := '{"Content-Type": "application/json"}'::jsonb);
  elsif new.answered_at is distinct from old.answered_at and new.answer_notified_at is null then
    perform net.http_post(
      url := 'https://wrexwthjavagzumuzlxx.supabase.co/functions/v1/amb-dossier-notify',
      body := jsonb_build_object('id', new.id, 'kind', 'answered'),
      headers := '{"Content-Type": "application/json"}'::jsonb);
  end if;
  return new;
end $$;

drop trigger if exists amb_dossier_notify on public.amb_dossiers;
create trigger amb_dossier_notify after insert or update on public.amb_dossiers
  for each row execute function public.amb_dossier_notify();

-- Renvoyer l'e-mail d'affectation (par exemple après avoir ajouté une personne à la société). Réservé à l'équipe.
create or replace function public.amb_dossier_resend(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.amb_role() is distinct from 'admin' then raise exception 'Réservé à l’équipe'; end if;
  update public.amb_dossiers set notified_at = null where id = p_id;
  perform net.http_post(
    url := 'https://wrexwthjavagzumuzlxx.supabase.co/functions/v1/amb-dossier-notify',
    body := jsonb_build_object('id', p_id, 'kind', 'assigned'),
    headers := '{"Content-Type": "application/json"}'::jsonb);
end $$;

-- 3. Facturation des apporteurs ----------------------------------------------------

create table if not exists public.amb_org_invoices (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  org_id       uuid not null references public.amb_orgs (id) on delete cascade,
  invoice_date date not null,
  amount_eur   numeric(12, 2) not null check (amount_eur >= 0),   -- hors TVA
  reference    text,
  label        text
);
create index if not exists amb_org_invoices_org_idx on public.amb_org_invoices (org_id, invoice_date);

alter table public.amb_org_invoices enable row level security;
revoke all on public.amb_org_invoices from anon;

drop policy if exists "équipe lit tout, la société lit ses factures" on public.amb_org_invoices;
create policy "équipe lit tout, la société lit ses factures" on public.amb_org_invoices
  for select using (public.amb_role() = 'admin' or org_id = public.amb_org());

drop policy if exists "équipe saisit les factures" on public.amb_org_invoices;
create policy "équipe saisit les factures" on public.amb_org_invoices
  for insert with check (public.amb_role() = 'admin');

drop policy if exists "équipe corrige les factures" on public.amb_org_invoices;
create policy "équipe corrige les factures" on public.amb_org_invoices
  for update using (public.amb_role() = 'admin') with check (public.amb_role() = 'admin');

drop policy if exists "équipe supprime les factures" on public.amb_org_invoices;
create policy "équipe supprime les factures" on public.amb_org_invoices
  for delete using (public.amb_role() = 'admin');

-- Classement par période (trimestre et année) : part de chaque société dans le total facturé par tous les apporteurs.
-- Une société voit son montant et sa part, et la part des trois premières ; jamais le nom ni le montant des autres.
-- L'équipe (p_org renseigné ou non) voit tous les montants.
create or replace function public.amb_apporteur_stats(p_org uuid default null)
returns table (period text, kind text, own_amount numeric, own_share numeric, own_rank int, orgs int, total_amount numeric, podium jsonb)
language sql stable security definer set search_path = public as $$
  with me as (
    select case when public.amb_role() = 'admin' then p_org else public.amb_org() end as org,
           public.amb_role() = 'admin' as is_admin
  ),
  lignes as (
    select org_id, amount_eur, to_char(invoice_date, 'YYYY') as an,
           to_char(invoice_date, 'YYYY') || '-T' || to_char(invoice_date, 'Q') as trim
    from public.amb_org_invoices
  ),
  par as (
    select 'année' as kind, an as period, org_id, sum(amount_eur) as amount from lignes group by an, org_id
    union all
    select 'trimestre', trim, org_id, sum(amount_eur) from lignes group by trim, org_id
  ),
  classe as (
    select p.*, sum(amount) over w as total, count(*) over w as n,
           rank() over (partition by kind, period order by amount desc) as rang
    from par p window w as (partition by kind, period)
  )
  select c.period, c.kind,
    max(c.amount) filter (where c.org_id = me.org),
    max(case when c.total > 0 then round(100 * c.amount / c.total, 1) end) filter (where c.org_id = me.org),
    (max(c.rang) filter (where c.org_id = me.org))::int,
    max(c.n)::int,
    case when me.is_admin then max(c.total) end,
    jsonb_agg(jsonb_build_object(
      'rank', c.rang, 'name', case when me.is_admin or c.org_id = me.org then o.name end, 'me', c.org_id = me.org,
      'share', case when c.total > 0 then round(100 * c.amount / c.total, 1) else 0 end,
      'amount', case when me.is_admin or c.org_id = me.org then c.amount end
    ) order by c.rang, c.amount desc, o.id) filter (where c.rang <= 3 or me.is_admin)
  from classe c join public.amb_orgs o on o.id = c.org_id cross join me
  where public.amb_role() is not null and (me.is_admin or me.org is not null)
  group by c.period, c.kind, me.org, me.is_admin
  order by c.kind, c.period desc
$$;

-- 4. Droits -------------------------------------------------------------------------

grant select, insert, update, delete on public.amb_orgs, public.amb_dossiers, public.amb_org_invoices to authenticated;
grant all on public.amb_orgs, public.amb_dossiers, public.amb_org_invoices to service_role;

revoke execute on function public.amb_org() from anon, public;
revoke execute on function public.amb_create_org(text) from anon, public;
revoke execute on function public.amb_upsert_apporteur(text, text, uuid) from anon, public;
revoke execute on function public.amb_list_orgs() from anon, public;
revoke execute on function public.amb_dossier_answer(uuid, text, text) from anon, public;
revoke execute on function public.amb_dossier_resend(uuid) from anon, public;
revoke execute on function public.amb_apporteur_stats(uuid) from anon, public;
revoke execute on function public.amb_dossier_notify() from anon, authenticated, public;
grant execute on function public.amb_org() to authenticated;
grant execute on function public.amb_create_org(text) to authenticated;
grant execute on function public.amb_upsert_apporteur(text, text, uuid) to authenticated;
grant execute on function public.amb_list_orgs() to authenticated;
grant execute on function public.amb_dossier_answer(uuid, text, text) to authenticated;
grant execute on function public.amb_dossier_resend(uuid) to authenticated;
grant execute on function public.amb_apporteur_stats(uuid) to authenticated;
