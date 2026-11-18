-- Message libre de l'équipe à l'apporteur, repris dans l'e-mail d'affectation et sur la fiche du dossier.
alter table public.amb_dossiers add column if not exists message text;
