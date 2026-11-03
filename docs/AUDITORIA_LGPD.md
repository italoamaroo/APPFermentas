# Auditoria de Logs, Segurança e LGPD — Fase A

Sistema: Almoxarifado / APPFermentas · Versão do módulo: 002 (Fase A) · Data da avaliação técnica: 03/11/2026

> Este documento descreve controles **técnicos**. Ele não é parecer jurídico nem certificação de conformidade com a LGPD.
> Itens marcados **LACUNA DE REQUISITO IDENTIFICADA** dependem de decisão de pessoas da organização.

---

## 1. Resumo executivo

O diagnóstico (Etapa 1) encontrou uma falha **crítica**: qualquer usuário logado podia gravar no histórico uma movimentação falsa, com o e-mail de outra pessoa e data retroativa. Também havia falhas altas: nenhum rastro de exclusões e alterações, ausência de perfis de acesso e uma biblioteca de planilhas vulnerável (CVE-2023-30533).

A Fase A corrige esses pontos com:

- **Tabela de auditoria somente-inclusão** (`audit.eventos`) com **hash encadeado** SHA-256. O administrador do banco só altera eventos desligando gatilhos. Alteração e exclusão no meio da cadeia são detectadas pela verificação. Reescrita total ou corte do final só são detectados com **âncora externa** (§6).
- **Histórico de movimentações blindado:** só as funções oficiais (`*_v2`) gravam. Autor e data vêm do token e do relógio do servidor. A assinatura é obrigatória e conferida no servidor: tem que ter sido enviada pelo próprio usuário há no máximo 15 minutos, e cada uma vale para uma única movimentação.
- **Perfis** almoxarife, gestor e auditor, com autorização **no banco (RLS e funções)**. A interface apenas esconde botões.
- **Rastreabilidade** de inclusões, alterações e exclusões em ferramentas, funcionários, fornecedores e perfis. Em dados pessoais, o registro guarda **só o nome do campo alterado**, nunca o valor.
- **Eventos da aplicação** (login, logout, importação, exportação, impressão, compartilhamento por WhatsApp, visualização de assinatura) por uma **lista fechada**, com sanitização e limite de taxa.
- **Consulta, exportação e verificação de integridade** só para o auditor. Toda consulta e exportação gera evento próprio, e a exportação exige finalidade.
- **Falha fechada:** no Render, sem configuração, o site mostra erro em vez de cair em "modo demonstração". Exportações não acontecem se a auditoria não for gravada.
- O SheetJS 0.18.5 foi substituído por `read-excel-file@9.3.12` e `write-excel-file@4.1.1`, com 0 vulnerabilidades no `npm audit`.

Testes: 77 no banco (Postgres real em memória, com simulação do Supabase), sendo 26 deles de regressão dos achados da revisão independente, e 25 no navegador. Todos passaram; as evidências estão em `docs/evidencias/`. **Não houve teste contra o Supabase real** do projeto (ver §14 e §15, passo 6).

## 2. Caracterização

| Item | Valor | Evidência |
|---|---|---|
| Arquitetura | Páginas estáticas (Render) e Supabase (Postgres 15+, PostgREST, Auth, Storage, Realtime) | `render.yaml`, `public/`, `supabase/` |
| Camada confiável | Somente o Postgres (RLS, funções `SECURITY DEFINER`, gatilhos) | Não há back-end próprio |
| Autenticação | Supabase Auth, e-mail e senha | `public/js/core.js` |
| Titulares | Empregados/colaboradores (cadastro e assinatura) e almoxarifes, gestores e auditores (usuários) | Modelo de dados |
| Dados pessoais | Nome, matrícula, função, setor, telefone, **imagem da assinatura**, e-mail de usuário, IP e navegador (sessões do Supabase Auth) | `schema.sql`, Supabase Auth |
| Controlador | **LACUNA DE REQUISITO IDENTIFICADA** | O domínio do e-mail de login sugere a organização, mas não comprova |
| Operadores | Supabase Inc. (banco/storage/auth) e Render (hospedagem estática, sem dados pessoais). **Contratos, DPA e região: pendentes** | — |
| Encarregado (DPO) | **LACUNA DE REQUISITO IDENTIFICADA** | — |

