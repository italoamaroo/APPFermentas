-- =====================================================================
--  MIGRAÇÃO 002 — AUDITORIA, PERFIS E INTEGRIDADE (FASE A)
--  Pré-requisito: supabase/schema.sql já executado.
--  Como aplicar: Supabase > SQL Editor > cole tudo > Run.
--  Reversão: supabase/migrations/002_auditoria_fase_a_reverter.sql
--  (a reversão NÃO apaga os eventos de auditoria já gravados).
--
--  Requisitos atendidos (ver docs/AUDITORIA_LGPD.md):
--    RF-01 registro centralizado | RF-02 eventos | RF-03 rastreabilidade
--    RF-04 integridade (somente-inclusão + hash encadeado) | RF-05 minimização
--    RF-07 consulta/exportação controladas | Lacunas L1, L2, L3 do diagnóstico
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 0. Schema isolado (não é exposto pela API REST do Supabase)
-- ---------------------------------------------------------------------
create schema if not exists audit;
revoke all on schema audit from public;
do $$ begin
  execute 'revoke all on schema audit from anon';
  execute 'revoke all on schema audit from authenticated';
exception when undefined_object then null; end $$;

-- ---------------------------------------------------------------------
-- 1. Perfis de acesso (RBAC) — gerenciados só pelo SQL Editor (admin)
-- ---------------------------------------------------------------------
create table if not exists public.perfis (
  user_id       uuid not null,
  papel         text not null check (papel in ('almoxarife','gestor','auditor')),
  concedido_em  timestamptz not null default now(),
  concedido_por text not null default current_user,
  primary key (user_id, papel)
);
alter table public.perfis enable row level security;
drop policy if exists perfis_ver_proprios on public.perfis;
create policy perfis_ver_proprios on public.perfis for select to authenticated using (user_id = auth.uid());
revoke all on public.perfis from anon;
revoke insert, update, delete, truncate on public.perfis from authenticated;
grant select on public.perfis to authenticated;

create or replace function public.tem_papel(p_papeis text[]) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.perfis where user_id = auth.uid() and papel = any (p_papeis));
$$;
revoke all on function public.tem_papel(text[]) from public, anon;
grant execute on function public.tem_papel(text[]) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Tabela de eventos de auditoria (somente-inclusão + hash encadeado)
-- ---------------------------------------------------------------------
create table if not exists audit.eventos (
  id              bigint generated always as identity primary key,
  evento_uuid     uuid not null unique,
  ocorrido_em     timestamptz not null,                 -- UTC (relógio do servidor)
  ator_id         uuid,                                 -- pseudônimo; e-mail fica em audit.atores
  ator_tipo       text not null check (ator_tipo in ('usuario','servico','sistema')),
  categoria       text not null,
  acao            text not null,
  criticidade     text not null check (criticidade in ('baixa','media','alta','critica')),
  recurso         text,
  recurso_id      text,
  resultado       text not null check (resultado in ('sucesso','falha','negado','parcial')),
  motivo          text,
  correlacao_id   text,
  origem          text not null check (origem in ('banco','aplicacao')),
  contexto        jsonb not null default '{}'::jsonb,
  versao_esquema  smallint not null default 1,
  hash_anterior   text,
  hash            text not null
);
create index if not exists idx_aud_tempo    on audit.eventos (ocorrido_em desc);
create index if not exists idx_aud_ator     on audit.eventos (ator_id, ocorrido_em desc);
create index if not exists idx_aud_acao     on audit.eventos (acao);
create index if not exists idx_aud_recurso  on audit.eventos (recurso, recurso_id);
alter table audit.eventos enable row level security;   -- sem políticas: ninguém lê/escreve direto
revoke all on audit.eventos from public;

-- Tabela de pseudonimização: 1 linha por usuário (e-mail não se repete em cada evento)
create table if not exists audit.atores (
  ator_id         uuid primary key,
  email           text,
  primeiro_evento timestamptz not null default now()
);
alter table audit.atores enable row level security;
revoke all on audit.atores from public;

-- Somente-inclusão: bloqueia UPDATE, DELETE e TRUNCATE para qualquer papel
create or replace function audit._bloquear() returns trigger language plpgsql as $$
begin
  raise exception 'audit.eventos é somente-inclusão: % bloqueado', tg_op using errcode = '42501';
end $$;
drop trigger if exists trg_aud_bloq_linha on audit.eventos;
create trigger trg_aud_bloq_linha before update or delete on audit.eventos
  for each row execute function audit._bloquear();
drop trigger if exists trg_aud_bloq_trunc on audit.eventos;
create trigger trg_aud_bloq_trunc before truncate on audit.eventos
  for each statement execute function audit._bloquear();

-- ---------------------------------------------------------------------
-- 3. Funções internas: sanitização, correlação e hash
-- ---------------------------------------------------------------------
-- Remove caracteres de controle (\r \n \t… -> injeção de log), separadores Unicode e
-- caracteres invisíveis/bidirecionais (U+202E etc. -> falsificação visual) e limita o tamanho
create or replace function audit._texto(t text, max_len int default 200) returns text
language sql immutable as $$
  select case when t is null then null
              else left(regexp_replace(regexp_replace(t, '[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]', '', 'g'),
                                       '[[:cntrl:]\u0085\u2028\u2029]+', ' ', 'g'), max_len) end;
$$;

