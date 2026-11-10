# Teste de aceitação em produção — 03/11/2026

Ambiente: Supabase `guzuafcyiddakaxhttmk` + Render `appfermentas.onrender.com` (commit `2d59873` + arquivo vazio no lugar de `vendor/xlsx.full.min.js`).
Execução: usuários reais da organização. Evidências: prints enviados na conversa de implantação.

| # | Teste | Resultado | Evidência observada |
|---|---|---|---|
| 0 | Migração 002 aplicada | OK | `audit.registrar` retornou 5 (4 perfis iniciais + evento da migração) |
| 0b | Configuração publicada | OK | `config.js`: MODO=producao, URL sem `/rest/v1`, chave com role anon |
| 0c | Biblioteca vulnerável fora do ar | OK | `vendor/xlsx.full.min.js` serve apenas o comentário de remoção (o Render mantinha o arquivo apagado; foi sobrescrito) |
| 1 | Retirada com assinatura (almoxarife, celular) | OK | Evento #10 `retirada` sucesso; assinatura com etag e tamanho (15 848 bytes) preenchidos; `correlacao_id` registrado (sem erro de CORS) |
| 2 | Almoxarife sem Excluir e sem aba Auditoria | OK | Usuário só com perfil almoxarife: botões Retirar/QR/Etiqueta/Editar/Manutenção; sem Excluir; sem aba Auditoria |
| 3 | Gestor vê assinatura | OK | Assinatura da devolução de 03/11 11:38 exibida |
| 4 | Auditor consulta a aba Auditoria | OK | Filtros e detalhes do evento funcionando |
| 5 | Verificar integridade | OK | "Cadeia íntegra — 15 eventos verificados" |
| 6 | Âncora externa | OK | Evento #15 `d00da7d2…6e46c9a` conferido ("Âncora confirmada") |

Suspeitas S2, S3 e S5 da revisão independente (CORS, upload do almoxarife, metadados/dono no storage real): **resolvidas pelo teste em produção**.
Observação: no momento do teste, o usuário administrador acumulava os perfis almoxarife, gestor e auditor (recomendado separar).
