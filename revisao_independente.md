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

---

# Revisão independente: Fase B.1 (registro de incidentes)

## Rodada 1: BLOQUEADO

| # | Achado | Sev. | Situação | Teste |
|---|---|---|---|---|
| 1 | As funções de calendário podiam ser executadas sem login (herdavam EXECUTE de PUBLIC) e não tinham limite de iterações, o que permitia ocupar a CPU do banco | Alta | **Corrigido**: revoke de PUBLIC e anon; `p_dias` entre 0 e 60; distância limitada a 400 dias | X01, X02 |
| 2 | Um prazo vencido aparecia como "vence HOJE" quando o dia atual era fim de semana ou feriado | Média (bloqueia) | **Corrigido**: vencido devolve no mínimo −1; o JavaScript espelha a regra | X03, B01b |
| 3 | O enquadramento como pequeno porte recalculava para trás os prazos de incidentes antigos | Média | **Corrigido**: o regime é gravado na primeira ciência, que não pode ser apagada | X04, Y02, Y03 |
| 4 | Datas de ciência e de comunicação informadas livremente | Média | **Corrigido**: nada pode ser anterior à detecção; ciência tardia exige justificativa e fica sinalizada; detecção retroativa é sinalizada e limitada a 1 ano | X05–X08, Y05, Y06 |
| 5 | Era possível encerrar sem o conteúdo mínimo do art. 10 | Média | **Corrigido**: II, III e IV são exigidos para todos os incidentes; I e VI também, se houver risco relevante | X09, Y01 |
| 6 | Inundação do registro permanente | Média | **Corrigido**: 5 registros por hora (almoxarife) e 20 (gestor ou encarregado) | X10 |
| 7 | Quem comunicou podia ler a investigação | Média | **Corrigido** | I12 |
| 8 | Incidente automático: duplicidade, histórico e separação de funções | Baixa/Média | **Corrigido**: trava, `nova_ocorrencia` no histórico, edição e encerramento só pelo encarregado | X14, X15 |
| 9 | Listas e títulos sem limite ou sanitização | Baixa | **Corrigido** | X11–X13, Y04 |
| 10 | Prazo de complementação sem alerta; ordem de reversão | Baixa | **Corrigido e documentado** | X17 |

## Rodada 2: não bloqueia

Os bloqueadores foram confirmados como fechados, sem regressões novas. Os resíduos apontados (o atalho de apagar a ciência para recalcular o regime, o art. 10 nos casos sem risco relevante, a detecção retroativa, a edição do incidente automático pelo gestor e a repetição em `criterios_art5`) também foram corrigidos (testes Y01–Y06).

Riscos residuais aceitos:
- O limite por hora não usa trava, então rajadas simultâneas podem ultrapassá-lo um pouco.
- As datas informadas por pessoas são validadas quanto à coerência, mas não quanto à veracidade.
- Feriados locais não são descontados (cálculo conservador).
