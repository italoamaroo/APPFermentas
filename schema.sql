-- =====================================================================
--  ALMOXARIFADO — esquema do banco (Supabase / Postgres)
--  Como usar: Supabase > SQL Editor > New query > cole tudo > Run.
--  Pode ser executado mais de uma vez sem quebrar nada.
-- =====================================================================

-- gen_random_uuid() é nativo no Postgres 13+ (Supabase já tem)

-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.fornecedores (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  contato     text,
  created_at  timestamptz not null default now()
);

create table if not exists public.funcionarios (
  id          uuid primary key default gen_random_uuid(),
  matricula   text not null unique,
  nome        text not null,
  funcao      text,
  setor       text,
  telefone    text,
  ativo       boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.ferramentas (
  id              uuid primary key default gen_random_uuid(),
  codigo          text not null unique,
  nome            text not null,
  tipo            text default 'Manual',
  classificacao   text not null default 'proprio' check (classificacao in ('proprio','alugado')),
  fornecedor      text,
  patrimonio      text,
  site            text,                       -- almoxarifado / obra
  status          text not null default 'disponivel'
                  check (status in ('disponivel','em_uso','manutencao')),
  funcionario_id  uuid references public.funcionarios(id) on delete set null,
  retirada_em     timestamptz,
  observacoes     text,
  created_at      timestamptz not null default now()
);

create table if not exists public.movimentacoes (
  id                 uuid primary key default gen_random_uuid(),
  ferramenta_id      uuid references public.ferramentas(id) on delete set null,
  ferramenta_codigo  text,
  ferramenta_nome    text,
  acao               text not null check (acao in ('retirada','devolucao','manutencao_inicio','manutencao_fim')),
  funcionario_id     uuid references public.funcionarios(id) on delete set null,
  funcionario_nome   text,
  matricula          text,
  site               text,
  assinatura_path    text,                    -- caminho no bucket "assinaturas"
  observacao         text,
  usuario_email      text default (auth.jwt() ->> 'email'),
  created_at         timestamptz not null default now()
);

create index if not exists idx_mov_created   on public.movimentacoes (created_at desc);
create index if not exists idx_mov_func      on public.movimentacoes (funcionario_id);
create index if not exists idx_fer_status    on public.ferramentas (status);
create index if not exists idx_fer_func      on public.ferramentas (funcionario_id);

-- updated_at automático em funcionarios
create or replace function public.tg_set_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_func_updated on public.funcionarios;
create trigger trg_func_updated before update on public.funcionarios
for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- Alerta: ferramentas há mais de 2 dias com o mesmo funcionário
-- ---------------------------------------------------------------------
create or replace view public.v_alertas_posse
with (security_invoker = true) as
select f.id               as ferramenta_id,
       f.codigo,
       f.nome             as ferramenta,
       f.site,
       f.retirada_em,
       round(extract(epoch from now() - f.retirada_em) / 86400.0, 1) as dias,
       w.id               as funcionario_id,
       w.nome             as funcionario,
       w.matricula,
       w.telefone
from public.ferramentas f
join public.funcionarios w on w.id = f.funcionario_id
where f.status = 'em_uso'
  and f.retirada_em < now() - interval '2 days'
order by f.retirada_em;

-- ---------------------------------------------------------------------
-- Operações atômicas (evitam duas retiradas da mesma ferramenta)
-- ---------------------------------------------------------------------
create or replace function public.retirar_ferramenta(
  p_ferramenta  uuid,
  p_funcionario uuid,
  p_site        text default null,
  p_assinatura  text default null,
  p_obs         text default null
) returns public.movimentacoes
language plpgsql security invoker set search_path = public as $$
declare f ferramentas; w funcionarios; m movimentacoes;
begin
  select * into f from ferramentas where id = p_ferramenta for update;
  if not found then raise exception 'Ferramenta não encontrada'; end if;
  if f.status <> 'disponivel' then
    raise exception 'A ferramenta % não está disponível (status atual: %)', f.codigo, f.status;
  end if;

  select * into w from funcionarios where id = p_funcionario;
  if not found then raise exception 'Funcionário não encontrado'; end if;
  if not w.ativo then raise exception 'Funcionário % está inativo', w.nome; end if;

  update ferramentas
     set status = 'em_uso', funcionario_id = w.id, retirada_em = now(),
         site = coalesce(nullif(trim(p_site), ''), site)
   where id = f.id
  returning * into f;

  insert into movimentacoes (ferramenta_id, ferramenta_codigo, ferramenta_nome, acao,
                             funcionario_id, funcionario_nome, matricula, site, assinatura_path, observacao)
  values (f.id, f.codigo, f.nome, 'retirada', w.id, w.nome, w.matricula, f.site, p_assinatura, p_obs)
  returning * into m;
  return m;
end $$;

create or replace function public.devolver_ferramenta(
  p_ferramenta uuid,
  p_assinatura text default null,
  p_obs        text default null
) returns public.movimentacoes
language plpgsql security invoker set search_path = public as $$
declare f ferramentas; w funcionarios; m movimentacoes;
begin
  select * into f from ferramentas where id = p_ferramenta for update;
  if not found then raise exception 'Ferramenta não encontrada'; end if;
  if f.status <> 'em_uso' then raise exception 'A ferramenta % não está em uso', f.codigo; end if;

  select * into w from funcionarios where id = f.funcionario_id;

  update ferramentas set status = 'disponivel', funcionario_id = null, retirada_em = null
   where id = f.id;

  insert into movimentacoes (ferramenta_id, ferramenta_codigo, ferramenta_nome, acao,
                             funcionario_id, funcionario_nome, matricula, site, assinatura_path, observacao)
  values (f.id, f.codigo, f.nome, 'devolucao', w.id, w.nome, w.matricula, f.site, p_assinatura, p_obs)
  returning * into m;
  return m;
end $$;

create or replace function public.manutencao_ferramenta(
  p_ferramenta uuid,
  p_iniciar    boolean,
  p_obs        text default null
) returns public.movimentacoes
language plpgsql security invoker set search_path = public as $$
declare f ferramentas; m movimentacoes;
begin
  select * into f from ferramentas where id = p_ferramenta for update;
  if not found then raise exception 'Ferramenta não encontrada'; end if;
  if p_iniciar and f.status = 'em_uso' then
    raise exception 'Registre a devolução de % antes de enviar para manutenção', f.codigo;
  end if;

  update ferramentas
     set status = case when p_iniciar then 'manutencao' else 'disponivel' end,
         funcionario_id = null, retirada_em = null,
         observacoes = coalesce(nullif(trim(p_obs), ''), observacoes)
   where id = f.id;

  insert into movimentacoes (ferramenta_id, ferramenta_codigo, ferramenta_nome, acao, site, observacao)
  values (f.id, f.codigo, f.nome,
          case when p_iniciar then 'manutencao_inicio' else 'manutencao_fim' end,
          f.site, p_obs)
  returning * into m;
  return m;
end $$;

revoke all on function public.retirar_ferramenta(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.devolver_ferramenta(uuid, text, text)            from public, anon;
revoke all on function public.manutencao_ferramenta(uuid, boolean, text)       from public, anon;
grant execute on function public.retirar_ferramenta(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.devolver_ferramenta(uuid, text, text)            to authenticated;
grant execute on function public.manutencao_ferramenta(uuid, boolean, text)       to authenticated;

-- ---------------------------------------------------------------------
-- Segurança (RLS): só usuários logados acessam. Histórico não pode ser
-- editado nem apagado pelo app (somente inserido e lido).
-- ---------------------------------------------------------------------
alter table public.fornecedores  enable row level security;
alter table public.funcionarios  enable row level security;
alter table public.ferramentas   enable row level security;
alter table public.movimentacoes enable row level security;

drop policy if exists "fornecedores_auth"  on public.fornecedores;
drop policy if exists "funcionarios_auth"  on public.funcionarios;
drop policy if exists "ferramentas_auth"   on public.ferramentas;
drop policy if exists "mov_select"         on public.movimentacoes;
drop policy if exists "mov_insert"         on public.movimentacoes;

create policy "fornecedores_auth" on public.fornecedores  for all    to authenticated using (true) with check (true);
create policy "funcionarios_auth" on public.funcionarios  for all    to authenticated using (true) with check (true);
create policy "ferramentas_auth"  on public.ferramentas   for all    to authenticated using (true) with check (true);
create policy "mov_select"        on public.movimentacoes for select to authenticated using (true);
create policy "mov_insert"        on public.movimentacoes for insert to authenticated with check (true);

-- ---------------------------------------------------------------------
-- Storage: bucket privado para as assinaturas (PNG)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('assinaturas', 'assinaturas', false)
on conflict (id) do nothing;

drop policy if exists "assinaturas_insert" on storage.objects;
drop policy if exists "assinaturas_select" on storage.objects;
create policy "assinaturas_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'assinaturas');
create policy "assinaturas_select" on storage.objects for select to authenticated
  using (bucket_id = 'assinaturas');

-- ---------------------------------------------------------------------
-- Realtime: painel e celulares atualizam sozinhos
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['ferramentas','funcionarios','fornecedores','movimentacoes'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
