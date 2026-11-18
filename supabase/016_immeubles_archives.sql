-- Immeubles retirés de la carte sans être supprimés : les contacts déjà proposés restent dans le suivi équipe.
-- Le 18/11/2026, les 56 immeubles des vagues 1 à 3 ont été archivés (update ... set archived_at = now()).
-- Pour en réafficher un : update public.amb_leads set archived_at = null where id = '...';
alter table public.amb_leads add column if not exists archived_at timestamptz;
