-- =====================================================================
--  MIGRAÇÃO 003 — REGISTRO DE INCIDENTES DE SEGURANÇA (FASE B.1)
--  Pré-requisito: 002_auditoria_fase_a.sql aplicada.
--  Base normativa (texto oficial verificado em 03/11/2026):
--    Res. CD/ANPD nº 15/2024
--      art. 3º XII  definição de incidente de segurança
--      art. 5º      critérios de risco ou dano relevante
--      art. 6º      comunicação à ANPD em 3 dias úteis do conhecimento de que o incidente
--                   afetou dados pessoais; § 3º complementação em 20 dias úteis da comunicação;
--                   § 8º prazos em dobro para agente de pequeno porte
--      art. 9º      comunicação ao titular em 3 dias úteis (em dobro p/ pequeno porte, § 6º)
--      art. 10      registro de TODOS os incidentes por no mínimo 5 anos, conteúdo mínimo (incisos I–VIII)
--    Portaria MGI nº 11.460/2025 — feriados nacionais
--  O sistema APOIA a decisão: ele não decide sozinho se o incidente deve ser comunicado.
--  Reversão: 003_incidentes_reverter.sql (não apaga registros de incidentes).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Novo perfil: encarregado (DPO)
-- ---------------------------------------------------------------------
alter table public.perfis drop constraint if exists perfis_papel_check;
alter table public.perfis add constraint perfis_papel_check
  check (papel in ('almoxarife','gestor','auditor','encarregado'));

-- ---------------------------------------------------------------------
-- 2. Calendário: feriados nacionais e dias úteis
--    Conservador: pontos facultativos e feriados locais NÃO são excluídos,
--    então o prazo calculado nunca é posterior ao prazo legal.
-- ---------------------------------------------------------------------
create or replace function public.pascoa(p_ano int) returns date language plpgsql immutable as $$
declare a int; b int; c int; d int; e int; f int; g int; h int; i int; k int; l int; m int; mes int; dia int;
begin   -- algoritmo de Meeus/Jones/Butcher (calendário gregoriano)
  a := p_ano % 19; b := p_ano / 100; c := p_ano % 100; d := b / 4; e := b % 4;
  f := (b + 8) / 25; g := (b - f + 1) / 3; h := (19 * a + b - d - g + 15) % 30;
  i := c / 4; k := c % 4; l := (32 + 2 * e + 2 * i - h - k) % 7; m := (a + 11 * h + 22 * l) / 451;
  mes := (h + l - 7 * m + 114) / 31; dia := ((h + l - 7 * m + 114) % 31) + 1;
  return make_date(p_ano, mes, dia);
end $$;

create or replace function public.e_feriado_nacional(p_dia date) returns boolean language sql immutable as $$
  select to_char(p_dia, 'MM-DD') in ('01-01','04-21','05-01','09-07','10-12','11-02','11-15','12-25')
      or (to_char(p_dia, 'MM-DD') = '11-20' and p_dia >= date '2024-01-01')   -- Lei 14.759/2023
      or p_dia = public.pascoa(extract(year from p_dia)::int) - 2;            -- Paixão de Cristo
$$;

create or replace function public.e_dia_util(p_dia date) returns boolean language sql immutable as $$
  select extract(isodow from p_dia) < 6 and not public.e_feriado_nacional(p_dia);
$$;

-- Prazo = n-ésimo dia útil APÓS a data local (America/Recife) do evento inicial (o dia do início não conta)
create or replace function public.prazo_dias_uteis(p_inicio timestamptz, p_dias int) returns date
language plpgsql stable as $$
declare d date := (p_inicio at time zone 'America/Recife')::date; n int := 0;
begin
  if p_inicio is null or p_dias is null then return null; end if;
  if p_dias < 0 or p_dias > 60 then raise exception 'prazo_dias_uteis: p_dias fora do intervalo 0..60'; end if;
  while n < p_dias loop
    d := d + 1;
    if public.e_dia_util(d) then n := n + 1; end if;
  end loop;
  return d;
end $$;

-- Dias úteis restantes de hoje (exclusive) até o prazo (inclusive).
-- Prazo já passado devolve SEMPRE valor negativo (mínimo -1), mesmo se hoje não for dia útil.
-- Distâncias acima de 400 dias são limitadas (evita uso abusivo de CPU).
drop view if exists public.v_incidentes;                 -- recriada abaixo (depende desta função)
drop function if exists public.dias_uteis_restantes(date); -- versão anterior, de um parâmetro
create or replace function public.dias_uteis_restantes(p_prazo date, p_hoje date default null) returns int language plpgsql stable as $$
declare hoje date := coalesce(p_hoje, (now() at time zone 'America/Recife')::date); d date; n int := 0;
begin
  if p_prazo is null then return null; end if;
  if p_prazo > hoje + 400 then return 999; end if;
  if p_prazo < hoje - 400 then return -999; end if;
  if p_prazo >= hoje then
    d := hoje; while d < p_prazo loop d := d + 1; if public.e_dia_util(d) then n := n + 1; end if; end loop;
    return n;
  end if;
  d := p_prazo; while d < hoje loop d := d + 1; if public.e_dia_util(d) then n := n - 1; end if; end loop;
  return least(n, -1);
end $$;

