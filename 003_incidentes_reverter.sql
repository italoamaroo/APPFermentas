-- =====================================================================
--  REVERSÃO DA MIGRAÇÃO 003 (registro de incidentes)
--  - MANTÉM as tabelas incidentes, incidentes_comunicacoes e incidentes_historico
--    (guarda mínima de 5 anos — Res. CD/ANPD 15/2024, art. 10). Elas ficam somente leitura.
--  - Remove as funções de operação e devolve as versões da Fase A das funções de verificação.
--  - Mantém o perfil "encarregado" no cadastro de perfis (não apaga concessões já feitas).
-- =====================================================================
begin;
select audit.registrar('auditoria', 'migracao_revertida', 'critica', 'schema', '003_incidentes', 'sucesso', null,
                       jsonb_build_object('aviso', 'funções de incidentes desativadas; registros preservados'));
drop function if exists public.registrar_incidente(text, text, timestamptz, timestamptz);
drop function if exists public.atualizar_incidente(uuid, jsonb, text);
drop function if exists public.registrar_comunicacao_incidente(uuid, text, timestamptz, text, text, text);
drop function if exists public.encerrar_incidente(uuid, text);
drop function if exists public.reabrir_incidente(uuid, text);
drop function if exists public.definir_pequeno_porte(boolean, text);
drop function if exists public._inc_automatico(text, text, text);
drop function if exists public._inc_abrir(text, text, text, timestamptz, timestamptz);
drop function if exists public._inc_hist(uuid, text, jsonb, text);
-- o front-end passa a mostrar "registro não ativado" (sem botão quebrado); os dados continuam guardados
revoke select on public.v_incidentes from authenticated;

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

commit;