## 3. Normativos e referências (verificados em 03/11/2026)

| Referência | Uso neste projeto | Natureza |
|---|---|---|
| Lei 13.709/2018 (LGPD), especialmente os princípios de necessidade, segurança, prevenção e responsabilização; direitos do titular; medidas de segurança; comunicação de incidentes | Base dos controles | Obrigação legal |
| Res. CD/ANPD nº 15/2024 (Regulamento de Comunicação de Incidente) | Comunicação em **3 dias úteis** quando houver risco ou dano relevante. **Registro de todos os incidentes por no mínimo 5 anos.** Números dos artigos: conferir no DOU | Obrigação legal (controlador) |
| Res. CD/ANPD nº 2/2022 (agentes de pequeno porte) | Prazos em dobro e registro simplificado **se** a organização se enquadrar | Depende de avaliação |
| Res. CD/ANPD nº 18/2024 (encarregado), nº 19/2024 (transferência internacional), nº 32/2026 (adequação UE) | A nº 19 depende da região do projeto Supabase | Depende de avaliação |
| NR-6, item 6.5.1 "d" e 6.5.1.1 (Portaria MTP 2.175/2022) | Registro do fornecimento de EPI, inclusive em sistema eletrônico, com extração de relatórios | Obrigação legal (trabalhista) |
| Marco Civil da Internet, art. 15 | Guarda de registros de acesso por 6 meses: **provavelmente inaplicável** (sistema interno), **requer avaliação jurídica** | Ponto jurídico |
| OWASP Logging Cheat Sheet / OWASP Developer Guide | O que registrar e excluir, sanitização, proteção dos logs | Boa prática |
| NVD/CVE-2023-30533 | Vulnerabilidade do SheetJS ≤ 0.19.2 | Segurança |

Não foi localizada, até a data acima, resolução da ANPD específica sobre RIPD ou sobre dados biométricos (estão na agenda regulatória).

## 4. Diagnóstico (antes → depois)

| Controle | Antes | Depois da Fase A | Evidência |
|---|---|---|---|
| Inserção forjada no histórico | Possível (T00) | **Bloqueada** (T04) | `testes_sql_fase_a.txt` |
| Status ou posse alterados fora do fluxo | Possível | **Bloqueado** (T05, T06) | idem |
| Rastro de alterações e exclusões | Ausente | Implementado e testado (T16–T19, T28) | idem |
| Perfis de acesso | Ausente | Implementado e testado (T12–T15, T22, T29, T36–T39) | idem |
| Proteção da trilha | Ausente | Implementado e testado (T24–T27, T42–T45) | idem |
| Minimização nos eventos | Ausente | Implementado e testado (T17, T20, T40) | idem |
| Biblioteca de planilhas | Vulnerável | Substituída e testada (N15–N19) | `testes_navegador.txt` |
| Falha fechada sem configuração | Ausente | Implementado e testado (N01, N12) | idem |
| Retenção e descarte | Ausente | **Ausente (Fase B)** | — |
| Alertas automáticos | Ausente | **Ausente (Fase B)**; só a verificação manual de integridade | — |
| Registro de incidentes (Res. 15/2024) | Ausente | **Ausente (Fase B)** | — |
| Cabeçalhos de segurança (CSP) | Ausente em produção | **Ausente (Fase B)**; configurar no Render | — |
| Logs de autenticação do Supabase | Não configurado | **Pendente de configuração manual** (§15) | — |

## 5. Matriz de lacunas e riscos (situação após a Fase A)

Severidade = probabilidade × impacto (Alta/Média/Baixa); a crítica exige correção antes da liberação.

