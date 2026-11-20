-- Le rapprochement entre les apporteurs de l'outil Fees et les sociétés de l'espace apporteurs ignore la casse,
-- les accents et les espaces en double (« Aurora Énergie » dans l'outil = « Aurora Energie » créée depuis Odoo).
create or replace function public.amb_norm(p text)
returns text language sql immutable as $$
  select lower(regexp_replace(translate(trim(coalesce(p, '')),
    'ÀÂÄÉÈÊËÎÏÔÖÙÛÜÇàâäéèêëîïôöùûüç', 'AAAEEEEIIOOUUUCaaaeeeeiioouuuc'), '\s+', ' ', 'g'))
$$;

create or replace function public.amb_fees_replace(p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.amb_orgs (name)
  select distinct on (public.amb_norm(nm)) nm
  from (select trim(r->>'apporteur') as nm from jsonb_array_elements(p_rows) r) x
  where coalesce(nm, '') <> ''
    and not exists (select 1 from public.amb_orgs o where public.amb_norm(o.name) = public.amb_norm(nm))
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
  join public.amb_orgs o on public.amb_norm(o.name) = public.amb_norm(r->>'apporteur')
  where (r->>'mois') ~ '^\d{4}-\d{2}$'
  group by o.id, r->>'mois'
  having sum((r->>'montant')::numeric) > 0;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.amb_fees_replace(jsonb) from anon, authenticated, public;
grant execute on function public.amb_fees_replace(jsonb) to service_role;
