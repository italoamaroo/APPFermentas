-- =====================================================================
--  REVERSÃO DA MIGRAÇÃO 002 (use só se a Fase A causar problema grave)
--  - Restaura funções e políticas do schema.sql original.
--  - MANTÉM audit.eventos, audit.atores e public.perfis (evidências).
--  - ATENÇÃO: reabre as lacunas L1-L3 do diagnóstico. Registre o motivo.
--  - Depois de reverter, publique também a versão anterior do front-end.
-- =====================================================================
begin;

select audit.registrar('auditoria', 'migracao_revertida', 'critica', 'schema', '002_auditoria_fase_a', 'sucesso', null,
                       jsonb_build_object('aviso', 'controles da Fase A desativados'));

-- gatilhos de auditoria e proteção (a tabela de eventos continua somente-inclusão)
drop trigger if exists trg_aud_ferramentas   on public.ferramentas;
drop trigger if exists trg_aud_funcionarios  on public.funcionarios;
drop trigger if exists trg_aud_fornecedores  on public.fornecedores;
drop trigger if exists trg_aud_perfis        on public.perfis;
drop trigger if exists trg_ferramentas_protege on public.ferramentas;
drop trigger if exists trg_mov_protege       on public.movimentacoes;
drop trigger if exists trg_funcionarios_protege on public.funcionarios;

-- políticas por perfil
do $$
declare t text;
begin
  foreach t in array array['ferramentas','funcionarios','fornecedores'] loop
    execute format('drop policy if exists %I on public.%I', t || '_ler', t);
    execute format('drop policy if exists %I on public.%I', t || '_incluir', t);
    execute format('drop policy if exists %I on public.%I', t || '_alterar', t);
    execute format('drop policy if exists %I on public.%I', t || '_excluir', t);
  end loop;
end $$;
drop policy if exists "movimentacoes_ler" on public.movimentacoes;
drop policy if exists "assinaturas_insert" on storage.objects;
drop policy if exists "assinaturas_select" on storage.objects;

-- funções novas
drop function if exists public.retirar_ferramenta_v2(uuid, uuid, text, text, text);
drop function if exists public.devolver_ferramenta_v2(uuid, text, text);
drop function if exists public.manutencao_ferramenta_v2(uuid, boolean, text);
drop function if exists public.retirar_ferramenta(uuid, uuid, text, text, text);
drop function if exists public.devolver_ferramenta(uuid, text, text);
drop function if exists public.manutencao_ferramenta(uuid, boolean, text);
drop function if exists public.registrar_visualizacao_assinatura(uuid);
drop function if exists public.auditar_evento(text, text, jsonb, text);
drop function if exists public.consultar_auditoria(timestamptz, timestamptz, text, text, text, text, text, text, text, bigint, int);
drop function if exists public.exportar_auditoria(timestamptz, timestamptz, text);
drop function if exists public.verificar_integridade_auditoria(bigint, int);
drop function if exists public.confirmar_ancora_auditoria(bigint, text);
drop function if exists public._assinatura_meta(text);
drop function if exists public.tg_funcionarios_protege();
drop function if exists public._negar(text, text, text, text, text);
drop function if exists public._assinatura_valida(text);
drop function if exists public.tg_ferramentas_protege();
drop function if exists public.tg_mov_protege();
drop function if exists public._via_funcao_oficial();

-- políticas originais (drop antes: a reversão pode ser reexecutada)
drop policy if exists "fornecedores_auth" on public.fornecedores;
drop policy if exists "funcionarios_auth" on public.funcionarios;
drop policy if exists "ferramentas_auth"  on public.ferramentas;
drop policy if exists "mov_select"        on public.movimentacoes;
drop policy if exists "mov_insert"        on public.movimentacoes;
create policy "fornecedores_auth" on public.fornecedores  for all    to authenticated using (true) with check (true);
create policy "funcionarios_auth" on public.funcionarios  for all    to authenticated using (true) with check (true);
create policy "ferramentas_auth"  on public.ferramentas   for all    to authenticated using (true) with check (true);
create policy "mov_select"        on public.movimentacoes for select to authenticated using (true);
create policy "mov_insert"        on public.movimentacoes for insert to authenticated with check (true);
grant insert, select on public.movimentacoes to authenticated;
drop index if exists public.uq_mov_assinatura;
create policy "assinaturas_insert" on storage.objects for insert to authenticated with check (bucket_id = 'assinaturas');
create policy "assinaturas_select" on storage.objects for select to authenticated using (bucket_id = 'assinaturas');