| ID | Lacuna remanescente | Risco | Sev. | Recomendação | Responsável pela validação |
|---|---|---|---|---|---|
| R1 | Quem administra o banco (dono do projeto Supabase) pode desligar gatilhos e reescrever a cadeia inteira de hashes | Adulteração indetectável se não houver âncora externa | Média | Fase B: guardar o "último hash" fora do Supabase periodicamente (e-mail ou storage de outro provedor) | Segurança da Informação |
| R2 | Sem retenção e descarte automatizados | Retenção excessiva de assinaturas e auditoria | Média | Definir prazos (§9) e implementar na Fase B | Jurídico / RH |
| R3 | Base legal e natureza da imagem da assinatura não avaliadas | Tratamento sem fundamento documentado; possível dado sensível | Alta | Parecer jurídico | Jurídico / DPO |
| R4 | Sem registro de incidentes | Descumprir a Res. 15/2024 | Alta | Fase B (módulo de incidentes) ou processo fora do sistema | DPO |
| R5 | Falha de login não registrada pela aplicação (o usuário ainda não está autenticado) | Força bruta pouco visível | Média | Ativar os logs de auditoria do Supabase Auth no banco (§15). Alertas na Fase B | TI |
| R6 | Tentativas negadas pela RLS em acesso direto à API (ex.: DELETE sem perfil) retornam 0 linhas sem gerar evento | Tentativas de abuso via API não aparecem | Baixa | Aceitar (a operação não ocorre) ou usar funções para todas as escritas | Segurança |
| R7 | Sem CSP; a sessão do Supabase fica no `localStorage` | Um XSS levaria ao roubo da sessão | Média | Configurar cabeçalhos no Render (Fase B) | TI |
| R8 | Arquivos exportados saem do controle técnico | Vazamento de planilhas | Média | Política de manuseio e descarte (§9); alerta na interface (feito) | Gestão |
| R9 | A correlação identifica a sessão da página, não cada requisição | Investigação um pouco menos precisa | Baixa | Aceitar | — |
| R10 | Testes rodaram em Postgres com simulação do Supabase, não no projeto real | Diferença de ambiente | Média | Teste de aceitação após aplicar (§15, passo 6) | TI |
| R11 | Gestor e auditor conseguem baixar uma assinatura direto pela API do Storage, sem passar pela função que registra a visualização | Visualização sem rastro | Média | Fase B: link temporário gerado por Edge Function com `service_role` | TI |
| R12 | Quem tem leitura (qualquer perfil) pode ler movimentações e funcionários direto pela API, sem passar pela exportação auditada. O evento `exportacao_historico` é declarado pelo app e pode ser forjado (origem `aplicacao`) | A "exportação controlada" vale só para a interface | Média | Aceitar e documentar, ou Fase B: leitura apenas por funções | Segurança |
| R13 | Uploads de assinatura recusados pelo banco deixam arquivos órfãos no bucket | Dado pessoal sem finalidade | Baixa | Fase B: rotina de limpeza de órfãos com mais de 1 hora | TI |
| R14 | Com `session_replication_role=replica`, o administrador desliga todos os gatilhos sem alterar a estrutura do banco | Adulteração direta | Média | Âncora externa (R1); Fase B: event trigger e alerta | Segurança |
| R15 | Concessões de perfil feitas no SQL Editor ficam com `ator_tipo='sistema'`; `concedido_por` é texto livre | Autoria da concessão não verificável | Baixa | Preencher `concedido_por` com nome e chamado de autorização (§15) | Gestão |

## 6. Arquitetura e decisões técnicas

