-- Bouton « Support » : les utilisateurs signalent un bug ou demandent une amélioration.
-- La demande est listée dans le suivi équipe et envoyée par e-mail (fonction amb-notify).
create table if not exists public.amb_support (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  author_id   uuid references auth.users (id) on delete set null,
  author_name text,
  kind        text not null check (kind in ('Bug', 'Amélioration')),
  page        text,
  message     text not null check (length(trim(message)) between 1 and 4000),
  status      text not null default 'Nouveau' check (status in ('Nouveau', 'En cours', 'Traité')),
  notified_at timestamptz
);
alter table public.amb_support enable row level security;
revoke all on public.amb_support from anon;

drop policy if exists "membre lit ses demandes, équipe lit tout" on public.amb_support;
create policy "membre lit ses demandes, équipe lit tout" on public.amb_support
  for select using (author_id = auth.uid() or public.amb_role() = 'admin');
drop policy if exists "membre envoie une demande" on public.amb_support;
create policy "membre envoie une demande" on public.amb_support
  for insert with check (public.amb_role() is not null);
drop policy if exists "équipe suit les demandes" on public.amb_support;
create policy "équipe suit les demandes" on public.amb_support
  for update using (public.amb_role() = 'admin') with check (public.amb_role() = 'admin');

-- L'auteur et le statut sont fixés par la base, pas par le navigateur.
create or replace function public.amb_support_author()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.author_id := auth.uid();
  new.author_name := (select name from public.amb_members where user_id = auth.uid());
  new.status := 'Nouveau';
  new.notified_at := null;
  return new;
end $$;
revoke execute on function public.amb_support_author() from anon, authenticated, public;
drop trigger if exists amb_support_author on public.amb_support;
create trigger amb_support_author before insert on public.amb_support
  for each row execute function public.amb_support_author();

-- E-mail à chaque demande, y compris celles de l'équipe.
create or replace function public.amb_support_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://wrexwthjavagzumuzlxx.supabase.co/functions/v1/amb-notify',
    body := jsonb_build_object('table', 'amb_support', 'id', new.id),
    headers := '{"Content-Type": "application/json"}'::jsonb);
  return new;
end $$;
revoke execute on function public.amb_support_notify() from anon, authenticated, public;
drop trigger if exists amb_support_notify on public.amb_support;
create trigger amb_support_notify after insert on public.amb_support
  for each row execute function public.amb_support_notify();