-- Sanitiza jsonb: chaves [a-z0-9_] até 40 caract., profundidade 3, strings 200, até 30 itens por nível.
-- (Eventos declarados pelo app têm teto de 2 KB na entrada — ver auditar_evento.)
create or replace function audit._ctx(j jsonb, nivel int default 0) returns jsonb
language plpgsql immutable as $$
declare out jsonb; k text; v jsonb; i int := 0;
begin
  if j is null then return '{}'::jsonb; end if;
  if nivel > 3 then return to_jsonb('[profundidade excedida]'::text); end if;
  case jsonb_typeof(j)
    when 'object' then
      out := '{}'::jsonb;
      for k, v in select * from jsonb_each(j) loop
        i := i + 1; exit when i > 30;
        if k ~ '^[a-z0-9_]{1,40}$' and k !~ '(senha|password|token|secret|segredo|authorization|apikey|api_key|jwt|cookie)' then
          out := out || jsonb_build_object(k, audit._ctx(v, nivel + 1));
        end if;
      end loop;
      return out;
    when 'array' then
      return coalesce((select jsonb_agg(audit._ctx(x, nivel + 1)) from (select x from jsonb_array_elements(j) x limit 30) s), '[]'::jsonb);
    when 'string' then return to_jsonb(audit._texto(j #>> '{}'));
    else return j;   -- number, boolean, null
  end case;
end $$;

-- Correlação: cabeçalho x-correlacao enviado pelo app (validado)
create or replace function audit._correlacao() returns text language plpgsql stable as $$
declare h text;
begin
  begin
    h := (current_setting('request.headers', true)::json) ->> 'x-correlacao';
  exception when others then h := null; end;
  if h ~ '^[A-Za-z0-9-]{8,64}$' then return h; end if;
  return null;
end $$;

-- Forma canônica: array JSON (nulos explícitos, sem ambiguidade de separador)
create or replace function audit._hash(e audit.eventos) returns text language sql immutable as $$
  select encode(sha256(convert_to(jsonb_build_array(
    e.id, e.evento_uuid,
    to_char(e.ocorrido_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    e.ator_id, e.ator_tipo, e.categoria, e.acao, e.criticidade,
    e.recurso, e.recurso_id, e.resultado, e.motivo,
    e.correlacao_id, e.origem, e.contexto, e.versao_esquema,
    coalesce(e.hash_anterior, 'GENESIS'))::text, 'UTF8')), 'hex');
$$;

-- ---------------------------------------------------------------------
-- 4. Ponto ÚNICO de gravação (RF-01). Mesma transação da operação:
--    se a auditoria falhar, a operação crítica também falha (fail-closed).
-- ---------------------------------------------------------------------
create or replace function audit.registrar(
  p_categoria   text,
  p_acao        text,
  p_criticidade text,
  p_recurso     text,
  p_recurso_id  text,
  p_resultado   text,
  p_motivo      text  default null,
  p_contexto    jsonb default '{}'::jsonb,
  p_origem      text  default 'banco'
) returns bigint
language plpgsql security definer set search_path = audit, public, pg_temp as $$
declare e audit.eventos; v_uid uuid; v_email text; v_ctx jsonb; n int;
begin
  begin v_uid := auth.uid(); exception when others then v_uid := null; end;
  -- sanitização e limites ANTES da trava global (não segura as demais operações)
  v_ctx := audit._ctx(coalesce(p_contexto, '{}'::jsonb));
  if octet_length(v_ctx::text) > 16384 then        -- rede de segurança: mantém o essencial
    v_ctx := jsonb_strip_nulls(jsonb_build_object('contexto_reduzido', true, 'bytes', octet_length(v_ctx::text),
               'identificador', v_ctx -> 'identificador',
               'campos_alterados', (select jsonb_agg(k) from jsonb_object_keys(coalesce(v_ctx -> 'alteracoes', '{}'::jsonb)) k),
               'campos_pessoais_alterados', v_ctx -> 'campos_pessoais_alterados'));
  end if;

  -- Limite de taxa central: negações, falhas e eventos declarados pelo app, por usuário (60/min).
  -- Acima do limite, só são descartadas REPETIÇÕES (mesma ação, resultado e motivo no mesmo minuto);
  -- a primeira ocorrência de cada tipo — inclusive as críticas — continua sendo gravada.
  -- Operações bem-sucedidas do banco NUNCA são descartadas (fail-closed).
  if v_uid is not null and (p_resultado in ('negado','falha') or p_origem = 'aplicacao') then
    select count(*) into n from audit.eventos
     where ator_id = v_uid and ocorrido_em > clock_timestamp() - interval '1 minute'
       and (resultado in ('negado','falha') or origem = 'aplicacao');
    if n >= 60 then
      if exists (select 1 from audit.eventos where ator_id = v_uid and acao = audit._texto(p_acao, 60)
                    and resultado = p_resultado and motivo is not distinct from audit._texto(p_motivo, 120)
                    and ocorrido_em > clock_timestamp() - interval '1 minute') then
        if exists (select 1 from audit.eventos where ator_id = v_uid and acao = 'limite_excedido'
                    and ocorrido_em > clock_timestamp() - interval '1 minute') then
          return null;                                 -- repetição já sinalizada neste minuto
        end if;
        v_ctx := jsonb_build_object('acao_repetida', audit._texto(p_acao, 60));
        p_categoria := 'seguranca'; p_acao := 'limite_excedido'; p_criticidade := 'alta';
        p_recurso := null; p_recurso_id := null; p_resultado := 'negado'; p_motivo := 'taxa_eventos';
      else
        v_ctx := v_ctx || jsonb_build_object('acima_do_limite', true);
      end if;
    end if;
  end if;

  -- serializa a cadeia de hashes
  perform pg_advisory_xact_lock(7412001);

  e.id             := nextval(pg_get_serial_sequence('audit.eventos', 'id'));
  e.evento_uuid    := gen_random_uuid();
  e.ocorrido_em    := clock_timestamp();
  e.ator_id        := v_uid;
  e.ator_tipo      := case when v_uid is null then 'sistema' else 'usuario' end;
  e.categoria      := audit._texto(p_categoria, 40);
  e.acao           := audit._texto(p_acao, 60);
  e.criticidade    := p_criticidade;
  e.recurso        := audit._texto(p_recurso, 60);
  e.recurso_id     := audit._texto(p_recurso_id, 80);
  e.resultado      := p_resultado;
  e.motivo         := audit._texto(p_motivo, 120);
  e.correlacao_id  := audit._correlacao();
  e.origem         := p_origem;
  e.contexto       := v_ctx;
  e.versao_esquema := 1;
  select x.hash into e.hash_anterior from audit.eventos x order by x.id desc limit 1;
  e.hash           := audit._hash(e);

  insert into audit.eventos overriding system value select e.*;

  if v_uid is not null and not exists (select 1 from audit.atores where ator_id = v_uid) then
    begin v_email := auth.jwt() ->> 'email'; exception when others then v_email := null; end;
    insert into audit.atores (ator_id, email) values (v_uid, audit._texto(v_email, 120))
    on conflict (ator_id) do nothing;
  end if;
  return e.id;
end $$;
revoke all on function audit.registrar(text,text,text,text,text,text,text,jsonb,text) from public;

-- ---------------------------------------------------------------------
-- 5. Gatilho genérico de rastreabilidade (RF-03)
--    TG_ARGV[0] = colunas pessoais (registra só QUE mudou, nunca o valor)
--    TG_ARGV[1] = coluna identificadora de negócio (código, matrícula…)
-- ---------------------------------------------------------------------
create or replace function audit._tg_tabela() returns trigger
language plpgsql security definer set search_path = audit, public, pg_temp as $$
declare
  pessoais text[] := string_to_array(coalesce(tg_argv[0], ''), ',');
  idcol    text   := nullif(tg_argv[1], '');
  o jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  n jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  k text; alt jsonb := '{}'::jsonb; alt_p text[] := '{}'; ctx jsonb; crit text;
  ignorar text[] := array['updated_at','created_at'];
begin
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(n) loop
      continue when k = any (ignorar);
      if (o -> k) is distinct from (n -> k) then
        if k = any (pessoais) then alt_p := alt_p || k;
        else alt := alt || jsonb_build_object(k, jsonb_build_object('de', o -> k, 'para', n -> k));
        end if;
      end if;
    end loop;
    if alt = '{}'::jsonb and cardinality(alt_p) = 0 then return null; end if;   -- nada mudou
    ctx := jsonb_build_object('alteracoes', alt, 'campos_pessoais_alterados', to_jsonb(alt_p));
  else
    ctx := jsonb_build_object('campos', (select jsonb_agg(x) from jsonb_object_keys(coalesce(n, o)) x));
  end if;
  if idcol is not null then
    ctx := ctx || jsonb_build_object('identificador', coalesce(n, o) ->> idcol);
  end if;

  crit := case when tg_table_name = 'perfis' then 'critica'
               when tg_op = 'DELETE' then 'alta' else 'media' end;

  perform audit.registrar('dados', lower(tg_op), crit, tg_table_name,
                          coalesce(n, o) ->> case when tg_table_name = 'perfis' then 'user_id' else 'id' end,
                          'sucesso', null, ctx || case when tg_table_name = 'perfis'
                            then jsonb_build_object('papel', coalesce(n, o) ->> 'papel') else '{}'::jsonb end);
  return null;
end $$;

drop trigger if exists trg_aud_ferramentas on public.ferramentas;
create trigger trg_aud_ferramentas after insert or update or delete on public.ferramentas
  for each row execute function audit._tg_tabela('observacoes', 'codigo');
drop trigger if exists trg_aud_funcionarios on public.funcionarios;
create trigger trg_aud_funcionarios after insert or update or delete on public.funcionarios
  for each row execute function audit._tg_tabela('nome,funcao,setor,telefone', 'matricula');
drop trigger if exists trg_aud_fornecedores on public.fornecedores;
create trigger trg_aud_fornecedores after insert or update or delete on public.fornecedores
  for each row execute function audit._tg_tabela('nome,contato', '');
create or replace function public.tg_funcionarios_protege() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.ferramentas where funcionario_id = old.id) then
    raise exception 'Este funcionário está com ferramenta(s). Registre a devolução antes de excluir.' using errcode = '42501';
  end if;
  return old;
end $$;
drop trigger if exists trg_funcionarios_protege on public.funcionarios;
create trigger trg_funcionarios_protege before delete on public.funcionarios
  for each row execute function public.tg_funcionarios_protege();

drop trigger if exists trg_aud_perfis on public.perfis;
create trigger trg_aud_perfis after insert or update or delete on public.perfis
  for each row execute function audit._tg_tabela('', '');

-- Limites de tamanho dos textos (novas gravações; dados antigos não são reprovados)
do $$
declare c record;
begin
  for c in select * from (values
    ('ferramentas','codigo',40), ('ferramentas','nome',200), ('ferramentas','observacoes',1000), ('ferramentas','site',120),
    ('ferramentas','patrimonio',60), ('ferramentas','fornecedor',120), ('ferramentas','tipo',40),
    ('funcionarios','matricula',40), ('funcionarios','nome',200), ('funcionarios','funcao',120),
    ('funcionarios','setor',120), ('funcionarios','telefone',40),
    ('fornecedores','nome',200), ('fornecedores','contato',200)) as t(tab, col, lim)
  loop
    if not exists (select 1 from pg_constraint where conname = 'ck_tam_' || c.tab || '_' || c.col) then
      execute format('alter table public.%I add constraint %I check (char_length(%I) <= %s) not valid',
                     c.tab, 'ck_tam_' || c.tab || '_' || c.col, c.col, c.lim);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 6. Ferramentas: status/posse só mudam pelas funções oficiais (L2)
-- ---------------------------------------------------------------------
-- Só as funções oficiais (que rodam como dono, nunca como "authenticated") ligam app.via_rpc
create or replace function public._via_funcao_oficial() returns boolean language sql stable as $$
  select coalesce(current_setting('app.via_rpc', true), '') = 'on' and current_user not in ('authenticated', 'anon');
$$;

create or replace function public.tg_ferramentas_protege() returns trigger language plpgsql as $$
begin
  if public._via_funcao_oficial() then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'disponivel'; new.funcionario_id := null; new.retirada_em := null;
  elsif new.status is distinct from old.status
     or new.funcionario_id is distinct from old.funcionario_id
     or new.retirada_em is distinct from old.retirada_em then
    raise exception 'Status e posse da ferramenta só podem mudar por retirada, devolução ou manutenção'
      using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_ferramentas_protege on public.ferramentas;
create trigger trg_ferramentas_protege before insert or update on public.ferramentas
  for each row execute function public.tg_ferramentas_protege();

-- ---------------------------------------------------------------------
-- 7. Movimentações: sem inserção direta; autoria e data fixadas no servidor (L1)
-- ---------------------------------------------------------------------
alter table public.movimentacoes add column if not exists usuario_id uuid;
alter table public.movimentacoes add column if not exists tem_assinatura boolean
  generated always as (assinatura_path is not null) stored;

-- Uma assinatura só comprova UMA movimentação
do $$ begin
  if not exists (select assinatura_path from public.movimentacoes where assinatura_path is not null
                 group by assinatura_path having count(*) > 1) then
    create unique index if not exists uq_mov_assinatura on public.movimentacoes (assinatura_path)
      where assinatura_path is not null;
  else
    raise exception 'Há assinaturas repetidas no histórico antigo. Consulte: select assinatura_path, count(*) from movimentacoes group by 1 having count(*) > 1;'
      using hint = 'Nada foi alterado (a migração inteira foi desfeita). Avalie os registros e fale com o responsável antes de prosseguir.';
  end if;
end $$;

-- O caminho do arquivo de assinatura não é lido pelo cliente (só via função auditada).
revoke select on public.movimentacoes from anon, authenticated;
grant select (id, ferramenta_id, ferramenta_codigo, ferramenta_nome, acao, funcionario_id, funcionario_nome, matricula,
              site, observacao, usuario_email, usuario_id, tem_assinatura, created_at) on public.movimentacoes to authenticated;

drop policy if exists "mov_insert" on public.movimentacoes;
revoke insert, update, delete, truncate on public.movimentacoes from anon, authenticated;

create or replace function public.tg_mov_protege() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if not public._via_funcao_oficial() then
      raise exception 'Movimentações só podem ser registradas pelas funções oficiais' using errcode = '42501';
    end if;
    new.created_at := now();
    begin new.usuario_id := auth.uid(); exception when others then new.usuario_id := null; end;
    begin new.usuario_email := auth.jwt() ->> 'email'; exception when others then new.usuario_email := null; end;
    return new;
  elsif tg_op = 'UPDATE' then
    -- única alteração aceita: FK virar NULL quando a ferramenta/funcionário é excluído
    -- (tem_assinatura é coluna gerada: em gatilho BEFORE ela ainda vem nula, por isso fica fora da comparação)
    if (to_jsonb(new) - 'ferramenta_id' - 'funcionario_id' - 'tem_assinatura') is distinct from (to_jsonb(old) - 'ferramenta_id' - 'funcionario_id' - 'tem_assinatura')
       or (new.ferramenta_id is not null and new.ferramenta_id is distinct from old.ferramenta_id)
       or (new.funcionario_id is not null and new.funcionario_id is distinct from old.funcionario_id) then
      raise exception 'Histórico de movimentações não pode ser alterado' using errcode = '42501';
    end if;
    return new;
  else
    raise exception 'Histórico de movimentações não pode ser apagado' using errcode = '42501';
  end if;
end $$;
drop trigger if exists trg_mov_protege on public.movimentacoes;
create trigger trg_mov_protege before insert or update or delete on public.movimentacoes
  for each row execute function public.tg_mov_protege();

-- ---------------------------------------------------------------------
-- 8. RLS revisada por perfil (L3) — substitui as políticas "todo logado faz tudo"
-- ---------------------------------------------------------------------
drop policy if exists "fornecedores_auth" on public.fornecedores;
drop policy if exists "funcionarios_auth" on public.funcionarios;
drop policy if exists "ferramentas_auth"  on public.ferramentas;
drop policy if exists "mov_select"        on public.movimentacoes;

do $$
declare t text;
begin
  foreach t in array array['ferramentas','funcionarios','fornecedores'] loop
    execute format('drop policy if exists %I on public.%I', t || '_ler', t);
    execute format('drop policy if exists %I on public.%I', t || '_incluir', t);
    execute format('drop policy if exists %I on public.%I', t || '_alterar', t);
    execute format('drop policy if exists %I on public.%I', t || '_excluir', t);
    execute format($p$create policy %I on public.%I for select to authenticated
                     using (public.tem_papel(array['almoxarife','gestor','auditor']))$p$, t || '_ler', t);
    execute format($p$create policy %I on public.%I for insert to authenticated
                     with check (public.tem_papel(array['almoxarife','gestor']))$p$, t || '_incluir', t);
    execute format($p$create policy %I on public.%I for update to authenticated
                     using (public.tem_papel(array['almoxarife','gestor']))
                     with check (public.tem_papel(array['almoxarife','gestor']))$p$, t || '_alterar', t);
    execute format($p$create policy %I on public.%I for delete to authenticated
                     using (public.tem_papel(array['gestor']))$p$, t || '_excluir', t);
  end loop;
end $$;

drop policy if exists "movimentacoes_ler" on public.movimentacoes;
create policy "movimentacoes_ler" on public.movimentacoes for select to authenticated
  using (public.tem_papel(array['almoxarife','gestor','auditor']));

-- Storage: só PNG até 300 KB; grava quem opera, com nome no padrão ANO/MÊS/uuid.png
update storage.buckets set public = false, file_size_limit = 307200, allowed_mime_types = array['image/png']
 where id = 'assinaturas';
drop policy if exists "assinaturas_insert" on storage.objects;
drop policy if exists "assinaturas_select" on storage.objects;
create policy "assinaturas_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'assinaturas' and public.tem_papel(array['almoxarife','gestor'])
              and name ~ '^[0-9]{4}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$');
-- LIMITAÇÃO CONHECIDA: gestor/auditor conseguem baixar direto pela API do Storage sem passar pela
-- função auditada. Eliminar exige Edge Function com service_role (Fase B).
create policy "assinaturas_select" on storage.objects for select to authenticated
  using (bucket_id = 'assinaturas' and public.tem_papel(array['gestor','auditor']));

-- ---------------------------------------------------------------------
-- 9. Funções oficiais de operação (SECURITY DEFINER, autorização no servidor)
--    Nomes com sufixo _v2: as versões antigas são removidas, então um celular com a
--    página antiga aberta recebe ERRO (função inexistente) e nunca um falso "registrado".
--    Retornam jsonb {ok, erro, movimentacao_id} para que negações/falhas
--    fiquem registradas (uma exceção desfaria o próprio registro).
-- ---------------------------------------------------------------------
drop function if exists public.retirar_ferramenta(uuid, uuid, text, text, text);
drop function if exists public.devolver_ferramenta(uuid, text, text);
drop function if exists public.manutencao_ferramenta(uuid, boolean, text);
drop function if exists public.verificar_integridade_auditoria();

-- Assinatura válida = arquivo PNG enviado AGORA (≤ 15 min) pelo PRÓPRIO usuário e nunca usado antes
create or replace function public._assinatura_valida(p text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p ~ '^[0-9]{4}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$'
     and exists (select 1 from storage.objects o
                  where o.bucket_id = 'assinaturas' and o.name = p
                    and coalesce(o.owner_id, o.owner::text) = auth.uid()::text
                    and o.created_at > now() - interval '15 minutes')
     and not exists (select 1 from public.movimentacoes m where m.assinatura_path = p)
     -- mesmo conteúdo (eTag + tamanho) com outro nome de arquivo também não vale
     and not exists (
       select 1 from storage.objects novo
         join storage.objects usado on usado.bucket_id = 'assinaturas' and usado.name <> novo.name
                                   and usado.metadata ->> 'eTag' = novo.metadata ->> 'eTag'
                                   and usado.metadata ->> 'size' = novo.metadata ->> 'size'
         join public.movimentacoes m on m.assinatura_path = usado.name
        where novo.bucket_id = 'assinaturas' and novo.name = p and novo.metadata ->> 'eTag' is not null);
$$;

-- Metadados do arquivo (tamanho/eTag) para amarrar o conteúdo da imagem ao evento de auditoria
create or replace function public._assinatura_meta(p text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('tamanho', o.metadata ->> 'size', 'etag', o.metadata ->> 'eTag', 'enviada_em', o.created_at)
    from storage.objects o where o.bucket_id = 'assinaturas' and o.name = p;
$$;
revoke all on function public._assinatura_meta(text) from public, anon, authenticated;
revoke all on function public._assinatura_valida(text) from public, anon, authenticated;

create or replace function public._negar(p_acao text, p_recurso_id text, p_motivo text, p_msg text, p_res text default 'negado')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform audit.registrar('movimentacao', p_acao, case when p_res = 'negado' then 'alta' else 'media' end,
                          'ferramentas', p_recurso_id, p_res, p_motivo);
  return jsonb_build_object('ok', false, 'erro', p_msg, 'motivo', p_motivo);
end $$;
revoke all on function public._negar(text, text, text, text, text) from public, anon, authenticated;

create or replace function public.retirar_ferramenta_v2(
  p_ferramenta uuid, p_funcionario uuid, p_site text default null,
  p_assinatura text default null, p_obs text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare f ferramentas; w funcionarios; m movimentacoes;
begin
  if not public.tem_papel(array['almoxarife','gestor']) then
    return public._negar('retirada', p_ferramenta::text, 'sem_permissao', 'Acesso negado: seu usuário não tem perfil de almoxarife.');
  end if;
  select * into f from ferramentas where id = p_ferramenta for update;
  if not found then return public._negar('retirada', p_ferramenta::text, 'ferramenta_inexistente', 'Ferramenta não encontrada.', 'falha'); end if;
  if f.status <> 'disponivel' then
    return public._negar('retirada', f.id::text, 'status_' || f.status, format('A ferramenta %s não está disponível (status: %s).', f.codigo, f.status), 'falha');
  end if;
  select * into w from funcionarios where id = p_funcionario;
  if not found then return public._negar('retirada', f.id::text, 'funcionario_inexistente', 'Funcionário não encontrado.', 'falha'); end if;
  if not w.ativo then return public._negar('retirada', f.id::text, 'funcionario_inativo', 'Funcionário inativo.', 'falha'); end if;
  if p_assinatura is null or not public._assinatura_valida(p_assinatura) then
    return public._negar('retirada', f.id::text, 'assinatura_ausente', 'A assinatura do funcionário é obrigatória.', 'falha');
  end if;

  begin
    perform set_config('app.via_rpc', 'on', true);
    update ferramentas set status = 'em_uso', funcionario_id = w.id, retirada_em = now(),
           site = coalesce(nullif(trim(audit._texto(p_site, 120)), ''), site)
     where id = f.id returning * into f;
    insert into movimentacoes (ferramenta_id, ferramenta_codigo, ferramenta_nome, acao, funcionario_id,
                               funcionario_nome, matricula, site, assinatura_path, observacao)
    values (f.id, f.codigo, f.nome, 'retirada', w.id, w.nome, w.matricula, f.site, p_assinatura, audit._texto(p_obs, 500))
    returning * into m;
    perform set_config('app.via_rpc', 'off', true);
  exception when unique_violation then
    perform set_config('app.via_rpc', 'off', true);
    return public._negar('retirada', p_ferramenta::text, 'assinatura_em_uso', 'Esta assinatura já foi usada. Peça para o funcionário assinar novamente.', 'falha');
  end;

  perform audit.registrar('movimentacao', 'retirada', 'media', 'movimentacoes', m.id::text, 'sucesso', null,
    jsonb_build_object('ferramenta_id', f.id, 'ferramenta_codigo', f.codigo, 'funcionario_id', w.id,
                       'assinatura', public._assinatura_meta(p_assinatura),
                       'mov_hash', encode(sha256(convert_to(to_jsonb(m)::text, 'UTF8')), 'hex')));
  return jsonb_build_object('ok', true, 'movimentacao_id', m.id);
end $$;

create or replace function public.devolver_ferramenta_v2(
  p_ferramenta uuid, p_assinatura text default null, p_obs text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare f ferramentas; w funcionarios; m movimentacoes;
begin
  if not public.tem_papel(array['almoxarife','gestor']) then
    return public._negar('devolucao', p_ferramenta::text, 'sem_permissao', 'Acesso negado: seu usuário não tem perfil de almoxarife.');
  end if;
  select * into f from ferramentas where id = p_ferramenta for update;
  if not found then return public._negar('devolucao', p_ferramenta::text, 'ferramenta_inexistente', 'Ferramenta não encontrada.', 'falha'); end if;
  if f.status <> 'em_uso' then
    return public._negar('devolucao', f.id::text, 'status_' || f.status, format('A ferramenta %s não está em uso.', f.codigo), 'falha');
  end if;
  if p_assinatura is not null and not public._assinatura_valida(p_assinatura) then
    return public._negar('devolucao', f.id::text, 'assinatura_invalida', 'Assinatura inválida.', 'falha');
  end if;
  select * into w from funcionarios where id = f.funcionario_id;

  begin
    perform set_config('app.via_rpc', 'on', true);
    update ferramentas set status = 'disponivel', funcionario_id = null, retirada_em = null where id = f.id;
    insert into movimentacoes (ferramenta_id, ferramenta_codigo, ferramenta_nome, acao, funcionario_id,
                               funcionario_nome, matricula, site, assinatura_path, observacao)
    values (f.id, f.codigo, f.nome, 'devolucao', w.id, w.nome, w.matricula, f.site, p_assinatura, audit._texto(p_obs, 500))
    returning * into m;
    perform set_config('app.via_rpc', 'off', true);
  exception when unique_violation then
    perform set_config('app.via_rpc', 'off', true);
    return public._negar('devolucao', p_ferramenta::text, 'assinatura_em_uso', 'Esta assinatura já foi usada.', 'falha');
  end;

  perform audit.registrar('movimentacao', 'devolucao', 'media', 'movimentacoes', m.id::text, 'sucesso', null,
    jsonb_build_object('ferramenta_id', f.id, 'ferramenta_codigo', f.codigo, 'funcionario_id', w.id,
                       'dias_em_posse', round(extract(epoch from now() - f.retirada_em) / 86400.0, 2),
                       'assinatura', case when p_assinatura is null then null else public._assinatura_meta(p_assinatura) end,
                       'mov_hash', encode(sha256(convert_to(to_jsonb(m)::text, 'UTF8')), 'hex')));
  return jsonb_build_object('ok', true, 'movimentacao_id', m.id);
end $$;

create or replace function public.manutencao_ferramenta_v2(
  p_ferramenta uuid, p_iniciar boolean, p_obs text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare f ferramentas; m movimentacoes; v_acao text := case when p_iniciar then 'manutencao_inicio' else 'manutencao_fim' end;
begin
  if not public.tem_papel(array['almoxarife','gestor']) then
    return public._negar(v_acao, p_ferramenta::text, 'sem_permissao', 'Acesso negado.');
  end if;
  select * into f from ferramentas where id = p_ferramenta for update;
  if not found then return public._negar(v_acao, p_ferramenta::text, 'ferramenta_inexistente', 'Ferramenta não encontrada.', 'falha'); end if;
  if p_iniciar and f.status = 'em_uso' then
    return public._negar(v_acao, f.id::text, 'em_uso', format('Registre a devolução de %s antes de enviar para manutenção.', f.codigo), 'falha');
  end if;
  if not p_iniciar and f.status <> 'manutencao' then
    return public._negar(v_acao, f.id::text, 'nao_em_manutencao', 'A ferramenta não está em manutenção.', 'falha');
  end if;

  perform set_config('app.via_rpc', 'on', true);
  update ferramentas set status = case when p_iniciar then 'manutencao' else 'disponivel' end,
         funcionario_id = null, retirada_em = null,
         observacoes = coalesce(nullif(trim(audit._texto(p_obs, 500)), ''), observacoes)
   where id = f.id;
  insert into movimentacoes (ferramenta_id, ferramenta_codigo, ferramenta_nome, acao, site, observacao)
  values (f.id, f.codigo, f.nome, v_acao, f.site, audit._texto(p_obs, 500)) returning * into m;
  perform set_config('app.via_rpc', 'off', true);

  perform audit.registrar('movimentacao', v_acao, 'baixa', 'movimentacoes', m.id::text, 'sucesso', null,
    jsonb_build_object('ferramenta_id', f.id, 'ferramenta_codigo', f.codigo,
                       'mov_hash', encode(sha256(convert_to(to_jsonb(m)::text, 'UTF8')), 'hex')));
  return jsonb_build_object('ok', true, 'movimentacao_id', m.id);
end $$;

-- Visualização de assinatura: só gestor/auditor, sempre auditada
create or replace function public.registrar_visualizacao_assinatura(p_movimentacao uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m movimentacoes;
begin
  if not public.tem_papel(array['gestor','auditor']) then
    perform audit.registrar('privacidade', 'visualizacao_assinatura', 'alta', 'movimentacoes', p_movimentacao::text, 'negado', 'sem_permissao');
    return jsonb_build_object('ok', false, 'erro', 'Somente gestor ou auditor podem ver assinaturas.');
  end if;
  select * into m from movimentacoes where id = p_movimentacao;
  if not found or m.assinatura_path is null then
    perform audit.registrar('privacidade', 'visualizacao_assinatura', 'media', 'movimentacoes', p_movimentacao::text, 'falha', 'sem_assinatura');
    return jsonb_build_object('ok', false, 'erro', 'Movimentação sem assinatura.');
  end if;
  perform audit.registrar('privacidade', 'visualizacao_assinatura', 'media', 'movimentacoes', m.id::text, 'sucesso', null,
                          jsonb_build_object('funcionario_id', m.funcionario_id));
  return jsonb_build_object('ok', true, 'caminho', m.assinatura_path);
end $$;

-- ---------------------------------------------------------------------
-- 10. Eventos declarados pela aplicação (lista fechada + limite de taxa)
-- ---------------------------------------------------------------------
create or replace function public.auditar_evento(
  p_acao text, p_recurso_id text default null, p_contexto jsonb default '{}'::jsonb, p_resultado text default 'sucesso'
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_cat text; v_crit text; v_rec text; v_papeis text[]; n int; v_id bigint;
begin
  select c.cat, c.crit, c.rec, c.papeis into v_cat, v_crit, v_rec, v_papeis
  from (values
    ('login',                   'autenticacao', 'baixa', 'sessao',        array['almoxarife','gestor','auditor']),
    ('logout',                  'autenticacao', 'baixa', 'sessao',        array['almoxarife','gestor','auditor']),
    ('login_sem_perfil',        'autorizacao',  'alta',  'sessao',        null::text[]),
    ('exportacao_historico',    'exportacao',   'alta',  'movimentacoes', array['almoxarife','gestor','auditor']),
    ('importacao_funcionarios', 'importacao',   'alta',  'funcionarios',  array['almoxarife','gestor']),
    ('impressao_etiquetas',     'operacao',     'baixa', 'etiquetas',     array['almoxarife','gestor']),
    ('compartilhamento_whatsapp','compartilhamento','media','ferramentas', array['almoxarife','gestor'])
  ) as c(acao, cat, crit, rec, papeis)
  where c.acao = p_acao;

  if v_cat is null then
    perform audit.registrar('aplicacao', 'evento_invalido', 'media', null, null, 'negado', 'acao_fora_da_lista',
                            jsonb_build_object('acao_recebida', audit._texto(p_acao, 40)), 'aplicacao');
    return false;
  end if;
  if coalesce(p_resultado, '') not in ('sucesso','falha','negado','parcial') then p_resultado := 'falha'; end if;
  if octet_length(coalesce(p_contexto, '{}'::jsonb)::text) > 2048 then
    perform audit.registrar('aplicacao', 'evento_invalido', 'media', null, null, 'negado', 'contexto_grande',
                            jsonb_build_object('acao', audit._texto(p_acao, 40)), 'aplicacao');
    return false;
  end if;
  -- limite de taxa: aplicado centralmente em audit.registrar (60/min por usuário)
  select count(*) into n from audit.eventos
   where ator_id = auth.uid() and acao = 'limite_excedido' and ocorrido_em > clock_timestamp() - interval '1 minute';
  if n > 0 then return false; end if;

  if v_papeis is not null and not public.tem_papel(v_papeis) then
    perform audit.registrar(v_cat, p_acao, 'alta', v_rec, p_recurso_id, 'negado', 'sem_permissao', '{}'::jsonb, 'aplicacao');
    return false;
  end if;
  v_id := audit.registrar(v_cat, p_acao, v_crit, v_rec, p_recurso_id, p_resultado, null, p_contexto, 'aplicacao');
  -- registrar pode ter convertido o evento em "limite_excedido" (ou descartado): informa o app
  return v_id is not null and exists (select 1 from audit.eventos where id = v_id and acao = p_acao);
end $$;

-- ---------------------------------------------------------------------
-- 11. Consulta, exportação e verificação (somente perfil auditor; tudo auditado)
-- ---------------------------------------------------------------------
create or replace function public.consultar_auditoria(
  p_de timestamptz default now() - interval '30 days', p_ate timestamptz default now(),
  p_acao text default null, p_categoria text default null, p_resultado text default null,
  p_recurso text default null, p_recurso_id text default null, p_ator_email text default null,
  p_correlacao text default null, p_antes_de bigint default null, p_limite int default 50
) returns jsonb
language plpgsql security definer set search_path = public, audit, pg_temp as $$
declare lim int := least(greatest(coalesce(p_limite, 50), 1), 200); itens jsonb; prox bigint; filtros jsonb;
begin
  filtros := jsonb_strip_nulls(jsonb_build_object('de', p_de, 'ate', p_ate, 'acao', p_acao, 'categoria', p_categoria,
              'resultado', p_resultado, 'recurso', p_recurso, 'recurso_id', p_recurso_id,
              'ator_informado', p_ator_email is not null, 'correlacao', p_correlacao, 'pagina_antes_de', p_antes_de));
  if not public.tem_papel(array['auditor']) then
    perform audit.registrar('auditoria', 'consulta_auditoria', 'alta', 'audit.eventos', null, 'negado', 'sem_permissao');
    return jsonb_build_object('ok', false, 'erro', 'Somente o perfil auditor pode consultar a auditoria.');
  end if;
  if p_ate - p_de > interval '366 days' or p_ate < p_de then
    return jsonb_build_object('ok', false, 'erro', 'Período inválido (máximo 366 dias).');
  end if;

  with sel as (
    select e.*, a.email as ator_email
      from audit.eventos e left join audit.atores a on a.ator_id = e.ator_id
     where e.ocorrido_em between p_de and p_ate
       and (p_acao is null or e.acao = p_acao)
       and (p_categoria is null or e.categoria = p_categoria)
       and (p_resultado is null or e.resultado = p_resultado)
       and (p_recurso is null or e.recurso = p_recurso)
       and (p_recurso_id is null or e.recurso_id = p_recurso_id)
       and (p_ator_email is null or a.email ilike p_ator_email)
       and (p_correlacao is null or e.correlacao_id = p_correlacao)
       and (p_antes_de is null or e.id < p_antes_de)
     order by e.id desc
     limit lim + 1
  )
  select coalesce(jsonb_agg(to_jsonb(s) - 'hash_anterior' - 'rn' - 'total' order by s.id desc) filter (where rn <= lim), '[]'::jsonb),
         max(s.id) filter (where rn = lim and total > lim)
    into itens, prox
    from (select sel.*, row_number() over (order by id desc) rn, count(*) over () total from sel) s;

  perform audit.registrar('auditoria', 'consulta_auditoria', 'media', 'audit.eventos', null, 'sucesso', null,
                          jsonb_build_object('filtros', filtros, 'retornados', jsonb_array_length(itens)));
  return jsonb_build_object('ok', true, 'itens', itens, 'proximo_antes_de', prox);
end $$;

create or replace function public.exportar_auditoria(p_de timestamptz, p_ate timestamptz, p_finalidade text)
returns jsonb
language plpgsql security definer set search_path = public, audit, pg_temp as $$
declare itens jsonb; n int;
begin
  if not public.tem_papel(array['auditor']) then
    perform audit.registrar('auditoria', 'exportacao_auditoria', 'critica', 'audit.eventos', null, 'negado', 'sem_permissao');
    return jsonb_build_object('ok', false, 'erro', 'Somente o perfil auditor pode exportar a auditoria.');
  end if;
  if length(coalesce(trim(p_finalidade), '')) < 10 then
    return jsonb_build_object('ok', false, 'erro', 'Informe a finalidade da exportação (mínimo 10 caracteres).');
  end if;
  if p_ate - p_de > interval '366 days' or p_ate < p_de then
    return jsonb_build_object('ok', false, 'erro', 'Período inválido (máximo 366 dias).');
  end if;
  select count(*) into n from audit.eventos where ocorrido_em between p_de and p_ate;
  if n > 5000 then
    perform audit.registrar('auditoria', 'exportacao_auditoria', 'alta', 'audit.eventos', null, 'negado', 'volume_excedido',
                            jsonb_build_object('linhas', n));
    return jsonb_build_object('ok', false, 'erro', format('Período tem %s eventos; o limite por exportação é 5000. Reduza o período.', n));
  end if;
  select coalesce(jsonb_agg(to_jsonb(e) || jsonb_build_object('ator_email', a.email) order by e.id), '[]'::jsonb) into itens
    from audit.eventos e left join audit.atores a on a.ator_id = e.ator_id
   where e.ocorrido_em between p_de and p_ate;
  perform audit.registrar('auditoria', 'exportacao_auditoria', 'alta', 'audit.eventos', null, 'sucesso', null,
                          jsonb_build_object('de', p_de, 'ate', p_ate, 'linhas', n, 'finalidade', audit._texto(p_finalidade, 200)));
  return jsonb_build_object('ok', true, 'itens', itens);
end $$;

-- Verificação em lotes (até 20 000 eventos por chamada, retomando de onde parou)
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
  -- hash do evento imediatamente anterior ao início do lote
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
  return jsonb_build_object('ok', erro_id is null, 'eventos_verificados', total, 'ultimo_id', ultimo_id, 'ultimo_hash', anterior,
                            'primeiro_erro_id', erro_id, 'tipo_erro', erro_tipo,
                            'proximo_a_partir_de', case when mais then ultimo_id + 1 end);
end $$;

-- Âncora externa: confirma que um par (id, hash) anotado FORA do sistema continua na cadeia.
-- Detecta reescrita da cadeia e corte do final feitos por quem administra o banco.
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
  return jsonb_build_object('ok', ok, 'existe', h is not null,
                            'mensagem', case when ok then 'Âncora confirmada: o evento continua íntegro na cadeia.'
                                             when h is null then 'O evento anotado NÃO existe mais: possível exclusão/corte da cadeia.'
                                             else 'O hash anotado NÃO confere: possível reescrita da cadeia.' end);
end $$;

-- ---------------------------------------------------------------------
-- 12. Permissões de execução
-- ---------------------------------------------------------------------
revoke all on function public.retirar_ferramenta_v2(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.devolver_ferramenta_v2(uuid, text, text) from public, anon;
revoke all on function public.manutencao_ferramenta_v2(uuid, boolean, text) from public, anon;
revoke all on function public.registrar_visualizacao_assinatura(uuid) from public, anon;
revoke all on function public.auditar_evento(text, text, jsonb, text) from public, anon;
revoke all on function public.consultar_auditoria(timestamptz, timestamptz, text, text, text, text, text, text, text, bigint, int) from public, anon;
revoke all on function public.exportar_auditoria(timestamptz, timestamptz, text) from public, anon;
revoke all on function public.verificar_integridade_auditoria(bigint, int) from public, anon;
revoke all on function public.confirmar_ancora_auditoria(bigint, text) from public, anon;
revoke all on function public.tg_funcionarios_protege() from public, anon, authenticated;
revoke all on function public._via_funcao_oficial() from public, anon;
grant execute on function public._via_funcao_oficial() to authenticated;   -- usado pelos gatilhos; só lê estado
revoke all on function public.tg_ferramentas_protege() from public, anon, authenticated;
revoke all on function public.tg_mov_protege() from public, anon, authenticated;

grant execute on function public.retirar_ferramenta_v2(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.devolver_ferramenta_v2(uuid, text, text) to authenticated;
grant execute on function public.manutencao_ferramenta_v2(uuid, boolean, text) to authenticated;
grant execute on function public.registrar_visualizacao_assinatura(uuid) to authenticated;
grant execute on function public.auditar_evento(text, text, jsonb, text) to authenticated;
grant execute on function public.consultar_auditoria(timestamptz, timestamptz, text, text, text, text, text, text, text, bigint, int) to authenticated;
grant execute on function public.exportar_auditoria(timestamptz, timestamptz, text) to authenticated;
grant execute on function public.verificar_integridade_auditoria(bigint, int) to authenticated;
grant execute on function public.confirmar_ancora_auditoria(bigint, text) to authenticated;
-- higiene: auxiliares do schema audit não ficam executáveis por PUBLIC
revoke all on all functions in schema audit from public;

-- A view de alertas passa a respeitar os perfis (security_invoker já herda a RLS)
-- ---------------------------------------------------------------------
-- 13. Carga inicial de perfis — HIPÓTESE REVERSÍVEL: todos os usuários já
--     existentes recebem "almoxarife" para não interromper a operação
--     (apenas na PRIMEIRA execução: com perfis já cadastrados nada é concedido).
--     Gestor e auditor devem ser concedidos manualmente (ver README).
-- ---------------------------------------------------------------------
insert into public.perfis (user_id, papel, concedido_por)
select u.id, 'almoxarife', 'migracao_002' from auth.users u
 where not exists (select 1 from public.perfis)      -- reexecutar a migração NÃO concede perfis de novo
on conflict do nothing;

-- Marco inicial da cadeia
select audit.registrar('auditoria', 'migracao_aplicada', 'alta', 'schema', '002_auditoria_fase_a', 'sucesso', null,
                       jsonb_build_object('versao', '002', 'descricao', 'Fase A: auditoria, perfis e integridade'));

commit;
