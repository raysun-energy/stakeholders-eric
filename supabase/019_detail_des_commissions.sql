-- Détail du calcul des commissions : une ligne par société, mois et EAN (client), comme dans l'outil Fees.
-- Rempli par la fonction amb-fees-sync à chaque lecture. Une société ne voit que ses propres lignes.
create table if not exists public.amb_org_fee_lines (
  id           bigint generated always as identity primary key,
  org_id       uuid not null references public.amb_orgs (id) on delete cascade,
  period_month text not null,          -- AAAA-MM
  operation    text,                   -- opération de partage
  client       text,                   -- nom du client chez l'apporteur
  ean          text,
  conso_kwh    numeric not null default 0,   -- consommation partagée
  inj_kwh      numeric not null default 0,   -- injection partagée
  tarif_conso  numeric not null default 0,   -- EUR/MWh
  tarif_prod   numeric not null default 0,   -- EUR/MWh
  fee_conso    numeric not null default 0,   -- toutes décimales gardées : c'est la somme qui s'arrondit
  fee_prod     numeric not null default 0
);
create index if not exists amb_org_fee_lines_idx on public.amb_org_fee_lines (org_id, period_month);

alter table public.amb_org_fee_lines enable row level security;
revoke all on public.amb_org_fee_lines from anon;
grant select on public.amb_org_fee_lines to authenticated;
grant all on public.amb_org_fee_lines to service_role;

drop policy if exists "équipe lit tout, la société lit son détail" on public.amb_org_fee_lines;
create policy "équipe lit tout, la société lit son détail" on public.amb_org_fee_lines
  for select using (public.amb_role() = 'admin' or org_id = public.amb_org());

-- Remplace le détail par le dernier calcul. Réservé au rôle de service (fonction amb-fees-sync), après amb_fees_replace.
create or replace function public.amb_fee_lines_replace(p_lines jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.amb_org_fee_lines where true;
  insert into public.amb_org_fee_lines (org_id, period_month, operation, client, ean, conso_kwh, inj_kwh, tarif_conso, tarif_prod, fee_conso, fee_prod)
  select o.id, r->>'mois', r->>'operation', r->>'client', r->>'ean',
         coalesce((r->>'conso_kwh')::numeric, 0), coalesce((r->>'inj_kwh')::numeric, 0),
         coalesce((r->>'tarif_conso')::numeric, 0), coalesce((r->>'tarif_prod')::numeric, 0),
         coalesce((r->>'fee_conso')::numeric, 0), coalesce((r->>'fee_prod')::numeric, 0)
  from jsonb_array_elements(p_lines) r
  join public.amb_orgs o on public.amb_norm(r->>'apporteur') = public.amb_norm(coalesce(o.fees_name, o.name))
  where (r->>'mois') ~ '^\d{4}-\d{2}$';
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.amb_fee_lines_replace(jsonb) from anon, authenticated, public;
grant execute on function public.amb_fee_lines_replace(jsonb) to service_role;