-- ---------------------------------------------------------------------
-- 3. Configuração de privacidade (linha única)
-- ---------------------------------------------------------------------
create table if not exists public.config_privacidade (
  id                      boolean primary key default true check (id),
  agente_pequeno_porte    boolean not null default false,    -- Res. CD/ANPD 2/2022: prazos em dobro
  justificativa           text check (char_length(justificativa) <= 500),
  atualizado_por          uuid,
  atualizado_em           timestamptz not null default now()
);
insert into public.config_privacidade (id) values (true) on conflict do nothing;
alter table public.config_privacidade enable row level security;
drop policy if exists config_privacidade_ler on public.config_privacidade;
create policy config_privacidade_ler on public.config_privacidade for select to authenticated
  using (public.tem_papel(array['almoxarife','gestor','auditor','encarregado']));
revoke all on public.config_privacidade from anon;
revoke insert, update, delete, truncate on public.config_privacidade from authenticated;
grant select on public.config_privacidade to authenticated;

-- ---------------------------------------------------------------------
-- 4. Tabelas do registro (art. 10) — sem exclusão (guarda mínima de 5 anos)
-- ---------------------------------------------------------------------
create table if not exists public.incidentes (
  id                        uuid primary key default gen_random_uuid(),
  numero                    bigint generated always as identity unique,
  titulo                    text not null check (char_length(titulo) between 3 and 200),
  descricao                 text check (char_length(descricao) <= 4000),           -- art. 10 II (circunstâncias)
  causa                     text check (char_length(causa) <= 2000),
  status                    text not null default 'suspeita'
                            check (status in ('suspeita','em_analise','contido','encerrado')),
  origem                    text not null default 'manual'
                            check (origem in ('manual','verificacao_integridade','confirmacao_ancora')),
  ocorrido_em               timestamptz,                                           -- quando possível determinar
  detectado_em              timestamptz not null default now(),
  ciencia_em                timestamptz,   -- art. 6º § 1º: conhecimento de que AFETOU DADOS PESSOAIS (inicia prazos)
  sistemas_afetados         text[] not null default '{}',
  categorias_dados          text[] not null default '{}',                          -- art. 10 III
  categorias_titulares      text[] not null default '{}',
  qtd_titulares             int check (qtd_titulares >= 0),                        -- art. 10 IV
  qtd_vulneraveis           int check (qtd_vulneraveis >= 0),                      -- crianças/adolescentes/idosos
  qtd_titulares_tratados    int check (qtd_titulares_tratados >= 0),               -- art. 6º § 2º XII
  criterios_art5            text[] not null default '{}'
                            check (criterios_art5 <@ array['sensiveis','criancas_adolescentes_idosos','financeiros',
                                                           'autenticacao','sigilo','larga_escala']),
  afeta_significativamente  boolean,
  avaliacao_risco           text not null default 'pendente'
                            check (avaliacao_risco in ('pendente','sem_risco_relevante','risco_relevante')),
  justificativa_risco       text check (char_length(justificativa_risco) <= 4000), -- art. 10 V e VIII
  danos_possiveis           text check (char_length(danos_possiveis) <= 2000),
  medidas_contencao         text check (char_length(medidas_contencao) <= 4000),   -- art. 10 VI
  medidas_mitigacao         text check (char_length(medidas_mitigacao) <= 4000),
  medidas_seguranca_previas text check (char_length(medidas_seguranca_previas) <= 2000),
  evidencias                text check (char_length(evidencias) <= 4000),
  pequeno_porte_na_ciencia  boolean,         -- regime vigente quando a ciência foi registrada (não muda depois)
  ancora_evento_id          bigint,          -- cadeia de auditoria no momento do registro (preservação)
  ancora_hash               text,
  encerrado_em              timestamptz,
  motivo_encerramento       text check (char_length(motivo_encerramento) <= 2000),
  criado_por                uuid,
  criado_em                 timestamptz not null default now(),
  atualizado_em             timestamptz not null default now(),
  constraint ck_inc_ciencia check (ciencia_em is null or ciencia_em >= detectado_em - interval '366 days')
);
create index if not exists idx_inc_status on public.incidentes (status);
alter table public.incidentes add column if not exists pequeno_porte_na_ciencia boolean;

-- Listas com tamanho limitado (registro permanente não pode ser inflado)
create or replace function public._lista_ok(a text[], max_itens int, max_len int) returns boolean language sql immutable as $$
  select coalesce(cardinality(a), 0) <= max_itens and not exists (select 1 from unnest(a) x where char_length(x) > max_len);
$$;
revoke all on function public._lista_ok(text[], int, int) from public, anon;
grant execute on function public._lista_ok(text[], int, int) to authenticated;
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'ck_inc_listas'
              and pg_get_constraintdef(oid) not like '%criterios_art5%') then
    alter table public.incidentes drop constraint ck_inc_listas;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_inc_listas') then
    alter table public.incidentes add constraint ck_inc_listas check (
      public._lista_ok(sistemas_afetados, 30, 100) and public._lista_ok(categorias_dados, 20, 40)
      and public._lista_ok(categorias_titulares, 20, 40) and cardinality(criterios_art5) <= 6);
  end if;
end $$;

create table if not exists public.incidentes_comunicacoes (
  id             uuid primary key default gen_random_uuid(),
  incidente_id   uuid not null references public.incidentes(id),
  destinatario   text not null check (destinatario in ('anpd','titulares','complementar_anpd','outro')),
  realizada_em   timestamptz not null,
  meio           text not null check (char_length(meio) between 2 and 200),        -- art. 10 VII (forma)
  protocolo      text check (char_length(protocolo) <= 200),
  resumo         text not null check (char_length(resumo) between 5 and 4000),     -- art. 10 VII (conteúdo)
  registrado_por uuid,
  registrado_em  timestamptz not null default now()
);
create index if not exists idx_inc_com on public.incidentes_comunicacoes (incidente_id);

