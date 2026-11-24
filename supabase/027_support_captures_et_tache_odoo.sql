-- Support : captures d'écran jointes, et chaque demande devient une tâche dans l'Odoo d'Eric + un e-mail
-- (fonction amb-support-notify). Le tableau du suivi équipe n'est plus utilisé.
alter table public.amb_support add column if not exists screenshots text[] not null default '{}';
alter table public.amb_support add column if not exists odoo_task_id integer;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('amb-support', 'amb-support', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Dépôt : tout membre, uniquement dans son propre dossier ({user_id}/…). Lecture : équipe uniquement.
drop policy if exists "amb support : dépôt par un membre" on storage.objects;
create policy "amb support : dépôt par un membre" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'amb-support' and public.amb_role() is not null and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "amb support : lecture équipe" on storage.objects;
create policy "amb support : lecture équipe" on storage.objects
  for select to authenticated using (bucket_id = 'amb-support' and public.amb_role() = 'admin');

-- L'auteur, le statut et les captures (celles de son propre dossier, cinq au plus) sont fixés par la base.
create or replace function public.amb_support_author()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.author_id := auth.uid();
  new.author_name := (select name from public.amb_members where user_id = auth.uid());
  new.status := 'Nouveau';
  new.notified_at := null;
  new.odoo_task_id := null;
  new.screenshots := coalesce((select array_agg(p) from (select p from unnest(coalesce(new.screenshots, '{}')) p
                               where p like auth.uid()::text || '/%' limit 5) s), '{}');
  return new;
end $$;

create or replace function public.amb_support_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://wrexwthjavagzumuzlxx.supabase.co/functions/v1/amb-support-notify',
    body := jsonb_build_object('id', new.id),
    headers := '{"Content-Type": "application/json"}'::jsonb);
  return new;
end $$;
