-- Dossiers des apporteurs : « Fiche traitée » remplace « Visite faite » (tous les dossiers n'ont pas de visite) et
-- transmet la facture d'électricité du prospect à RaYSun pour la simulation ; « Perdu » classe le dossier,
-- le retire de la plateforme et en garde la trace pour l'apporteur suivant.

alter table public.amb_dossiers drop constraint if exists amb_dossiers_status_check;
update public.amb_dossiers set status = 'Fiche traitée' where status = 'Visite faite';
alter table public.amb_dossiers add constraint amb_dossiers_status_check
  check (status in ('Proposé', 'Confirmé', 'Refusé', 'Fiche traitée', 'Perdu', 'Clôturé'));
alter table public.amb_dossiers
  add column if not exists invoice_path     text,          -- facture du prospect (compartiment amb-invoices)
  add column if not exists lost_at          timestamptz,   -- date du classement « Perdu »
  add column if not exists previous_lost_at timestamptz;   -- un autre apporteur a déjà tenté ce prospect, perdu à cette date
alter table public.zc_candidats add column if not exists perdu_le timestamptz;

-- Réponse de l'apporteur (ou de l'équipe) sur un dossier.
drop function if exists public.amb_dossier_answer(uuid, text, text);
create or replace function public.amb_dossier_answer(p_id uuid, p_status text, p_note text default null, p_invoice text default null)
returns void language plpgsql security definer set search_path = public as $$
declare d public.amb_dossiers; v_status text := case when p_status = 'Visite faite' then 'Fiche traitée' else p_status end;
        v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into d from public.amb_dossiers where id = p_id;
  if not found or public.amb_role() is null
     or (public.amb_role() <> 'admin' and d.org_id is distinct from public.amb_org()) then
    raise exception 'Dossier introuvable';
  end if;
  if v_status not in ('Confirmé', 'Refusé', 'Fiche traitée', 'Perdu') then raise exception 'Réponse inconnue'; end if;
  if v_status in ('Confirmé', 'Refusé') and d.status <> 'Proposé' then raise exception 'Ce dossier a déjà reçu une réponse'; end if;
  if v_status = 'Fiche traitée' and d.status <> 'Confirmé' then raise exception 'Confirmez d’abord le dossier'; end if;
  if v_status = 'Perdu' then
    if d.status not in ('Proposé', 'Confirmé', 'Fiche traitée') then raise exception 'Ce dossier est déjà classé'; end if;
    if v_note is null then raise exception 'Indiquez d’abord la raison de la perte'; end if;
  end if;
  if p_invoice is not null and p_invoice not like auth.uid()::text || '/%' then raise exception 'Facture invalide'; end if;
  update public.amb_dossiers set
    status = v_status, answered_at = now(), answered_by = auth.uid(),
    answered_by_name = (select name from public.amb_members where user_id = auth.uid()),
    answer_note = v_note, answer_notified_at = null,
    invoice_path = coalesce(p_invoice, invoice_path),
    lost_at = case when v_status = 'Perdu' then now() else lost_at end
  where id = p_id;
  -- Perdu : l'entreprise redevient proposable sur la carte, avec la date de la tentative précédente.
  if v_status = 'Perdu' and d.odoo_lead_id is not null then
    update public.zc_candidats set statut = 'nouveau', perdu_le = now(), odoo_lead_id = null,
           envoye_par = null, envoye_par_nom = null, envoye_par_org = null, envoye_le = null, updated_at = now()
    where odoo_lead_id = d.odoo_lead_id;
  end if;
end $$;
revoke execute on function public.amb_dossier_answer(uuid, text, text, text) from anon, public;
grant execute on function public.amb_dossier_answer(uuid, text, text, text) to authenticated;

