-- 23/11/2026. La page Zoning as Community est retirée du site Suivi vendeurs ; ses données restent utilisées par la carte.
-- 1. Les tables zc_* ne sont plus lisibles ni modifiables avec la clé publique (elles l'étaient pour tout le monde).
--    Les fonctions serveur (clé de service) et les fonctions amb_* (security definer) continuent d'y accéder.
drop policy if exists "zc read" on public.zc_bce;
drop policy if exists "zc read" on public.zc_candidats;
drop policy if exists "zc upd"  on public.zc_candidats;
drop policy if exists "zc read" on public.zc_membres;
drop policy if exists "zc read" on public.zc_nace;
drop policy if exists "zc read" on public.zc_zonings;
drop policy if exists "zc write" on public.zc_zonings;
drop policy if exists "zc del"  on public.zc_zonings;
revoke all on public.zc_bce, public.zc_candidats, public.zc_membres, public.zc_nace, public.zc_secrets, public.zc_zonings from anon, authenticated;

-- 2. Entreprises à démarcher : plus de limite sur la taille de la zone demandée (300 points affichés au plus).
create or replace function public.amb_candidates(p_min_lat double precision, p_max_lat double precision,
                                                 p_min_lng double precision, p_max_lng double precision)
returns table (id text, nom text, adresse text, lat double precision, lng double precision, categorie text,
               conso_min_kwh integer, conso_max_kwh integer, surface_toit_m2 integer, pv_max_kwh_an integer, total bigint)
language sql stable security definer set search_path = public as $$
  with zone as (
    select c.* from public.zc_candidats c
    where public.amb_role() is not null
      and c.lat between p_min_lat and p_max_lat and c.lng between p_min_lng and p_max_lng
      and c.statut = 'nouveau' and not coalesce(c.dans_crm, false)
  )
  select z.place_id, z.nom, z.adresse, z.lat, z.lng, z.categorie,
         z.conso_min_kwh, z.conso_max_kwh, z.surface_toit_m2, z.pv_max_kwh_an, count(*) over ()
  from zone z
  order by greatest(coalesce(z.conso_max_kwh, 0), coalesce(z.pv_max_kwh_an, 0)) desc
  limit 300
$$;

-- 3. Export en bloc de la liste, par pages de 1000 (limite de l'API), pour tout membre connecté.
--    Mêmes colonnes que la fiche : ni téléphone ni e-mail, entreprises pas encore approchées seulement.
create or replace function public.amb_candidates_export(p_offset integer default 0)
returns table (nom text, adresse text, region text, categorie text, conso_min_kwh integer, conso_max_kwh integer,
               surface_toit_m2 integer, pv_max_kwh_an integer, lat double precision, lng double precision)
language sql stable security definer set search_path = public as $$
  select c.nom, c.adresse, c.region, c.categorie, c.conso_min_kwh, c.conso_max_kwh, c.surface_toit_m2, c.pv_max_kwh_an, c.lat, c.lng
  from public.zc_candidats c
  where public.amb_role() is not null and c.statut = 'nouveau' and not coalesce(c.dans_crm, false)
  order by c.place_id
  offset greatest(p_offset, 0) limit 1000
$$;
revoke execute on function public.amb_candidates_export(integer) from anon, public;
grant execute on function public.amb_candidates_export(integer) to authenticated;
