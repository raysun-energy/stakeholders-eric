-- Entreprises à démarcher : téléphone, e-mail et site web visibles par tous les membres connectés (fiche et export).
-- Remplace les deux fonctions du script 023 (mêmes filtres), avec trois colonnes de plus.
drop function if exists public.amb_candidates(double precision, double precision, double precision, double precision, integer, integer);
create or replace function public.amb_candidates(p_min_lat double precision, p_max_lat double precision,
                                      p_min_lng double precision, p_max_lng double precision,
                                      p_min_conso_kwh integer default 0, p_min_toit_m2 integer default 0)
returns table (id text, nom text, adresse text, lat double precision, lng double precision, categorie text,
               conso_min_kwh integer, conso_max_kwh integer, surface_toit_m2 integer, pv_max_kwh_an integer, total bigint,
               telephone text, email text, site_web text)
language sql stable security definer set search_path = public as $$
  with zone as (
    select c.* from public.zc_candidats c
    where public.amb_role() is not null
      and c.lat between p_min_lat and p_max_lat and c.lng between p_min_lng and p_max_lng
      and c.statut = 'nouveau' and not coalesce(c.dans_crm, false)
      and (p_min_conso_kwh <= 0 or coalesce(c.conso_min_kwh, 0) >= p_min_conso_kwh)
      and (p_min_toit_m2 <= 0 or coalesce(c.surface_toit_m2, 0) >= p_min_toit_m2)
  )
  select z.place_id, z.nom, z.adresse, z.lat, z.lng, z.categorie,
         z.conso_min_kwh, z.conso_max_kwh, z.surface_toit_m2, z.pv_max_kwh_an, count(*) over (),
         nullif(trim(z.telephone), ''), nullif(trim(z.email), ''), nullif(trim(z.site_web), '')
  from zone z
  order by greatest(coalesce(z.conso_max_kwh, 0), coalesce(z.pv_max_kwh_an, 0)) desc
  limit 300
$$;
revoke execute on function public.amb_candidates(double precision, double precision, double precision, double precision, integer, integer) from anon, public;
grant execute on function public.amb_candidates(double precision, double precision, double precision, double precision, integer, integer) to authenticated;

drop function if exists public.amb_candidates_export(integer, integer, integer);
create or replace function public.amb_candidates_export(p_offset integer default 0, p_min_conso_kwh integer default 0, p_min_toit_m2 integer default 0)
returns table (nom text, adresse text, region text, categorie text, conso_min_kwh integer, conso_max_kwh integer,
               surface_toit_m2 integer, pv_max_kwh_an integer, lat double precision, lng double precision,
               telephone text, email text, site_web text)
language sql stable security definer set search_path = public as $$
  select c.nom, c.adresse, c.region, c.categorie, c.conso_min_kwh, c.conso_max_kwh, c.surface_toit_m2, c.pv_max_kwh_an, c.lat, c.lng,
         nullif(trim(c.telephone), ''), nullif(trim(c.email), ''), nullif(trim(c.site_web), '')
  from public.zc_candidats c
  where public.amb_role() is not null and c.statut = 'nouveau' and not coalesce(c.dans_crm, false)
    and (p_min_conso_kwh <= 0 or coalesce(c.conso_min_kwh, 0) >= p_min_conso_kwh)
    and (p_min_toit_m2 <= 0 or coalesce(c.surface_toit_m2, 0) >= p_min_toit_m2)
  order by c.place_id
  offset greatest(p_offset, 0) limit 1000
$$;
revoke execute on function public.amb_candidates_export(integer, integer, integer) from anon, public;
grant execute on function public.amb_candidates_export(integer, integer, integer) to authenticated;