-- Un seul apporteur par prospect ; un dossier perdu ne bloque plus, mais sa date est notée sur le dossier suivant.
create or replace function public.amb_dossier_unique()
returns trigger language plpgsql security definer set search_path = public as $$
declare autre text;
begin
  select o.name into autre
  from public.amb_dossiers d join public.amb_orgs o on o.id = d.org_id
  where d.id <> new.id and d.status not in ('Refusé', 'Clôturé', 'Perdu')
    and ((new.odoo_lead_id is not null and d.odoo_lead_id = new.odoo_lead_id)
         or public.amb_norm(d.prospect) = public.amb_norm(new.prospect))
  limit 1;
  if autre is not null then
    raise exception 'Ce prospect est déjà confié à % : clôturez ce dossier avant de le confier à un autre apporteur', autre;
  end if;
  new.previous_lost_at := (select max(d.lost_at) from public.amb_dossiers d
    where d.id <> new.id and d.status = 'Perdu' and d.org_id is distinct from new.org_id
      and ((new.odoo_lead_id is not null and d.odoo_lead_id = new.odoo_lead_id)
           or public.amb_norm(d.prospect) = public.amb_norm(new.prospect)));
  return new;
end $$;

-- Recherche autour d'un point : une entreprise dont le dossier a été perdu reste proposée, avec la date.
drop function if exists public.amb_candidates_around(double precision, double precision, integer, integer, integer);
create function public.amb_candidates_around(p_lat double precision, p_lng double precision, p_radius_m integer default 1000,
                                             p_min_conso_kwh integer default 0, p_min_toit_m2 integer default 0)
returns table (id text, nom text, adresse text, lat double precision, lng double precision, categorie text,
               conso_min_kwh integer, conso_max_kwh integer, surface_toit_m2 integer, pv_max_kwh_an integer,
               telephone text, email text, site_web text,
               contact_nom text, contact_fonction text, contact_tel text, contact_email text,
               distance_m integer, total bigint, perdu_le timestamptz)
language sql stable security definer set search_path = public as $$
  with r as (select least(greatest(coalesce(p_radius_m, 1000), 100), 5000)::double precision as m),
  zone as (
    select c.*, 6371000 * 2 * asin(sqrt(power(sin(radians(c.lat - p_lat) / 2), 2)
              + cos(radians(p_lat)) * cos(radians(c.lat)) * power(sin(radians(c.lng - p_lng) / 2), 2))) as d
    from public.zc_candidats c, r
    where public.amb_role() is not null
      and c.lat between p_lat - r.m / 111320 and p_lat + r.m / 111320
      and c.lng between p_lng - r.m / (111320 * cos(radians(p_lat))) and p_lng + r.m / (111320 * cos(radians(p_lat)))
      and c.statut = 'nouveau' and (not coalesce(c.dans_crm, false) or c.perdu_le is not null)
      and (p_min_conso_kwh <= 0 or coalesce(c.conso_min_kwh, 0) >= p_min_conso_kwh)
      and (p_min_toit_m2 <= 0 or coalesce(c.surface_toit_m2, 0) >= p_min_toit_m2)
  )
  select z.place_id, z.nom, z.adresse, z.lat, z.lng, z.categorie,
         z.conso_min_kwh, z.conso_max_kwh, z.surface_toit_m2, z.pv_max_kwh_an,
         nullif(trim(z.telephone), ''), nullif(trim(z.email), ''), nullif(trim(z.site_web), ''),
         nullif(trim(z.contact_nom), ''), nullif(trim(z.contact_fonction), ''), nullif(trim(z.contact_tel), ''), nullif(trim(z.contact_email), ''),
         round(z.d)::integer, count(*) over (), z.perdu_le
  from zone z, r
  where z.d <= r.m
  order by greatest(coalesce(z.conso_max_kwh, 0), coalesce(z.pv_max_kwh_an, 0)) desc, z.d
  limit 200
$$;
revoke execute on function public.amb_candidates_around(double precision, double precision, integer, integer, integer) from anon, public;
grant execute on function public.amb_candidates_around(double precision, double precision, integer, integer, integer) to authenticated;