- **Ponto único de gravação:** `audit.registrar(...)` (`SECURITY DEFINER`). Todos os eventos passam por ele, que sanitiza, numera, encadeia o hash e grava. *Alternativa descartada:* tabela de logs no schema `public`, que ficaria exposta pela API REST.
- **Mesma transação da operação (fail-closed):** se a auditoria falha, a retirada, a devolução ou a alteração também falha. *Alternativa descartada:* fila assíncrona ou outbox, desnecessária neste volume e com risco de perda.
- **Negações registradas:** as funções oficiais retornam `{ok:false}` em vez de lançar exceção. Uma exceção desfaria a própria gravação do evento de "negado".
- **Pseudonimização:** o evento guarda o `ator_id` (UUID). O e-mail fica uma única vez em `audit.atores`, o que facilita o atendimento a titulares e evita repetir o dado em cada linha.
- **Hash encadeado:** SHA-256 sobre uma forma canônica do evento (UTC fixo, `jsonb` normalizado) mais o hash anterior, serializado com `pg_advisory_xact_lock`. Lacunas na numeração (`id`) são normais quando uma transação é desfeita; a integridade é dada pelo encadeamento, não pela numeração.
- **Limitação declarada:** o hash não tem chave secreta. Quem controla o banco pode recalcular a cadeia ou cortar o final, e a verificação simples continuaria "ok". Por isso existe a **âncora externa**: a aba Auditoria mostra "Evento #N e hash", que deve ser anotado fora do Supabase. `confirmar_ancora_auditoria(N, hash)` acusa se o evento sumiu ou se o hash mudou (testes R19 e R20).
- **Hash canônico:** array JSON (`jsonb_build_array`), sem ambiguidade de separador ou nulo (R21). A verificação roda em lotes de 20 000 eventos (R18).
- **Limites anti-abuso:** o app recusa contexto acima de 2 KB, e o ponto de gravação reduz contextos acima de 16 KB mantendo identificador e campos alterados. As colunas de texto têm limite de tamanho. Negações, falhas e eventos de aplicação têm limite de 60 por minuto por usuário. Acima disso só **repetições** (mesma ação, resultado e motivo) são descartadas, com um único `limite_excedido`: a primeira tentativa de cada tipo, inclusive as críticas, continua registrada. A sanitização roda **antes** da trava global. Operações bem-sucedidas do banco nunca são descartadas.
- **Eventos da aplicação** vêm de lista fechada no servidor (`auditar_evento`). Têm origem `aplicacao` e confiança menor que os eventos `banco`.

## 7. Modelo de dados e catálogo de eventos

`audit.eventos`: `id`, `evento_uuid`, `ocorrido_em` (UTC, relógio do servidor), `ator_id`, `ator_tipo`, `categoria`, `acao`, `criticidade`, `recurso`, `recurso_id`, `resultado` (sucesso/falha/negado/parcial), `motivo`, `correlacao_id`, `origem` (banco/aplicacao), `contexto` (jsonb sanitizado), `versao_esquema`, `hash_anterior`, `hash`.

| Categoria / ação | Origem | Criticidade | Contexto registrado (sem valores pessoais) | Justificativa |
|---|---|---|---|---|
| movimentacao / retirada, devolucao, manutencao_* | banco | média/baixa; alta se negado | ids, código da ferramenta, tamanho e eTag do arquivo da assinatura, `mov_hash`, dias em posse | Prova de entrega (NR-6) e responsabilização |
| movimentacao / … resultado falha/negado | banco | média/alta | motivo (`sem_permissao`, `assinatura_ausente`, `status_*`…) | Detectar abuso e erros |
| dados / insert, update, delete (ferramentas, funcionarios, fornecedores) | banco | média; exclusão alta | de/para só em campos **não pessoais**; nomes dos campos pessoais **e de texto livre** (nome, função, setor, telefone, observações, nome e contato do fornecedor) alterados; identificador de negócio (código da ferramenta, matrícula) | Rastreabilidade de cadastros |
| dados / insert, delete em `perfis` | banco | **crítica** | papel concedido ou revogado | Alteração de permissão |
| privacidade / visualizacao_assinatura | banco | média; negado alta | id do funcionário | Acesso a dado pessoal relevante |
| autenticacao / login, logout | aplicação | baixa | perfis do usuário | Sessões |
| autorizacao / login_sem_perfil | aplicação | alta | — | Usuário sem permissão |
| exportacao / exportacao_historico | aplicação (**obrigatória**) | alta | linhas, período, filtros (sem conteúdo) | Saída de dados pessoais |
| importacao / importacao_funcionarios | aplicação | alta | formato e contagens (sem nome de arquivo nem nomes) | Carga em lote |
| operacao / impressao_etiquetas | aplicação | baixa | tipo, layout, quantidade | Rastreabilidade operacional |
| compartilhamento / compartilhamento_whatsapp | aplicação | média | id da ferramenta | Envio de dado pessoal a terceiro (Meta) pelo aparelho do usuário |
| auditoria / consulta_auditoria, exportacao_auditoria, verificacao_integridade, migracao_* | banco | média a crítica | filtros, linhas, finalidade, resultado e último hash | Auditar a própria auditoria |
| seguranca / limite_excedido; aplicacao / evento_invalido | aplicação | alta/média | ação recebida (sanitizada) ou tamanho do contexto | Abuso da interface de eventos |
| auditoria / confirmacao_ancora | banco | baixa; crítica se divergente | — | Detecção de reescrita ou corte da cadeia |

