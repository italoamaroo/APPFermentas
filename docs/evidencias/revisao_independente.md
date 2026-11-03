# Revisão independente — Fase A (03/11/2026)

O revisor não participou do desenvolvimento. Ele trabalhou sem alterar o projeto e escreveu suas próprias sondas de ataque, em Postgres real (PGlite) com simulação do Supabase.

## Rodada 1: resultado BLOQUEADO

| # | Achado | Sev. | Situação após correção | Teste de regressão |
|---|---|---|---|---|
| 1 | Assinatura "obrigatória" podia ser reutilizada em outra retirada | Alta | **Corrigido**: exige o próprio dono, até 15 min, uso único (índice único) e caminho oculto ao cliente | R01–R04 |
| 2 | Inundação de eventos negados sem limite, numa tabela que não pode ser apagada | Alta | **Corrigido**: limite central de 60/min por usuário | R07, R08, T23 |
| 3 | Contexto sem teto, sanitizado com a trava global presa | Alta | **Corrigido**: teto de 2 KB para eventos do app, redução no ponto de gravação, sanitização antes da trava | R09, R10 |
| 4 | Verificação de integridade inviável em tabela grande | Média | **Corrigido**: verificação em lotes de 20 000 | R18 |
| 5 | Gestor e auditor baixam assinatura direto do Storage, sem rastro | Média | **Documentado** (R11 no §5): Edge Function na Fase B | — |
| 6 | Leitura direta pela API contorna a "exportação auditada" | Média | **Documentado** (R12 no §5) | — |
| 7 | Reexecutar a migração reconcedia perfil de almoxarife | Média | **Corrigido**: carga inicial só com `perfis` vazia | R11 |
| 8 | Reescrita total ou corte do final da cadeia não detectados | Média | **Corrigido parcialmente**: âncora externa e `confirmar_ancora_auditoria`. O modo replica foi documentado (R14) | R19, R20 |
| 9 | Texto livre (observações) gravado no de/para | Média | **Corrigido** | R12 |
| 10 | Conteúdo da imagem fora do hash | Média | **Corrigido**: tamanho e eTag registrados no evento | R06 |
| 11 | Órfãos, upload não auditado, bucket sem restrição | Média | **Corrigido parcialmente**: bucket só PNG até 300 KB e padrão de nome. Órfãos documentados (R13) | R05 |
| 12 | Hash com canonicalização ambígua | Baixa | **Corrigido**: array JSON | R21 |
| 13 | Proteção dependia só de configuração de sessão | Baixa | **Corrigido**: exige papel diferente de `authenticated` | R13 |
| 14 | Resultado nulo causava erro 500 | Baixa | **Corrigido** | R15 |
| 15 | Mensagem enganosa ao excluir funcionário com ferramenta | Baixa | **Corrigido** | R16 |
| 16 | Reversão não reexecutável | Baixa | **Corrigido** | R22 |
| 17 | Caractere bidirecional (U+202E) preservado | Baixa | **Corrigido** | R17 |
| 18 | Interface por perfil (impressão, WhatsApp, falha de rede tratada como "sem perfil", UUID alternativo) | Baixa | **Corrigido** | N05b, revisão de código |
| 19 | Concessão de perfil pelo SQL Editor sem autoria verificável | Baixa | **Documentado** (R15) | — |
| S1 | Clientes antigos poderiam mostrar falso "registrado" | Média | **Corrigido**: funções renomeadas para `*_v2` | — |
| S2 | CORS do cabeçalho `x-correlacao` | Média | **Mitigado**: opção `ENVIAR_CORRELACAO=0`; validar no ambiente real | — |
| S3, S5, S6 | Upload do almoxarife, RLS do dono no storage, realtime | — | **Validar no Supabase real** (§15, passo 6) | — |

## Rodada 2 (re-verificação): bloqueadores fechados

O revisor confirmou que os bloqueadores 1, 2, 3 e 7 estão fechados e que nenhuma das regressões que procurou existia. Ele também apontou brechas novas, abertas pelas próprias correções, todas tratadas depois:

| # | Brecha | Sev. | Situação | Teste |
|---|---|---|---|---|
| N1 | Acima do limite, as tentativas críticas do usuário também eram descartadas | Média | **Corrigido**: só repetições (mesma ação, resultado e motivo) são descartadas | R23 |
| N2 | O teto de 4 KB apagava o de/para das alterações cadastrais | Média | **Corrigido**: teto só para eventos do app, redução mantendo identificador e campos, limites de tamanho nas colunas | R24, R25 |
| N3 | Mesma imagem reenviada com outro nome | Baixa/Média | **Corrigido**: compara eTag e tamanho | R26 |
| N4 | Corrida no índice único virava erro 500; duplicatas antigas passavam despercebidas | Baixa | **Corrigido**: retorna `{ok:false}` auditado; a migração para com mensagem clara | — |

Limitação residual: se o Storage não preencher `metadata`, a checagem do N3 é ignorada (o Storage do Supabase preenche). Validar no ambiente real.

Parecer final do revisor (rodada 2): **não bloquearia por código**. A liberação fica condicionada ao teste de aceitação no Supabase real.
