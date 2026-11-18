-- Espace apporteurs : les montants viennent de l'outil Fees (boîte à outils interne), relu chaque nuit.
-- La fonction amb-fees-sync lit le document de l'outil Fees, recalcule les commissions par apporteur et par mois
-- (volume partagé × tarif de l'EAN, comme le moteur de l'outil) et remplace les lignes « outil-fees » ci-dessous.
-- Le script peut être relancé sans risque.

alter table public.amb_org_invoices add column if not exists source text not null default 'manuel';
alter table public.amb_org_invoices add column if not exists period_month text;   -- AAAA-MM pour les lignes de l'outil Fees
create unique index if not exists amb_org_invoices_fees_idx
  on public.amb_org_invoices (org_id, period_month) where source = 'outil-fees';

-- Deux sociétés ne peuvent pas porter le même nom à la casse près.
create unique index if not exists amb_orgs_name_lower_idx on public.amb_orgs (lower(name));

-- Remplace toutes les lignes de l'outil Fees par le dernier calcul. Réservé au rôle de service (fonction amb-fees-sync).
-- p_rows : [{ "apporteur": "Nom de la société", "mois": "AAAA-MM", "montant": 123.45 }, ...]
-- Une société absente est créée, pour que le classement compte tous les apporteurs.
create or replace function public.amb_fees_replace(p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.amb_orgs (name)
  select distinct on (lower(nm)) nm
  from (select trim(r->>'apporteur') as nm from jsonb_array_elements(p_rows) r) x
  where coalesce(nm, '') <> ''
    and not exists (select 1 from public.amb_orgs o where lower(o.name) = lower(nm))
  order by lower(nm), nm;

  delete from public.amb_org_invoices where source = 'outil-fees';

  insert into public.amb_org_invoices (org_id, invoice_date, amount_eur, reference, label, source, period_month)
  select o.id,
         (to_date(r->>'mois', 'YYYY-MM') + interval '1 month - 1 day')::date,
         round(sum((r->>'montant')::numeric), 2),
         'Outil Fees',
         'Commissions ' || (r->>'mois'),
         'outil-fees', r->>'mois'
  from jsonb_array_elements(p_rows) r
  join public.amb_orgs o on lower(o.name) = lower(trim(r->>'apporteur'))
  where (r->>'mois') ~ '^\d{4}-\d{2}$'
  group by o.id, r->>'mois'
  having sum((r->>'montant')::numeric) > 0;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.amb_fees_replace(jsonb) from anon, authenticated, public;
grant execute on function public.amb_fees_replace(jsonb) to service_role;

-- État de la dernière lecture (date, résultat), visible par l'équipe dans la page.
create table if not exists public.amb_fees_sync (
  id         boolean primary key default true check (id),
  at         timestamptz not null default now(),
  ok         boolean not null,
  message    text,
  source_at  timestamptz          -- dernière modification du document dans l'outil Fees
);
alter table public.amb_fees_sync enable row level security;
revoke all on public.amb_fees_sync from anon;
grant select on public.amb_fees_sync to authenticated;
grant all on public.amb_fees_sync to service_role;
drop policy if exists "équipe lit l'état de la lecture" on public.amb_fees_sync;
create policy "équipe lit l'état de la lecture" on public.amb_fees_sync
  for select using (public.amb_role() = 'admin');

-- Lancer la lecture maintenant. Réservé à l'équipe.
create or replace function public.amb_fees_sync_now()
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.amb_role() is distinct from 'admin' then raise exception 'Réservé à l’équipe'; end if;
  perform net.http_post(
    url := 'https://wrexwthjavagzumuzlxx.supabase.co/functions/v1/amb-fees-sync',
    body := '{}'::jsonb, headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 60000);
end $$;
revoke execute on function public.amb_fees_sync_now() from anon, public;
grant execute on function public.amb_fees_sync_now() to authenticated;

-- Lecture automatique chaque nuit à 2 h 15 UTC.
select cron.unschedule(jobid) from cron.job where jobname = 'amb-fees-sync';
select cron.schedule('amb-fees-sync', '15 2 * * *', $cron$
  select net.http_post(
    url := 'https://wrexwthjavagzumuzlxx.supabase.co/functions/v1/amb-fees-sync',
    body := '{}'::jsonb, headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 60000);
$cron$);