Valores **nunca** registrados pelos gatilhos e funções: senhas, tokens, JWT, cabeçalhos de autenticação, imagem da assinatura, valores de nome, telefone, função, setor e observações, nome do arquivo importado. Caracteres invisíveis e bidirecionais (ex.: U+202E) são removidos (R17). As chaves `senha|password|token|secret|segredo|authorization|apikey|api_key|jwt|cookie` são descartadas do contexto, e caracteres de controle (`\r`, `\n`…) são neutralizados.

## 8. Matriz de permissões (aplicada no servidor)

| Ação | almoxarife | gestor | auditor | sem perfil |
|---|---|---|---|---|
| Ler ferramentas, funcionários, fornecedores, histórico | ✔ | ✔ | ✔ | ✘ |
| Incluir e alterar cadastros | ✔ | ✔ | ✘ | ✘ |
| Excluir cadastros (funcionário com ferramenta: bloqueado) | ✘ | ✔ | ✘ | ✘ |
| Retirada, devolução, manutenção | ✔ | ✔ | ✘ | ✘ |
| Enviar assinatura (storage) | ✔ | ✔ | ✘ | ✘ |
| Ler o caminho do arquivo de assinatura | ✘ | ✘ | ✘ | ✘ (só por função) |
| Ver assinatura (pela interface: auditado; ver R11) | ✘ | ✔ | ✔ | ✘ |
| Importar funcionários / imprimir etiquetas | ✔ | ✔ | ✘ | ✘ |
| Exportar histórico pela interface (auditado; ver R12) | ✔ | ✔ | ✔ | ✘ |
| Consultar, exportar e verificar auditoria | ✘ | ✘ | ✔ | ✘ |
| Alterar ou apagar eventos de auditoria ou movimentações | ✘ | ✘ | ✘ | ✘ (nem o admin, sem desligar gatilhos) |
| Conceder perfis | somente pelo SQL Editor (administrador do projeto); toda concessão gera evento crítico | | | |

Segregação: o gestor opera e exclui, mas **não** exporta nem consulta a auditoria. O auditor consulta, mas **não** opera. Recomenda-se que gestor e auditor sejam pessoas diferentes.

## 9. Minimização, retenção e descarte

**Situação atual: nenhum dado é descartado automaticamente.** Os prazos abaixo são **hipóteses para decisão**, não regras implementadas.

| Classe | Prazo proposto (hipótese) | Fundamento a validar | Descarte |
|---|---|---|---|
| `audit.eventos` | 5 anos | Prescrição trabalhista (CF art. 7º, XXIX) e investigação de incidentes | Fase B: rotina com bloqueio por investigação e evento de descarte |
| `movimentacoes` (registro de entrega/posse; NR-6 para EPI) | Vínculo do empregado + 5 anos | NR-6 não fixa prazo; avaliar prescrição | Fase B |
| Imagens de assinatura | Igual à movimentação que comprovam | Idem; natureza do dado (R3) | Fase B (storage + referência) |
| Cadastro de funcionários | Enquanto ativo; inativo, enquanto houver movimentação retida | Necessidade | Fase B |
| Registro de incidentes | **Mínimo 5 anos** | Res. CD/ANPD 15/2024 (**obrigação**) | Fase B |
| Logs do Supabase Auth | Política do fornecedor | Verificar com o Supabase | Fornecedor |
| Arquivos exportados | Até cumprir a finalidade informada | Política interna | Manual (fora do sistema) |

