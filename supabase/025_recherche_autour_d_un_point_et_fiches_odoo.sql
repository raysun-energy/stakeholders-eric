-- Recherche d'entreprises autour d'un point (membre, lieu cliqué ou adresse), ouverte à tous les membres connectés.
-- Les entreprises ne sont plus affichées en permanence sur la carte : elles sortent en liste, pour un rayon et des critères donnés.
-- Création de fiche Odoo depuis cette liste : elle arrive dans les dossiers de l'apporteur, ou dans le suivi équipe.

alter table public.zc_candidats
  add column if not exists contact_nom      text,
  add column if not exists contact_fonction text,
  add column if not exists contact_tel      text,
  add column if not exists contact_email    text,
  add column if not exists envoye_par       uuid,
  add column if not exists envoye_par_nom   text,
  add column if not exists envoye_par_org   text,
  add column if not exists envoye_le        timestamptz;

-- 1. Liste des entreprises dans un rayon, les plus proches d'abord.
create or replace function public.amb_candidates_around(p_lat double precision, p_lng double precision, p_radius_m integer default 1000,
                                                        p_min_conso_kwh integer default 0, p_min_toit_m2 integer default 0)
returns table (id text, nom text, adresse text, lat double precision, lng double precision, categorie text,
               conso_min_kwh integer, conso_max_kwh integer, surface_toit_m2 integer, pv_max_kwh_an integer,
               telephone text, email text, site_web text,
               contact_nom text, contact_fonction text, contact_tel text, contact_email text,
               distance_m integer, total bigint)
language sql stable security definer set search_path = public as $$
  with r as (select least(greatest(coalesce(p_radius_m, 1000), 100), 5000)::double precision as m),
  zone as (
    select c.*, 6371000 * 2 * asin(sqrt(power(sin(radians(c.lat - p_lat) / 2), 2)
              + cos(radians(p_lat)) * cos(radians(c.lat)) * power(sin(radians(c.lng - p_lng) / 2), 2))) as d
    from public.zc_candidats c, r
    where public.amb_role() is not null
      and c.lat between p_lat - r.m / 111320 and p_lat + r.m / 111320
      and c.lng between p_lng - r.m / (111320 * cos(radians(p_lat))) and p_lng + r.m / (111320 * cos(radians(p_lat)))
      and c.statut = 'nouveau' and not coalesce(c.dans_crm, false)
      and (p_min_conso_kwh <= 0 or coalesce(c.conso_min_kwh, 0) >= p_min_conso_kwh)
      and (p_min_toit_m2 <= 0 or coalesce(c.surface_toit_m2, 0) >= p_min_toit_m2)
  )
  select z.place_id, z.nom, z.adresse, z.lat, z.lng, z.categorie,
         z.conso_min_kwh, z.conso_max_kwh, z.surface_toit_m2, z.pv_max_kwh_an,
         nullif(trim(z.telephone), ''), nullif(trim(z.email), ''), nullif(trim(z.site_web), ''),
         nullif(trim(z.contact_nom), ''), nullif(trim(z.contact_fonction), ''), nullif(trim(z.contact_tel), ''), nullif(trim(z.contact_email), ''),
         round(z.d)::integer, count(*) over ()
  from zone z, r
  where z.d <= r.m
  order by greatest(coalesce(z.conso_max_kwh, 0), coalesce(z.pv_max_kwh_an, 0)) desc, z.d
  limit 200
$$;
revoke execute on function public.amb_candidates_around(double precision, double precision, integer, integer, integer) from anon, public;
grant execute on function public.amb_candidates_around(double precision, double precision, integer, integer, integer) to authenticated;

-- 2. Après la création de la fiche Odoo par un apporteur : le dossier entre dans l'espace de sa société, déjà confirmé.
--    Sans effet pour l'équipe et les ambassadeurs (leurs fiches sont listées dans le suivi équipe).
create or replace function public.amb_candidate_to_dossier(p_place_id text)
returns uuid language plpgsql security definer set search_path = public as $$
declare c public.zc_candidats; v_org uuid; v_name text; v_id uuid;
begin
  if public.amb_role() is distinct from 'apporteur' then return null; end if;
  v_org := public.amb_org();
  if v_org is null then return null; end if;
  select * into c from public.zc_candidats where place_id = p_place_id;
  if c.place_id is null or c.odoo_lead_id is null or c.envoye_par is distinct from auth.uid() then
    raise exception 'Fiche Odoo introuvable pour cette entreprise';
  end if;
  select id into v_id from public.amb_dossiers where odoo_lead_id = c.odoo_lead_id and org_id = v_org limit 1;
  if v_id is not null then return v_id; end if;
  select name into v_name from public.amb_members where user_id = auth.uid();
  insert into public.amb_dossiers (org_id, prospect, address, region, project, contact_name, contact_function, contact_phone, contact_email,
                                   status, answered_at, answered_by, answered_by_name, notified_at, odoo_lead_id, lat, lng)
  values (v_org, c.nom, c.adresse, case when c.region in ('Bruxelles', 'Wallonie', 'Flandre') then c.region end,
          'Prospect trouvé sur la carte par l’apporteur.', c.contact_nom, c.contact_fonction,
          coalesce(nullif(trim(c.contact_tel), ''), c.telephone), coalesce(nullif(trim(c.contact_email), ''), c.email),
          'Confirmé', now(), auth.uid(), v_name, now(), c.odoo_lead_id, c.lat, c.lng)
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.amb_candidate_to_dossier(text) from anon, public;
grant execute on function public.amb_candidate_to_dossier(text) to authenticated;

-- 3. Équipe : personne de contact d'une entreprise (affichée dans la liste de recherche).
create or replace function public.amb_candidate_set_contact(p_place_id text, p_nom text, p_fonction text, p_tel text, p_email text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.amb_role() is distinct from 'admin' then raise exception 'Réservé à l’équipe'; end if;
  update public.zc_candidats set contact_nom = nullif(trim(p_nom), ''), contact_fonction = nullif(trim(p_fonction), ''),
         contact_tel = nullif(trim(p_tel), ''), contact_email = nullif(trim(p_email), ''), updated_at = now()
  where place_id = p_place_id;
end $$;
revoke execute on function public.amb_candidate_set_contact(text, text, text, text, text) from anon, public;
grant execute on function public.amb_candidate_set_contact(text, text, text, text, text) to authenticated;

-- 4. Suivi équipe : fiches Odoo créées depuis la carte.
create or replace function public.amb_map_fiches()
returns table (place_id text, nom text, adresse text, envoye_le timestamptz, envoye_par_nom text, envoye_par_org text, odoo_lead_id integer)
language sql stable security definer set search_path = public as $$
  select c.place_id, c.nom, c.adresse, c.envoye_le, c.envoye_par_nom, c.envoye_par_org, c.odoo_lead_id
  from public.zc_candidats c
  where public.amb_role() = 'admin' and c.envoye_le is not null and c.odoo_lead_id is not null
  order by c.envoye_le desc limit 500
$$;
revoke execute on function public.amb_map_fiches() from anon, public;
grant execute on function public.amb_map_fiches() to authenticated;
