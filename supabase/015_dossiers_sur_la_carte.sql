-- Position des dossiers apporteurs, pour les afficher sur la carte (toutes Régions).
alter table public.amb_dossiers add column if not exists lat double precision;
alter table public.amb_dossiers add column if not exists lng double precision;
