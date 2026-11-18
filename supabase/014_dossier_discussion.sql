-- Fil de discussion par dossier entre l'équipe RaYSun et la société apporteuse.
-- Chaque message est envoyé par e-mail à l'autre partie et recopié en note interne sur la fiche Odoo du prospect
-- (quand le dossier est relié à une fiche du CRM). Le script peut être relancé sans risque.

create table if not exists public.amb_dossier_messages (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  dossier_id   uuid not null references public.amb_dossiers (id) on delete cascade,
  author_id    uuid references auth.users (id) on delete set null,
  author_name  text,
  from_team    boolean not null default false,
  body         text not null check (length(trim(body)) > 0 and length(body) <= 4000),
  notified_at  timestamptz,   -- e-mail envoyé à l'autre partie
  odoo_at      timestamptz    -- note écrite sur la fiche Odoo
);
create index if not exists amb_dossier_messages_dossier_idx on public.amb_dossier_messages (dossier_id, created_at);

alter table public.amb_dossier_messages enable row level security;
revoke all on public.amb_dossier_messages from anon;
grant select on public.amb_dossier_messages to authenticated;
grant all on public.amb_dossier_messages to service_role;

drop policy if exists "équipe lit tout, la société lit ses discussions" on public.amb_dossier_messages;
create policy "équipe lit tout, la société lit ses discussions" on public.amb_dossier_messages
  for select using (
    public.amb_role() = 'admin'
    or exists (select 1 from public.amb_dossiers d where d.id = dossier_id and d.org_id = public.amb_org())
  );

-- Écrire un message : l'équipe sur tout dossier, l'apporteur sur ceux de sa société. L'auteur vient toujours du compte connecté.
create or replace function public.amb_dossier_post(p_dossier uuid, p_body text)
returns uuid language plpgsql security definer set search_path = public as $$
declare d public.amb_dossiers; v uuid; r text := public.amb_role();
begin
  select * into d from public.amb_dossiers where id = p_dossier;
  if not found or r is null or (r <> 'admin' and d.org_id is distinct from public.amb_org()) then
    raise exception 'Dossier introuvable';
  end if;
  insert into public.amb_dossier_messages (dossier_id, author_id, author_name, from_team, body)
  values (p_dossier, auth.uid(), (select name from public.amb_members where user_id = auth.uid()), r = 'admin', trim(p_body))
  returning id into v;
  return v;
end $$;
revoke execute on function public.amb_dossier_post(uuid, text) from anon, public;
grant execute on function public.amb_dossier_post(uuid, text) to authenticated;

create or replace function public.amb_dossier_message_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://wrexwthjavagzumuzlxx.supabase.co/functions/v1/amb-dossier-message',
    body := jsonb_build_object('id', new.id),
    headers := '{"Content-Type": "application/json"}'::jsonb);
  return new;
end $$;
revoke execute on function public.amb_dossier_message_notify() from anon, authenticated, public;

drop trigger if exists amb_dossier_message_notify on public.amb_dossier_messages;
create trigger amb_dossier_message_notify after insert on public.amb_dossier_messages
  for each row execute function public.amb_dossier_message_notify();