**LACUNA DE REQUISITO IDENTIFICADA:** os prazos acima precisam de aprovação do jurídico/RH. Impacto: sem decisão, a retenção é indefinida (R2). Próxima ação: decisão formal e, depois, implementação na Fase B.

## 10. Implementações e arquivos modificados

| Arquivo | Mudança | Requisito |
|---|---|---|
| `supabase/migrations/002_auditoria_fase_a.sql` | Schema `audit`, eventos com hash, perfis, RLS por perfil, funções oficiais, gatilhos, consulta, exportação e verificação | RF-01 a RF-05, RF-07 |
| `supabase/migrations/002_auditoria_fase_a_reverter.sql` | Reversão que preserva as evidências | Plano de reversão |
| `supabase/tests/*` | Simulação do Supabase e 77 testes | CA-10 |
| `public/js/core.js` | Perfis, cabeçalho de correlação, `rpcOk`, eventos obrigatórios e silenciosos, visualização de assinatura auditada, falha fechada | RF-01, RF-02, RF-07 |
| `public/js/painel.js` | Interface por perfil, aba Auditoria, exportação e importação auditadas, novas bibliotecas de planilha, CSV com limites | RF-02, RF-05, RF-07 |
| `public/js/app.js` | Perfil somente-consulta, WhatsApp auditado | RF-02 |
| `public/index.html`, `css/style.css` | Aba Auditoria, regras visuais por perfil | — |
| `public/vendor/` | Remove `xlsx.full.min.js`; adiciona `read-excel-file.min.js` e `write-excel-file.min.js` | Vulnerabilidade |
| `build.js` | Modo `erro` no Render sem configuração | Falha fechada |
| `tests/navegador.test.js`, `tests/fixtures/` | 25 testes de navegador | CA-10, CA-11 |

## 11–12. Testes e evidências

- `npm run test:sql`: 77 testes, resultado em `docs/evidencias/testes_sql_fase_a.txt`.
- `node tests/navegador.test.js` (com `public/` servido na porta 8765): 25 testes, resultado em `docs/evidencias/testes_navegador.txt`, mais as capturas `n*.png` e os arquivos `.xlsx` gerados.
- Revisão independente: `docs/evidencias/revisao_independente.md`.

Testes **não executados:** contra o Supabase real; carga e concorrência alta; restauração de backup; realtime com RLS; câmera física; impressora térmica física.

## 13. Matriz de rastreabilidade

| Requisito | Controle | Implementação | Testes |
|---|---|---|---|
| RF-01 | Ponto único de gravação | `audit.registrar` | T03, T08–T11, T20 |
| RF-02 | Catálogo de eventos | gatilhos, funções oficiais, `auditar_evento` | T07, T12, T16, T21–T23, T32, T35, T38, N02, N20 |
| RF-03 | De/para controlado | `audit._tg_tabela` | T16–T19 |
| RF-04 | Somente-inclusão, hash encadeado, âncora externa, RLS | gatilhos `trg_aud_*`, `verificar_integridade_auditoria`, `confirmar_ancora_auditoria` | T24–T27, T42–T45, R18–R21 |
| RF-05 | Sanitização, limites de tamanho, lista de chaves proibidas | `audit._ctx`, `audit._texto` | T11, T17, T20, T40, R09, R10, R12, R17 |
| RF-06 | Retenção | **não implementado (Fase B)** | — |
| RF-07 | Consulta e exportação restritas e auditadas | `consultar_auditoria`, `exportar_auditoria` | T29–T36, N05–N09 |
| RF-08 | Alertas | parcial: verificação manual de integridade (crítico se falhar) | T44, N08 |
| L1 | Histórico protegido; assinatura de uso único (inclusive por conteúdo), do próprio usuário e recente | `tg_mov_protege`, revoke, `_assinatura_valida`, `uq_mov_assinatura` | T00, T04, T08, T27, R01–R06, R13, R26 |
| Anti-abuso | Limite de taxa central sem perder tentativas críticas; limites de tamanho | `audit.registrar`, `ck_tam_*` | T23, R07–R10, R23–R25 |
| L3 | Perfis | `perfis`, `tem_papel`, políticas | T12–T15, T36–T39, N04, N10 |
| L4 | Biblioteca segura | `vendor/read-excel-file`, `write-excel-file` | N15–N19 |
| L8 | Falha fechada | `build.js` (MODO), `auditarObrigatorio` | N01, N12 |
| Regressão | Fluxos existentes | — | T46–T48, N13–N23 |
| Reversão | Script de reversão (reexecutável) e migração reexecutável sem reconceder perfis | `*_reverter.sql`, carga condicional | T49, T50, R11, R22 |

