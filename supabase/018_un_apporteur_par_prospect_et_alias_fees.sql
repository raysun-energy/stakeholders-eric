-- Deux règles ajoutées le 23/11/2026.
-- 1. amb_orgs.fees_name : nom de la société dans l'outil Fees quand il diffère du nom de la fiche
--    (« Aurora » dans l'outil = « Aurora Energie » ici). La lecture de l'outil Fees s'y rapproche d'abord.
-- 2. Un prospect ne peut être confié qu'à un seul apporteur à la fois : la création d'un second dossier
--    pour la même fiche Odoo ou le même nom est refusée tant que le premier n'est ni refusé ni clôturé.
-- Le script peut être relancé sans risque. La fusion de la société « Aurora » dans « Aurora Energie »
-- a été faite une fois, en base, le même jour.

alter table public.amb_orgs add column if not exists fees_name text;

create or replace function public.amb_fees_replace(p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.amb_orgs (name)
  select distinct on (public.amb_norm(nm)) nm
  from (select trim(r->>'apporteur') as nm from jsonb_array_elements(p_rows) r) x
  where coalesce(nm, '') <> ''
    and not exists (select 1 from public.amb_orgs o
                    where public.amb_norm(nm) in (public.amb_norm(o.name), public.amb_norm(o.fees_name)))
  order by public.amb_norm(nm), nm;

  delete from public.amb_org_invoices where source = 'outil-fees';

  insert into public.amb_org_invoices (org_id, invoice_date, amount_eur, reference, label, source, period_month)
  select o.id,
         (to_date(r->>'mois', 'YYYY-MM') + interval '1 month - 1 day')::date,
         round(sum((r->>'montant')::numeric), 2),
         'Outil Fees',
         'Commissions ' || (r->>'mois'),
         'outil-fees', r->>'mois'
  from jsonb_array_elements(p_rows) r
  join public.amb_orgs o on public.amb_norm(r->>'apporteur') = public.amb_norm(coalesce(o.fees_name, o.name))
  where (r->>'mois') ~ '^\d{4}-\d{2}$'
  group by o.id, r->>'mois'
  having sum((r->>'montant')::numeric) > 0;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.amb_fees_replace(jsonb) from anon, authenticated, public;
grant execute on function public.amb_fees_replace(jsonb) to service_role;

create or replace function public.amb_dossier_unique()
returns trigger language plpgsql security definer set search_path = public as $$
declare autre text;
begin
  select o.name into autre
  from public.amb_dossiers d join public.amb_orgs o on o.id = d.org_id
  where d.id <> new.id and d.status not in ('Refusé', 'Clôturé')
    and ((new.odoo_lead_id is not null and d.odoo_lead_id = new.odoo_lead_id)
         or public.amb_norm(d.prospect) = public.amb_norm(new.prospect))
  limit 1;
  if autre is not null then
    raise exception 'Ce prospect est déjà confié à % : clôturez ce dossier avant de le confier à un autre apporteur', autre;
  end if;
  return new;
end $$;
revoke execute on function public.amb_dossier_unique() from anon, authenticated, public;

drop trigger if exists amb_dossier_unique on public.amb_dossiers;
create trigger amb_dossier_unique before insert on public.amb_dossiers
  for each row execute function public.amb_dossier_unique();
