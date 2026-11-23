-- Entreprises candidates de l'outil Zoning as Community, visibles sur la carte par tous les membres connectés.
-- Seules les entreprises pas encore approchées sont renvoyées (ni dans le CRM, ni déjà en opportunité),
-- sans téléphone ni e-mail, et uniquement pour la zone affichée (300 au plus, les plus gros sites d'abord).
create index if not exists zc_candidats_lat_lng_idx on public.zc_candidats (lat, lng);

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
      and p_max_lat - p_min_lat < 0.5 and p_max_lng - p_min_lng < 1.0   -- pas d'export de toute la base d'un coup
  )
  select z.place_id, z.nom, z.adresse, z.lat, z.lng, z.categorie,
         z.conso_min_kwh, z.conso_max_kwh, z.surface_toit_m2, z.pv_max_kwh_an, count(*) over ()
  from zone z
  order by greatest(coalesce(z.conso_max_kwh, 0), coalesce(z.pv_max_kwh_an, 0)) desc
  limit 300
$$;
revoke execute on function public.amb_candidates(double precision, double precision, double precision, double precision) from anon, public;
grant execute on function public.amb_candidates(double precision, double precision, double precision, double precision) to authenticated;