drop function if exists public.tem_papel(text[]);

-- funções originais (idênticas ao schema.sql)
create or replace function public.retirar_ferramenta(
  p_ferramenta uuid, p_funcionario uuid, p_site text default null, p_assinatura text default null, p_obs text default null
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
  update ferramentas set status = 'em_uso', funcionario_id = w.id, retirada_em = now(),
         site = coalesce(nullif(trim(p_site), ''), site)
   where id = f.id returning * into f;
  insert into movimentacoes (ferramenta_id, ferramenta_codigo, ferramenta_nome, acao,
                             funcionario_id, funcionario_nome, matricula, site, assinatura_path, observacao)
  values (f.id, f.codigo, f.nome, 'retirada', w.id, w.nome, w.matricula, f.site, p_assinatura, p_obs)
  returning * into m;
  return m;
end $$;

create or replace function public.devolver_ferramenta(
  p_ferramenta uuid, p_assinatura text default null, p_obs text default null
) returns public.movimentacoes
language plpgsql security invoker set search_path = public as $$
declare f ferramentas; w funcionarios; m movimentacoes;
begin
  select * into f from ferramentas where id = p_ferramenta for update;
  if not found then raise exception 'Ferramenta não encontrada'; end if;
  if f.status <> 'em_uso' then raise exception 'A ferramenta % não está em uso', f.codigo; end if;
  select * into w from funcionarios where id = f.funcionario_id;
  update ferramentas set status = 'disponivel', funcionario_id = null, retirada_em = null where id = f.id;
  insert into movimentacoes (ferramenta_id, ferramenta_codigo, ferramenta_nome, acao,
                             funcionario_id, funcionario_nome, matricula, site, assinatura_path, observacao)
  values (f.id, f.codigo, f.nome, 'devolucao', w.id, w.nome, w.matricula, f.site, p_assinatura, p_obs)
  returning * into m;
  return m;
end $$;

create or replace function public.manutencao_ferramenta(
  p_ferramenta uuid, p_iniciar boolean, p_obs text default null
) returns public.movimentacoes
language plpgsql security invoker set search_path = public as $$
declare f ferramentas; m movimentacoes;
begin
  select * into f from ferramentas where id = p_ferramenta for update;
  if not found then raise exception 'Ferramenta não encontrada'; end if;
  if p_iniciar and f.status = 'em_uso' then
    raise exception 'Registre a devolução de % antes de enviar para manutenção', f.codigo;
  end if;
  update ferramentas set status = case when p_iniciar then 'manutencao' else 'disponivel' end,
         funcionario_id = null, retirada_em = null,
         observacoes = coalesce(nullif(trim(p_obs), ''), observacoes)
   where id = f.id;
  insert into movimentacoes (ferramenta_id, ferramenta_codigo, ferramenta_nome, acao, site, observacao)
  values (f.id, f.codigo, f.nome, case when p_iniciar then 'manutencao_inicio' else 'manutencao_fim' end, f.site, p_obs)
  returning * into m;
  return m;
end $$;

revoke all on function public.retirar_ferramenta(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.devolver_ferramenta(uuid, text, text)            from public, anon;
revoke all on function public.manutencao_ferramenta(uuid, boolean, text)       from public, anon;
grant execute on function public.retirar_ferramenta(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.devolver_ferramenta(uuid, text, text)            to authenticated;
grant execute on function public.manutencao_ferramenta(uuid, boolean, text)       to authenticated;

commit;
