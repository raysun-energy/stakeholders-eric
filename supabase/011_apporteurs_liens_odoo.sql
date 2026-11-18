-- Espace apporteurs : lien avec Odoo. La société vient d'une fiche contact, le prospect d'une fiche du CRM.
-- Le script peut être relancé sans risque.

alter table public.amb_orgs     add column if not exists odoo_partner_id integer;
alter table public.amb_dossiers add column if not exists odoo_lead_id    integer;

-- Créer une société, éventuellement liée à une fiche contact Odoo. Réservé à l'équipe.
drop function if exists public.amb_create_org(text);
create or replace function public.amb_create_org(p_name text, p_odoo_partner integer default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if public.amb_role() is distinct from 'admin' then raise exception 'Réservé à l’équipe'; end if;
  insert into public.amb_orgs (name, odoo_partner_id) values (trim(p_name), p_odoo_partner)
  on conflict (name) do update set odoo_partner_id = coalesce(excluded.odoo_partner_id, amb_orgs.odoo_partner_id)
  returning id into v;
  return v;
end $$;

revoke execute on function public.amb_create_org(text, integer) from anon, public;
grant execute on function public.amb_create_org(text, integer) to authenticated;
