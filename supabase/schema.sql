create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  initials text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('lost', 'found')),
  title text not null,
  category text not null,
  description text not null,
  location text not null,
  date date not null,
  image text not null,
  owner text not null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'claimed', 'recovered')),
  created_at timestamptz not null default now()
);

create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  claimant_id uuid not null references public.profiles(id) on delete cascade,
  note text not null,
  status text not null default 'pending' check (status in ('pending', 'verified', 'declined')),
  created_at timestamptz not null default now(),
  unique (report_id, claimant_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.reports enable row level security;
alter table public.claims enable row level security;
alter table public.messages enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  display_name text := coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1));
begin
  insert into public.profiles (id, name, email, initials)
  values (
    new.id,
    display_name,
    new.email,
    upper(left(regexp_replace(display_name, '[^A-Za-z0-9 ]', '', 'g'), 1) ||
      coalesce(left(split_part(regexp_replace(display_name, '[^A-Za-z0-9 ]', '', 'g'), ' ', 2), 1), ''))
  )
  on conflict (id) do update set name = excluded.name, email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

drop policy if exists "Profiles are visible to authenticated users" on public.profiles;
create policy "Profiles are visible to authenticated users"
  on public.profiles for select to authenticated
  using (true);

drop policy if exists "Users can update their profile" on public.profiles;
create policy "Users can update their profile"
  on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists "Anyone can read active reports" on public.reports;
create policy "Anyone can read active reports"
  on public.reports for select
  using (status = 'active' or owner_id = auth.uid() or public.is_admin());

drop policy if exists "Authenticated users can publish reports" on public.reports;
create policy "Authenticated users can publish reports"
  on public.reports for insert to authenticated
  with check (owner_id = auth.uid() and status = 'active');

drop policy if exists "Owners and admins can update reports" on public.reports;
create policy "Owners and admins can update reports"
  on public.reports for update to authenticated
  using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists "Owners and admins can delete reports" on public.reports;
create policy "Owners and admins can delete reports"
  on public.reports for delete to authenticated
  using (owner_id = auth.uid() or public.is_admin());

drop policy if exists "Users can read related claims" on public.claims;
create policy "Users can read related claims"
  on public.claims for select to authenticated
  using (
    claimant_id = auth.uid()
    or exists (select 1 from public.reports where id = report_id and owner_id = auth.uid())
    or public.is_admin()
  );

drop policy if exists "Users can submit their own claims" on public.claims;
create policy "Users can submit their own claims"
  on public.claims for insert to authenticated
  with check (claimant_id = auth.uid());

drop policy if exists "Report owners and admins can review claims" on public.claims;
create policy "Report owners and admins can review claims"
  on public.claims for update to authenticated
  using (
    exists (select 1 from public.reports where id = report_id and owner_id = auth.uid())
    or public.is_admin()
  )
  with check (true);

drop policy if exists "Claim participants can read messages" on public.messages;
create policy "Claim participants can read messages"
  on public.messages for select to authenticated
  using (
    exists (
      select 1 from public.claims c
      join public.reports r on r.id = c.report_id
      where c.id = claim_id
        and (c.claimant_id = auth.uid() or r.owner_id = auth.uid() or public.is_admin())
    )
  );

drop policy if exists "Verified participants can send messages" on public.messages;
create policy "Verified participants can send messages"
  on public.messages for insert to authenticated
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.claims c
      join public.reports r on r.id = c.report_id
      where c.id = claim_id
        and c.status = 'verified'
        and (c.claimant_id = auth.uid() or r.owner_id = auth.uid() or public.is_admin())
    )
  );

alter table public.reports replica identity full;
alter table public.claims replica identity full;
alter table public.messages replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reports'
  ) then
    alter publication supabase_realtime add table public.reports;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'claims'
  ) then
    alter publication supabase_realtime add table public.claims;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end
$$;