## 14. Pendências, riscos residuais e decisões necessárias

1. **LACUNA DE REQUISITO IDENTIFICADA — controlador e encarregado.** Sem eles não há como formalizar o inventário nem o canal do titular. Responsável: direção.
2. **LACUNA DE REQUISITO IDENTIFICADA — região e plano do Supabase.** Definem se há transferência internacional (Res. 19/2024) e se há backup. Responsável: TI.
3. **LACUNA DE REQUISITO IDENTIFICADA — base legal e natureza da assinatura** (R3). Responsável: jurídico/DPO.
4. **LACUNA DE REQUISITO IDENTIFICADA — prazos de retenção** (§9). Responsável: jurídico/RH.
5. Quem será gestor e quem será auditor (de preferência pessoas diferentes).
6. Fase B: retenção e descarte, alertas automáticos, âncora externa do hash, registro de incidentes com prazo de 3 dias úteis, CSP, direitos do titular.
7. Riscos residuais R1, R5–R15 (§5).

## 15. Implantação, monitoramento e reversão

1. **Backup:** no Supabase, *Database → Backups* (conforme o plano). Se não houver, exporte as tabelas em *Table Editor → Export*.
2. **Aplicar a migração:** abra o *SQL Editor*, cole `supabase/migrations/002_auditoria_fase_a.sql` e clique em *Run*. Todos os usuários existentes viram "almoxarife".
3. **Conceder gestor e auditor:**
   ```sql
   insert into public.perfis (user_id, papel, concedido_por)
   select id, 'gestor', 'Nome de quem autorizou' from auth.users where email = 'gestor@empresa.com.br';
   insert into public.perfis (user_id, papel, concedido_por)
   select id, 'auditor', 'Nome de quem autorizou' from auth.users where email = 'auditor@empresa.com.br';
   ```
   Usuários **criados depois** precisam receber um perfil da mesma forma (`'almoxarife'`). Sem perfil, eles veem a tela "Usuário sem perfil".
4. **Publicar o front-end** logo em seguida, enviando ao GitHub os arquivos alterados (§10). As funções antigas são removidas no passo 2. Um site ou celular com a versão antiga aberta passa a receber **erro** ("função não encontrada") e nunca um falso "registrado". Peça a todos que recarreguem a página ou o app.
5. **Ativar os logs do Auth no banco:** *Authentication → Audit Logs → "Write audit logs to the database"*.
6. **Teste de aceitação no ambiente real** (cobre as suspeitas S1–S3 da revisão):
   - Abrir o painel e o app; se o login falhar com erro de CORS, defina `ENVIAR_CORRELACAO=0` no Render e publique de novo.
   - Retirada com assinatura (almoxarife).
   - Exclusão (gestor).
   - Login do auditor, depois a aba Auditoria, mostrando os eventos dos passos anteriores.
   - "Verificar integridade" retornando ✓.
   - Anotar o último hash fora do sistema.