create table if not exists public.incidentes_historico (
  id             bigint generated always as identity primary key,
  incidente_id   uuid not null references public.incidentes(id),
  acao           text not null,
  alteracoes     jsonb not null default '{}'::jsonb,
  comentario     text check (char_length(comentario) <= 2000),
  ator_id        uuid,
  ator_email     text,
  em             timestamptz not null default now()
);
create index if not exists idx_inc_hist on public.incidentes_historico (incidente_id, id);

-- Sem exclusão e sem escrita direta: tudo pelas funções oficiais
create or replace function public.tg_incidente_protege() returns trigger language plpgsql as $$
begin
  if tg_op in ('DELETE','TRUNCATE') then
    raise exception 'Registros de incidente não podem ser apagados (guarda mínima de 5 anos — Res. CD/ANPD 15/2024, art. 10)'
      using errcode = '42501';
  end if;
  if not public._via_funcao_oficial() then
    raise exception 'Use as funções oficiais do registro de incidentes' using errcode = '42501';
  end if;
  if tg_table_name in ('incidentes_comunicacoes','incidentes_historico') and tg_op = 'UPDATE' then
    raise exception 'Comunicações e histórico de incidente não podem ser alterados' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
do $$
declare t text;
begin
  foreach t in array array['incidentes','incidentes_comunicacoes','incidentes_historico'] loop
    execute format('drop trigger if exists trg_%s_protege on public.%I', t, t);
    execute format('create trigger trg_%s_protege before insert or update or delete on public.%I
                    for each row execute function public.tg_incidente_protege()', t, t);
    execute format('drop trigger if exists trg_%s_trunc on public.%I', t, t);
    execute format('create trigger trg_%s_trunc before truncate on public.%I
                    for each statement execute function public.tg_incidente_protege()', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Leitura: gestor, encarregado e auditor veem tudo; quem comunicou uma suspeita vê o que registrou
drop policy if exists incidentes_ler on public.incidentes;
create policy incidentes_ler on public.incidentes for select to authenticated
  using (public.tem_papel(array['gestor','encarregado','auditor']));
-- quem comunicou recebe o número no registro; o conteúdo da investigação fica restrito
drop policy if exists inc_com_ler on public.incidentes_comunicacoes;
create policy inc_com_ler on public.incidentes_comunicacoes for select to authenticated
  using (public.tem_papel(array['gestor','encarregado','auditor']));
drop policy if exists inc_hist_ler on public.incidentes_historico;
create policy inc_hist_ler on public.incidentes_historico for select to authenticated
  using (public.tem_papel(array['gestor','encarregado','auditor']));

-- ---------------------------------------------------------------------
-- 5. Visão com prazos calculados (respeita a RLS de quem consulta)
-- ---------------------------------------------------------------------
drop view if exists public.v_incidentes;
create view public.v_incidentes with (security_invoker = true) as
with cfg as (select coalesce((select agente_pequeno_porte from public.config_privacidade), false) as pp),
com as (
  select incidente_id,
         min(realizada_em) filter (where destinatario = 'anpd')      as anpd_em,
         min(realizada_em) filter (where destinatario = 'titulares') as titulares_em,
         count(*) as total
    from public.incidentes_comunicacoes group by incidente_id
),
base as (
  select i.*, coalesce(i.pequeno_porte_na_ciencia, cfg.pp) as pp_regime from public.incidentes i cross join cfg
)
select i.*,
       i.pp_regime as agente_pequeno_porte,
       public.prazo_dias_uteis(i.ciencia_em, case when i.pp_regime then 6 else 3 end)  as prazo_anpd,
       public.prazo_dias_uteis(i.ciencia_em, case when i.pp_regime then 6 else 3 end)  as prazo_titulares,
       public.prazo_dias_uteis(com.anpd_em,  case when i.pp_regime then 40 else 20 end) as prazo_complementacao,
       com.anpd_em as comunicado_anpd_em, com.titulares_em as comunicado_titulares_em,
       coalesce(com.total, 0) as comunicacoes,
       -- indício do art. 5º (apoio à decisão; NÃO é decisão)
       (coalesce(i.afeta_significativamente, false) and cardinality(i.criterios_art5) > 0) as indicio_art5,
       case
         when i.status = 'encerrado' or i.ciencia_em is null or i.avaliacao_risco = 'sem_risco_relevante' then null
         when com.anpd_em is not null and com.titulares_em is not null then null
         else public.dias_uteis_restantes(public.prazo_dias_uteis(i.ciencia_em, case when i.pp_regime then 6 else 3 end))
       end as dias_uteis_para_prazo,
       case when i.status <> 'encerrado' and com.anpd_em is not null
            then public.dias_uteis_restantes(public.prazo_dias_uteis(com.anpd_em, case when i.pp_regime then 40 else 20 end))
       end as dias_uteis_complementacao
  from base i left join com on com.incidente_id = i.id;
grant select on public.v_incidentes to authenticated;

-- ---------------------------------------------------------------------
-- 6. Funções oficiais
-- ---------------------------------------------------------------------
create or replace function public._inc_hist(p_inc uuid, p_acao text, p_alt jsonb, p_coment text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_email text;
begin
  begin v_email := auth.jwt() ->> 'email'; exception when others then v_email := null; end;
  insert into public.incidentes_historico (incidente_id, acao, alteracoes, comentario, ator_id, ator_email)
  values (p_inc, p_acao, coalesce(p_alt, '{}'::jsonb), audit._texto(p_coment, 2000), auth.uid(), v_email);
end $$;
revoke all on function public._inc_hist(uuid, text, jsonb, text) from public, anon, authenticated;

-- Abertura (qualquer perfil pode comunicar uma suspeita; também usada internamente)
create or replace function public._inc_abrir(p_titulo text, p_descricao text, p_origem text, p_detectado timestamptz, p_ocorrido timestamptz)
returns public.incidentes
language plpgsql security definer set search_path = public, audit, pg_temp as $$
declare r public.incidentes; v_id bigint; v_hash text;
begin
  select id, hash into v_id, v_hash from audit.eventos order by id desc limit 1;      -- preserva a âncora atual
  perform set_config('app.via_rpc', 'on', true);
  insert into public.incidentes (titulo, descricao, origem, detectado_em, ocorrido_em, ancora_evento_id, ancora_hash, criado_por)
  values (trim(audit._texto(p_titulo, 200)), left(p_descricao, 4000), p_origem, coalesce(p_detectado, now()), p_ocorrido,
          v_id, v_hash, auth.uid())
  returning * into r;
  perform public._inc_hist(r.id, 'registro', jsonb_build_object('origem', p_origem), null);
  perform set_config('app.via_rpc', 'off', true);
  perform audit.registrar('incidente', 'registro_incidente', 'alta', 'incidentes', r.id::text, 'sucesso', null,
                          jsonb_build_object('numero', r.numero, 'origem', p_origem,
                                             'deteccao_retroativa_dias', greatest(0, extract(day from now() - r.detectado_em))::int));
  return r;
end $$;
revoke all on function public._inc_abrir(text, text, text, timestamptz, timestamptz) from public, anon, authenticated;

create or replace function public.registrar_incidente(p_titulo text, p_descricao text default null,
                                                      p_detectado_em timestamptz default null, p_ocorrido_em timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.incidentes; v_limite int; v_qtd int;
begin
  if not public.tem_papel(array['almoxarife','gestor','auditor','encarregado']) then
    perform audit.registrar('incidente', 'registro_incidente', 'alta', 'incidentes', null, 'negado', 'sem_permissao');
    return jsonb_build_object('ok', false, 'erro', 'Seu usuário não tem perfil de acesso.');
  end if;
  if char_length(coalesce(trim(audit._texto(p_titulo, 200)), '')) < 3 then
    return jsonb_build_object('ok', false, 'erro', 'Descreva o incidente em poucas palavras (título).');
  end if;
  -- limite anti-inundação: o registro é permanente
  v_limite := 5;
  if public.tem_papel(array['gestor','encarregado']) then v_limite := 20; end if;
  select count(*) into v_qtd from public.incidentes where criado_por = auth.uid() and criado_em > now() - interval '1 hour';
  if v_qtd >= v_limite then
    perform audit.registrar('incidente', 'registro_incidente', 'alta', 'incidentes', null, 'negado', 'limite_por_hora');
    return jsonb_build_object('ok', false, 'erro', 'Limite de registros por hora atingido. Fale diretamente com o gestor ou o encarregado.');
  end if;
  if p_detectado_em > now() + interval '5 minutes' or p_ocorrido_em > now() + interval '5 minutes' then
    return jsonb_build_object('ok', false, 'erro', 'Datas no futuro não são aceitas.');
  end if;
  if p_detectado_em < now() - interval '366 days' then
    return jsonb_build_object('ok', false, 'erro', 'Detecção com mais de 1 ano: registre diretamente com o encarregado.');
  end if;
  r := public._inc_abrir(p_titulo, p_descricao, 'manual', p_detectado_em, p_ocorrido_em);
  return jsonb_build_object('ok', true, 'id', r.id, 'numero', r.numero);
end $$;

-- Atualização por lista fechada de campos (gestor/encarregado). Mudanças em ciência/avaliação exigem comentário.
create or replace function public.atualizar_incidente(p_id uuid, p_dados jsonb, p_comentario text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  atual public.incidentes; novo public.incidentes; k text; alt jsonb := '{}'::jsonb; filtrado jsonb := '{}'::jsonb;
  permitidos text[] := array['titulo','descricao','causa','status','ocorrido_em','ciencia_em','sistemas_afetados','categorias_dados',
    'categorias_titulares','qtd_titulares','qtd_vulneraveis','qtd_titulares_tratados','criterios_art5','afeta_significativamente',
    'avaliacao_risco','justificativa_risco','danos_possiveis','medidas_contencao','medidas_mitigacao','medidas_seguranca_previas','evidencias'];
begin
  if not public.tem_papel(array['gestor','encarregado']) then
    perform audit.registrar('incidente', 'atualizacao_incidente', 'alta', 'incidentes', p_id::text, 'negado', 'sem_permissao');
    return jsonb_build_object('ok', false, 'erro', 'Somente gestor ou encarregado atualizam incidentes.');
  end if;
  select * into atual from public.incidentes where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'Incidente não encontrado.'); end if;
  if atual.status = 'encerrado' then return jsonb_build_object('ok', false, 'erro', 'Incidente encerrado: reabra para alterar.'); end if;
  if atual.origem <> 'manual' and not public.tem_papel(array['encarregado']) then
    return jsonb_build_object('ok', false, 'erro', 'Incidente de integridade da auditoria: somente o encarregado altera (separação de funções).');
  end if;
  if jsonb_typeof(p_dados) <> 'object' then return jsonb_build_object('ok', false, 'erro', 'Dados inválidos.'); end if;

  for k in select jsonb_object_keys(p_dados) loop
    if not (k = any (permitidos)) then return jsonb_build_object('ok', false, 'erro', 'Campo não permitido: ' || audit._texto(k, 40)); end if;
    filtrado := filtrado || jsonb_build_object(k, p_dados -> k);
  end loop;
  if (filtrado ->> 'status') = 'encerrado' then
    return jsonb_build_object('ok', false, 'erro', 'Use "Encerrar incidente" para encerrar.');
  end if;

  begin
    novo := jsonb_populate_record(atual, filtrado);
  exception when others then
    return jsonb_build_object('ok', false, 'erro', 'Valor inválido: ' || sqlerrm);
  end;
  if novo.ciencia_em > now() + interval '5 minutes' or novo.ocorrido_em > now() + interval '5 minutes' then
    return jsonb_build_object('ok', false, 'erro', 'Datas no futuro não são aceitas.');
  end if;
  novo.titulo := trim(audit._texto(novo.titulo, 200));
  if char_length(coalesce(novo.titulo, '')) < 3 then return jsonb_build_object('ok', false, 'erro', 'Título inválido.'); end if;
  -- formulário trabalha em minutos: diferença menor que 1 min não é alteração
  if atual.ciencia_em is not null and novo.ciencia_em is not null and abs(extract(epoch from novo.ciencia_em - atual.ciencia_em)) < 60 then
    novo.ciencia_em := atual.ciencia_em;
  end if;
  if novo.ciencia_em is not null and novo.ciencia_em < atual.detectado_em - interval '1 minute' then
    return jsonb_build_object('ok', false, 'erro', 'A ciência de que afetou dados pessoais não pode ser anterior à detecção do incidente.');
  end if;
  -- ciência já registrada não pode ser apagada (só corrigida, com justificativa)
  if atual.ciencia_em is not null and novo.ciencia_em is null then
    return jsonb_build_object('ok', false, 'erro', 'A data de ciência já registrada não pode ser apagada; corrija-a com justificativa.');
  end if;
  -- regime de prazo gravado UMA vez (na primeira ciência) e nunca recalculado
  novo.pequeno_porte_na_ciencia := atual.pequeno_porte_na_ciencia;
  if atual.pequeno_porte_na_ciencia is null and novo.ciencia_em is not null then
    novo.pequeno_porte_na_ciencia := coalesce((select agente_pequeno_porte from public.config_privacidade), false);
  end if;

  for k in select unnest(permitidos) loop
    if (to_jsonb(atual) -> k) is distinct from (to_jsonb(novo) -> k) then
      alt := alt || jsonb_build_object(k, jsonb_build_object('de', to_jsonb(atual) -> k, 'para', to_jsonb(novo) -> k));
    end if;
  end loop;
  if alt = '{}'::jsonb then return jsonb_build_object('ok', true, 'sem_alteracao', true); end if;
  if (alt ? 'ciencia_em' and atual.ciencia_em is not null or alt ? 'avaliacao_risco')
     and char_length(coalesce(trim(p_comentario), '')) < 10 then
    return jsonb_build_object('ok', false, 'erro', 'Alterar a data de ciência já registrada ou a avaliação de risco exige justificativa (mín. 10 caracteres).');
  end if;
  -- ciência muito posterior à detecção adia o prazo: exige justificativa e fica sinalizada
  if alt ? 'ciencia_em' and novo.ciencia_em > atual.detectado_em + interval '2 days'
     and char_length(coalesce(trim(p_comentario), '')) < 10 then
    return jsonb_build_object('ok', false, 'erro', 'A ciência informada é mais de 2 dias posterior à detecção: justifique (o prazo legal conta da ciência).');
  end if;

  begin
    perform set_config('app.via_rpc', 'on', true);
    update public.incidentes set
      titulo = novo.titulo, descricao = novo.descricao, causa = novo.causa, status = novo.status,
      ocorrido_em = novo.ocorrido_em, ciencia_em = novo.ciencia_em, sistemas_afetados = novo.sistemas_afetados,
      categorias_dados = novo.categorias_dados, categorias_titulares = novo.categorias_titulares,
      qtd_titulares = novo.qtd_titulares, qtd_vulneraveis = novo.qtd_vulneraveis, qtd_titulares_tratados = novo.qtd_titulares_tratados,
      criterios_art5 = novo.criterios_art5, afeta_significativamente = novo.afeta_significativamente,
      avaliacao_risco = novo.avaliacao_risco, justificativa_risco = novo.justificativa_risco, danos_possiveis = novo.danos_possiveis,
      medidas_contencao = novo.medidas_contencao, medidas_mitigacao = novo.medidas_mitigacao,
      medidas_seguranca_previas = novo.medidas_seguranca_previas, evidencias = novo.evidencias,
      pequeno_porte_na_ciencia = novo.pequeno_porte_na_ciencia, atualizado_em = now()
    where id = p_id;
    perform public._inc_hist(p_id, 'atualizacao', alt, p_comentario);
    perform set_config('app.via_rpc', 'off', true);
  exception when check_violation or not_null_violation then
    perform set_config('app.via_rpc', 'off', true);
    return jsonb_build_object('ok', false, 'erro', 'Valor fora do permitido (tamanho ou lista): ' || sqlerrm);
  end;
  -- auditoria: só os NOMES dos campos (o conteúdo fica no próprio registro do incidente)
  perform audit.registrar('incidente', 'atualizacao_incidente', case when alt ? 'avaliacao_risco' or alt ? 'ciencia_em' then 'alta' else 'media' end,
                          'incidentes', p_id::text, 'sucesso', null,
                          jsonb_build_object('numero', atual.numero, 'campos', (select jsonb_agg(x) from jsonb_object_keys(alt) x),
                                             'ciencia_tardia', alt ? 'ciencia_em' and novo.ciencia_em > atual.detectado_em + interval '2 days'));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.registrar_comunicacao_incidente(p_id uuid, p_destinatario text, p_realizada_em timestamptz,
                                                                  p_meio text, p_resumo text, p_protocolo text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare atual public.incidentes; c public.incidentes_comunicacoes;
begin
  if not public.tem_papel(array['gestor','encarregado']) then
    perform audit.registrar('incidente', 'comunicacao_incidente', 'alta', 'incidentes', p_id::text, 'negado', 'sem_permissao');
    return jsonb_build_object('ok', false, 'erro', 'Somente gestor ou encarregado registram comunicações.');
  end if;
  select * into atual from public.incidentes where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'erro', 'Incidente não encontrado.'); end if;
  if p_realizada_em is null or p_realizada_em > now() + interval '5 minutes' then
    return jsonb_build_object('ok', false, 'erro', 'Informe a data/hora em que a comunicação foi feita (não futura).');
  end if;
  if p_realizada_em < atual.detectado_em - interval '1 minute' then
    return jsonb_build_object('ok', false, 'erro', 'A comunicação não pode ser anterior à detecção do incidente.');
  end if;
  begin
    perform set_config('app.via_rpc', 'on', true);
    insert into public.incidentes_comunicacoes (incidente_id, destinatario, realizada_em, meio, protocolo, resumo, registrado_por)
    values (p_id, p_destinatario, p_realizada_em, audit._texto(p_meio, 200), audit._texto(p_protocolo, 200), left(p_resumo, 4000), auth.uid())
    returning * into c;
    perform public._inc_hist(p_id, 'comunicacao', jsonb_build_object('destinatario', p_destinatario, 'realizada_em', p_realizada_em,
                                                                     'meio', c.meio, 'protocolo', c.protocolo), null);
    perform set_config('app.via_rpc', 'off', true);
  exception when check_violation or not_null_violation then
    perform set_config('app.via_rpc', 'off', true);
    return jsonb_build_object('ok', false, 'erro', 'Dados da comunicação inválidos: ' || sqlerrm);
  end;
  perform audit.registrar('incidente', 'comunicacao_incidente', 'alta', 'incidentes', p_id::text, 'sucesso', null,
                          jsonb_build_object('numero', atual.numero, 'destinatario', p_destinatario,
                                             'dentro_do_prazo', (select (p_realizada_em at time zone 'America/Recife')::date <= v.prazo_anpd
                                                                   from public.v_incidentes v where v.id = p_id),
                                             'registro_tardio', now() - p_realizada_em > interval '2 days'));
  return jsonb_build_object('ok', true, 'id', c.id);
end $$;

-- Encerramento exige avaliação concluída e o conteúdo mínimo do art. 10 (V, VII ou VIII)
create or replace function public.encerrar_incidente(p_id uuid, p_motivo text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.incidentes; tem_anpd boolean; tem_tit boolean;
begin
  if not public.tem_papel(array['gestor','encarregado']) then
    perform audit.registrar('incidente', 'encerramento_incidente', 'alta', 'incidentes', p_id::text, 'negado', 'sem_permissao');
    return jsonb_build_object('ok', false, 'erro', 'Somente gestor ou encarregado encerram incidentes.');
  end if;
  select * into a from public.incidentes where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'Incidente não encontrado.'); end if;
  if a.status = 'encerrado' then return jsonb_build_object('ok', false, 'erro', 'Já está encerrado.'); end if;
  if char_length(coalesce(trim(p_motivo), '')) < 10 then
    return jsonb_build_object('ok', false, 'erro', 'Descreva o motivo do encerramento (mín. 10 caracteres).');
  end if;
  if a.avaliacao_risco = 'pendente' then
    return jsonb_build_object('ok', false, 'erro', 'Conclua a avaliação de risco antes de encerrar (art. 10, V).');
  end if;
  if char_length(coalesce(trim(a.justificativa_risco), '')) < 10 then
    return jsonb_build_object('ok', false, 'erro', 'Registre a justificativa da avaliação de risco (art. 10, V e VIII).');
  end if;
  -- art. 10 vale para TODOS os incidentes: II, III e IV sempre (III pode ser "nenhum dado pessoal"; IV pode ser 0)
  if char_length(coalesce(trim(a.descricao), '')) < 10 or cardinality(a.categorias_dados) = 0 or a.qtd_titulares is null then
    return jsonb_build_object('ok', false, 'erro', 'Preencha o conteúdo mínimo do art. 10: circunstâncias (II), categorias de dados — ou "nenhum dado pessoal" (III) — e número de titulares, que pode ser 0 (IV).');
  end if;
  if a.avaliacao_risco = 'risco_relevante' and (a.ciencia_em is null
      or char_length(coalesce(trim(a.medidas_contencao), '') || coalesce(trim(a.medidas_mitigacao), '')) < 10) then
    return jsonb_build_object('ok', false, 'erro', 'Risco relevante: informe também a data de ciência (I) e as medidas de correção e mitigação (VI).');
  end if;
  -- incidentes abertos automaticamente (integridade da trilha) só o encarregado encerra (separação de funções)
  if a.origem <> 'manual' and not public.tem_papel(array['encarregado']) then
    return jsonb_build_object('ok', false, 'erro', 'Incidente de integridade da auditoria: somente o encarregado pode encerrar.');
  end if;
  if a.avaliacao_risco = 'risco_relevante' then
    select exists (select 1 from incidentes_comunicacoes where incidente_id = p_id and destinatario = 'anpd'),
           exists (select 1 from incidentes_comunicacoes where incidente_id = p_id and destinatario = 'titulares')
      into tem_anpd, tem_tit;
    if not (tem_anpd and tem_tit) then
      return jsonb_build_object('ok', false, 'erro', 'Risco relevante: registre as comunicações à ANPD e aos titulares antes de encerrar (art. 6º, 9º e 10, VII).');
    end if;
  end if;
  perform set_config('app.via_rpc', 'on', true);
  update public.incidentes set status = 'encerrado', encerrado_em = now(), motivo_encerramento = left(p_motivo, 2000), atualizado_em = now()
   where id = p_id;
  perform public._inc_hist(p_id, 'encerramento', jsonb_build_object('status', jsonb_build_object('de', a.status, 'para', 'encerrado')), p_motivo);
  perform set_config('app.via_rpc', 'off', true);
  perform audit.registrar('incidente', 'encerramento_incidente', 'alta', 'incidentes', p_id::text, 'sucesso', null,
                          jsonb_build_object('numero', a.numero, 'avaliacao', a.avaliacao_risco));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.reabrir_incidente(p_id uuid, p_motivo text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.incidentes;
begin
  if not public.tem_papel(array['gestor','encarregado']) then
    perform audit.registrar('incidente', 'reabertura_incidente', 'alta', 'incidentes', p_id::text, 'negado', 'sem_permissao');
    return jsonb_build_object('ok', false, 'erro', 'Somente gestor ou encarregado reabrem incidentes.');
  end if;
  select * into a from public.incidentes where id = p_id for update;
  if not found or a.status <> 'encerrado' then return jsonb_build_object('ok', false, 'erro', 'Incidente não está encerrado.'); end if;
  if char_length(coalesce(trim(p_motivo), '')) < 10 then
    return jsonb_build_object('ok', false, 'erro', 'Descreva o motivo da reabertura (mín. 10 caracteres).');
  end if;
  perform set_config('app.via_rpc', 'on', true);
  update public.incidentes set status = 'em_analise', encerrado_em = null, atualizado_em = now() where id = p_id;
  perform public._inc_hist(p_id, 'reabertura', jsonb_build_object('status', jsonb_build_object('de', 'encerrado', 'para', 'em_analise')), p_motivo);
  perform set_config('app.via_rpc', 'off', true);
  perform audit.registrar('incidente', 'reabertura_incidente', 'alta', 'incidentes', p_id::text, 'sucesso', null,
                          jsonb_build_object('numero', a.numero));
  return jsonb_build_object('ok', true);
end $$;

-- Enquadramento como agente de pequeno porte (dobra os prazos) — só o encarregado, com justificativa
create or replace function public.definir_pequeno_porte(p_valor boolean, p_justificativa text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare antes boolean;
begin
  if not public.tem_papel(array['encarregado']) then
    perform audit.registrar('incidente', 'config_pequeno_porte', 'critica', 'config_privacidade', null, 'negado', 'sem_permissao');
    return jsonb_build_object('ok', false, 'erro', 'Somente o encarregado altera esta configuração.');
  end if;
  if char_length(coalesce(trim(p_justificativa), '')) < 10 then
    return jsonb_build_object('ok', false, 'erro', 'Informe a justificativa / fundamento do enquadramento.');
  end if;
  select agente_pequeno_porte into antes from public.config_privacidade;
  update public.config_privacidade set agente_pequeno_porte = coalesce(p_valor, false), justificativa = left(p_justificativa, 500),
         atualizado_por = auth.uid(), atualizado_em = now();
  perform audit.registrar('incidente', 'config_pequeno_porte', 'critica', 'config_privacidade', null, 'sucesso', null,
                          jsonb_build_object('de', antes, 'para', coalesce(p_valor, false)));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- 7. Falha de integridade da auditoria abre incidente automaticamente
-- ---------------------------------------------------------------------
create or replace function public._inc_automatico(p_origem text, p_titulo text, p_descricao text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare aberto uuid;
begin
  perform pg_advisory_xact_lock(7412003);     -- duas verificações simultâneas não abrem dois incidentes
  select id into aberto from public.incidentes where origem = p_origem and status <> 'encerrado' order by numero limit 1;
  if aberto is not null then                  -- já existe: registra a nova ocorrência no histórico
    perform set_config('app.via_rpc', 'on', true);
    perform public._inc_hist(aberto, 'nova_ocorrencia', jsonb_build_object('detalhe', left(p_descricao, 500)), null);
    perform set_config('app.via_rpc', 'off', true);
    return;
  end if;
  perform public._inc_abrir(p_titulo, p_descricao, p_origem, now(), null);
end $$;
revoke all on function public._inc_automatico(text, text, text) from public, anon, authenticated;

create or replace function public.verificar_integridade_auditoria(p_a_partir_de bigint default null, p_lote int default 20000)
returns jsonb
language plpgsql security definer set search_path = public, audit, pg_temp as $$
declare e audit.eventos; anterior text; total int := 0; erro_id bigint; erro_tipo text; ultimo_id bigint;
        lote int := least(greatest(coalesce(p_lote, 20000), 10), 20000); mais boolean;
begin
  if not public.tem_papel(array['auditor']) then
    perform audit.registrar('auditoria', 'verificacao_integridade', 'alta', 'audit.eventos', null, 'negado', 'sem_permissao');
    return jsonb_build_object('ok', false, 'erro', 'Somente o perfil auditor.');
  end if;
  select x.hash into anterior from audit.eventos x where x.id < coalesce(p_a_partir_de, 0) order by x.id desc limit 1;
  for e in select * from audit.eventos where id >= coalesce(p_a_partir_de, 0) order by id limit lote loop
    total := total + 1; ultimo_id := e.id;
    if e.hash_anterior is distinct from anterior then erro_id := e.id; erro_tipo := 'encadeamento_quebrado'; exit; end if;
    if e.hash <> audit._hash(e) then erro_id := e.id; erro_tipo := 'conteudo_alterado'; exit; end if;
    anterior := e.hash;
  end loop;
  mais := erro_id is null and exists (select 1 from audit.eventos where id > coalesce(ultimo_id, 0));
  perform audit.registrar('auditoria', 'verificacao_integridade', case when erro_id is null then 'baixa' else 'critica' end,
                          'audit.eventos', erro_id::text, case when erro_id is null then 'sucesso' else 'falha' end, erro_tipo,
                          jsonb_build_object('a_partir_de', p_a_partir_de, 'eventos_verificados', total, 'ate_id', ultimo_id));
  if erro_id is not null then
    perform public._inc_automatico('verificacao_integridade', 'Falha de integridade na trilha de auditoria',
      format('A verificação de integridade (executada pelo auditor) encontrou "%s" no evento #%s da trilha de auditoria. '
             'Preservar evidências; avaliar se houve acesso indevido ou adulteração de dados pessoais.', erro_tipo, erro_id));
  end if;
  return jsonb_build_object('ok', erro_id is null, 'eventos_verificados', total, 'ultimo_id', ultimo_id, 'ultimo_hash', anterior,
                            'primeiro_erro_id', erro_id, 'tipo_erro', erro_tipo,
                            'proximo_a_partir_de', case when mais then ultimo_id + 1 end);
end $$;

create or replace function public.confirmar_ancora_auditoria(p_id bigint, p_hash text) returns jsonb
language plpgsql security definer set search_path = public, audit, pg_temp as $$
declare h text; ok boolean;
begin
  if not public.tem_papel(array['auditor']) then
    perform audit.registrar('auditoria', 'confirmacao_ancora', 'alta', 'audit.eventos', p_id::text, 'negado', 'sem_permissao');
    return jsonb_build_object('ok', false, 'erro', 'Somente o perfil auditor.');
  end if;
  select hash into h from audit.eventos where id = p_id;
  ok := h is not null and h = lower(trim(p_hash));
  perform audit.registrar('auditoria', 'confirmacao_ancora', case when ok then 'baixa' else 'critica' end, 'audit.eventos',
                          p_id::text, case when ok then 'sucesso' else 'falha' end,
                          case when h is null then 'evento_inexistente' when not ok then 'hash_divergente' end);
  if not ok then
    perform public._inc_automatico('confirmacao_ancora', 'Âncora da trilha de auditoria não confere',
      format('A âncora anotada fora do sistema (evento #%s) %s. Possível corte ou reescrita da trilha de auditoria.',
             p_id, case when h is null then 'não existe mais' else 'tem hash diferente' end));
  end if;
  return jsonb_build_object('ok', ok, 'existe', h is not null,
                            'incidente_aberto', not ok,
                            'mensagem', case when ok then 'Âncora confirmada: o evento continua íntegro na cadeia.'
                                             when h is null then 'O evento anotado NÃO existe mais: possível exclusão/corte da cadeia. Um incidente foi aberto.'
                                             else 'O hash anotado NÃO confere: possível reescrita da cadeia. Um incidente foi aberto.' end);
end $$;

-- ---------------------------------------------------------------------
-- 8. Permissões de execução
-- ---------------------------------------------------------------------
revoke all on function public.registrar_incidente(text, text, timestamptz, timestamptz) from public, anon;
revoke all on function public.atualizar_incidente(uuid, jsonb, text) from public, anon;
revoke all on function public.registrar_comunicacao_incidente(uuid, text, timestamptz, text, text, text) from public, anon;
revoke all on function public.encerrar_incidente(uuid, text) from public, anon;
revoke all on function public.reabrir_incidente(uuid, text) from public, anon;
revoke all on function public.definir_pequeno_porte(boolean, text) from public, anon;
revoke all on function public.tg_incidente_protege() from public, anon, authenticated;
grant execute on function public.registrar_incidente(text, text, timestamptz, timestamptz) to authenticated;
grant execute on function public.atualizar_incidente(uuid, jsonb, text) to authenticated;
grant execute on function public.registrar_comunicacao_incidente(uuid, text, timestamptz, text, text, text) to authenticated;
grant execute on function public.encerrar_incidente(uuid, text) to authenticated;
grant execute on function public.reabrir_incidente(uuid, text) to authenticated;
grant execute on function public.definir_pequeno_porte(boolean, text) to authenticated;
-- funções de calendário: leitura pura, usadas pela visão
revoke all on function public.pascoa(int), public.e_feriado_nacional(date), public.e_dia_util(date),
                       public.prazo_dias_uteis(timestamptz, int), public.dias_uteis_restantes(date, date) from public, anon;
grant execute on function public.pascoa(int), public.e_feriado_nacional(date), public.e_dia_util(date),
                          public.prazo_dias_uteis(timestamptz, int), public.dias_uteis_restantes(date, date) to authenticated;

-- Realtime para o painel
do $$ begin
  begin execute 'alter publication supabase_realtime add table public.incidentes'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.incidentes_comunicacoes'; exception when duplicate_object then null; end;
end $$;

select audit.registrar('auditoria', 'migracao_aplicada', 'alta', 'schema', '003_incidentes', 'sucesso', null,
                       jsonb_build_object('versao', '003', 'descricao', 'Fase B.1: registro de incidentes (Res. CD/ANPD 15/2024)'));
commit;
