-- Contours des zonings d'activité pour la zone affichée (données publiques des géoportails régionaux),
-- et identifiant Odoo des membres pour l'équipe, afin de lancer une recherche d'entreprises autour d'un membre
-- (fonction zc-voisins du site Suivi vendeurs, appelée avec le jeton de session d'un membre admin).
create index if not exists zc_zonings_lat_lng_idx on public.zc_zonings (lat, lng);

create or replace function public.amb_zonings(p_min_lat double precision, p_max_lat double precision,
                                              p_min_lng double precision, p_max_lng double precision)
returns table (id bigint, nom text, region text, geometry jsonb)
language sql stable security definer set search_path = public as $$
  select z.id, z.nom, z.region, z.geometry
  from public.zc_zonings z
  where public.amb_role() is not null and z.geometry is not null
    -- marge : un zoning dont le centre est juste hors de l'écran reste dessiné
    and z.lat between p_min_lat - 0.02 and p_max_lat + 0.02
    and z.lng between p_min_lng - 0.03 and p_max_lng + 0.03
  order by z.id
  limit 400
$$;
revoke execute on function public.amb_zonings(double precision, double precision, double precision, double precision) from anon, public;
grant execute on function public.amb_zonings(double precision, double precision, double precision, double precision) to authenticated;

drop function if exists public.amb_community_members();
create function public.amb_community_members()
returns table (lat double precision, lng double precision, operation text, name text, id integer)
language sql stable security definer set search_path = public as $$
  select m.lat, m.lng,
         regexp_replace(split_part(m.operation_nom, ',', 1), '^\S+\s*-\s*', ''),
         case when public.amb_role() in ('shareholder', 'admin') then m.nom end,
         case when public.amb_role() = 'admin' then m.odoo_partner_id end
  from public.zc_membres m
  where public.amb_role() is not null
    and m.statut = 'client' and m.operation_nom is not null
    and m.lat is not null and m.lng is not null
$$;
revoke execute on function public.amb_community_members() from anon, public;
grant execute on function public.amb_community_members() to authenticated;