7. **Monitoramento (até a Fase B):** o auditor roda "Verificar integridade" semanalmente e guarda o hash fora do sistema. Ele também revisa os eventos `negado` e `critica`.
8. **Reversão:** rode `002_auditoria_fase_a_reverter.sql` e publique a versão anterior do front-end. Os eventos são preservados, mas as lacunas L1–L3 voltam. Registre o motivo.

## 16. Resultado da avaliação técnica

**APROVADO COM RESSALVAS** (avaliação técnica; não é certificação jurídica nem autorização institucional)

- Os controles críticos aplicáveis à Fase A foram demonstrados por testes reproduzíveis: 77 no banco e 25 no navegador.
- Revisão independente em duas rodadas: os bloqueadores foram fechados, e as brechas novas foram corrigidas e cobertas por teste (`docs/evidencias/revisao_independente.md`).
- **Condições para uso em produção:**
  1. Teste de aceitação no Supabase real (§15, passo 6), cobrindo upload do almoxarife, dono do arquivo e `metadata` preenchidos, realtime e CORS.
  2. Os responsáveis competentes aceitarem formalmente os riscos residuais R1, R5–R15.
- **Pendências que impedem declarar conformidade com a LGPD** (não são bloqueadores técnicos): §14, itens 1 a 4, e a Fase B (retenção e descarte, registro de incidentes, alertas, CSP).
- RF-06 (retenção), RF-08 (alertas automáticos) e RF-09 a RF-12 (inventário, titulares, incidentes, governança) **não** foram implementados nesta fase.

### Autovalidação (seção 12 do prompt)

| Pergunta | Resposta | Evidência / justificativa |
|---|---|---|
| Analisei o código e a arquitetura reais antes de propor mudanças? | SIM | Diagnóstico com reprodução da falha L1 (T00) |
| Verifiquei os normativos em fontes oficiais e confirmei sua vigência? | PENDENTE | Consultei fontes secundárias e o texto da NR-6. Os portais gov.br/DOU não estavam acessíveis neste ambiente; números de artigo a conferir |
| Diferenciei obrigações legais de recomendações técnicas? | SIM | §3 (coluna "Natureza") e §9 |
| Evitei inventar requisitos, informações, controles ou evidências? | SIM | Controlador, encarregado, prazos e região marcados como lacunas; prazos de retenção apresentados como hipóteses |
| Identifiquei as lacunas que dependem de decisão humana? | SIM | §14 |
| Evitei registrar senhas, tokens e dados pessoais desnecessários? | SIM | T17, T20, T40, R12 |
| Implementei controles de acesso no lado confiável da aplicação? | SIM | RLS e funções no Postgres; T12–T15, T29, T36–T39 |
| Avaliei integridade, retenção, descarte e monitoramento dos logs? | PARCIAL | Integridade implementada; retenção, descarte e alertas na Fase B (R2, R4, R5) |
| Testei as operações críticas e os cenários negativos? | SIM | 102 testes, a maioria negativos |
| Verifiquei regressões e impactos na arquitetura existente? | SIM | T46–T48, N13–N23 |
| Vinculei requisitos, implementação e evidências? | SIM | §13 |
| Registrei os testes não executados e os riscos residuais? | SIM | §11–12 e §5 |
| Evitei afirmar conformidade integral com base apenas em controles técnicos? | SIM | Este capítulo e §17 |
| Identifiquei as aprovações jurídicas, de privacidade, segurança ou governança ainda necessárias? | SIM | §14, itens 1 a 5 |

## 17. Limites desta avaliação

- Os testes rodaram em Postgres real (PGlite) com **simulação** de partes do Supabase, e não no projeto Supabase do cliente.
- Não houve análise jurídica: base legal, prazos e enquadramento da assinatura são pendências.
- Não foi verificado se o código publicado no GitHub/Render é idêntico ao deste pacote.
- Controles organizacionais (políticas, treinamento, contratos) não foram avaliados.
