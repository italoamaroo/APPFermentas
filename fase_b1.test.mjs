// Testes da Fase B.1 — registro de incidentes (Res. CD/ANPD 15/2024)
// Executar: npm run test:incidentes   (gera docs/evidencias/testes_sql_fase_b1.txt)
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const db = new PGlite();
const out = []; let falhas = 0;
const log = (s) => { out.push(s); console.log(s); };
const ok = (id, d, c, det = "") => { if (!c) falhas++; log(`${c ? "PASSOU" : "FALHOU"}  ${id}  ${d}${det ? "  — " + det : ""}`); };
const q = async (sql, p) => (await db.query(sql, p)).rows;
const erro = async (sql, p) => { try { await db.query(sql, p); return null; } catch (e) { return e.message; } };
const script = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };

const U = { almox: "00000000-0000-0000-0000-0000000000a1", almox2: "00000000-0000-0000-0000-0000000000a2",
            gestor: "00000000-0000-0000-0000-0000000000b1", auditor: "00000000-0000-0000-0000-0000000000c1",
            dpo: "00000000-0000-0000-0000-0000000000d1" };
async function como(k) {
  await db.exec("reset role");
  await q("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: U[k], email: k + "@empresa.test" })]);
  await db.exec("set role authenticated");
}
async function admin() { await db.exec("reset role"); await q("select set_config('request.jwt.claims', '', false)"); }
const rpc = async (k, sql, p) => { await como(k); return (await q(sql, p))[0].r; };
const ultimoEv = async () => { await admin(); return (await q("select * from audit.eventos order by id desc limit 1"))[0]; };

log(`# Testes SQL — Fase B.1 (incidentes) — ${new Date().toISOString()}`);
await db.exec(read("supabase/tests/supabase_stub.sql"));
await db.exec(read("supabase/schema.sql"));
await db.exec(read("supabase/seed.sql"));
for (const k of Object.keys(U)) await q("insert into auth.users values ($1,$2)", [U[k], k + "@empresa.test"]);
await db.exec(read("supabase/migrations/002_auditoria_fase_a.sql"));
const mig3 = read("supabase/migrations/003_incidentes.sql");
let e = await script(mig3); let ev;
ok("I01", "Migração 003 aplica sobre a Fase A", e === null, e);
e = await script(mig3);
ok("I02", "Migração 003 é reexecutável", e === null, e);
await q(`insert into perfis (user_id, papel, concedido_por) values ($1,'gestor','t'), ($2,'auditor','t'), ($3,'encarregado','t')`, [U.gestor, U.auditor, U.dpo]);
await q("delete from perfis where user_id in ($1,$2) and papel='almoxarife'", [U.auditor, U.dpo]);
const pf = (await q("select papel from perfis where user_id=$1", [U.dpo]))[0];
ok("I03", "Perfil 'encarregado' aceito e concessão auditada", pf?.papel === "encarregado" && (await q("select count(*)::int n from audit.eventos where recurso='perfis' and contexto->>'papel'='encarregado'"))[0].n === 1);

// ---------------------------------------------------------------- calendário e prazos
const r1 = (await q(`select pascoa(2026)::text p, e_feriado_nacional('2026-04-03') sexta_santa, e_feriado_nacional('2026-11-20') consc,
                     e_feriado_nacional('2026-02-16') carnaval, pascoa(2027)::text p27`))[0];
ok("I04", "Páscoa/Paixão de Cristo calculadas (Portaria MGI 11.460/2025: 03/04/2026); Carnaval não é feriado nacional",
   r1.p === "2026-04-05" && r1.sexta_santa && r1.consc && !r1.carnaval && r1.p27 === "2027-03-28", JSON.stringify(r1));
const p1 = (await q("select prazo_dias_uteis('2026-11-13 10:00-03', 3)::text d"))[0].d;
const p2 = (await q("select prazo_dias_uteis('2026-11-18 10:00-03', 3)::text d"))[0].d;
const p3 = (await q("select prazo_dias_uteis('2026-11-18 23:30-03', 3)::text d"))[0].d;   // 02:30 UTC do dia 19
const p4 = (await q("select prazo_dias_uteis('2026-12-23 09:00-03', 3)::text d"))[0].d;
ok("I05", "3 dias úteis: sexta 13/11 → qua 18/11 (dia da ciência não conta)", p1 === "2026-11-18", p1);
ok("I06", "Feriado de 20/11 (Consciência Negra) pulado: qua 18/11 → ter 24/11", p2 === "2026-11-24", p2);
ok("I07", "Fuso de Recife: ciência às 23h30 locais (dia seguinte em UTC) conta pela data local", p3 === "2026-11-24", p3);
ok("I08", "Natal e fim de semana pulados: qua 23/12 → qui 24 (1), seg 28 (2), ter 29/12 (3)", p4 === "2026-12-29", p4);

// ---------------------------------------------------------------- registro por qualquer perfil
let r = await rpc("almox", "select registrar_incidente('Tablet do almoxarifado perdido', 'Tablet com app aberto sumiu da obra') r");
const inc1 = r.id;
ok("I09", "Almoxarife comunica suspeita de incidente", r.ok === true && r.numero >= 1);
await admin();
const reg = (await q("select * from incidentes where id=$1", [inc1]))[0];
const cab = (await q("select id, hash from audit.eventos where id < (select max(id) from audit.eventos) order by id desc limit 1"))[0];
ok("I10", "Âncora da trilha preservada no registro (evidência)", reg.ancora_evento_id != null && /^[0-9a-f]{64}$/.test(reg.ancora_hash) && reg.status === "suspeita" && reg.criado_por === U.almox);
await como("almox2");
ok("I11", "Outro almoxarife não vê a suspeita alheia", (await q("select count(*)::int n from incidentes"))[0].n === 0);
await como("almox");
ok("I12", "Quem só comunicou NÃO lê o registro (conteúdo da investigação é restrito)", (await q("select count(*)::int n from v_incidentes"))[0].n === 0);
r = await rpc("almox", "select atualizar_incidente($1, '{\"titulo\":\"x mudado\"}') r", [inc1]);
ok("I13", "Almoxarife não altera incidentes; tentativa auditada", r.ok === false && (await ultimoEv()).resultado === "negado");

// ---------------------------------------------------------------- proteção das tabelas
await como("gestor");
const ei = await erro("insert into incidentes (titulo) values ('direto')");
const eu = await erro("update incidentes set titulo='x'");
const ed = await erro("delete from incidentes");
ok("I14", "Sem escrita direta nas tabelas (só funções oficiais)", ei !== null && eu !== null && ed !== null, [ei, eu, ed].map((x) => x && x.slice(0, 35)).join(" | "));
await admin();
const ead = await erro("delete from incidentes where id=$1", [inc1]);
const eat = await erro("truncate incidentes_historico");
ok("I15", "Nem o administrador apaga/trunca registros (guarda de 5 anos)", ead?.includes("5 anos") && eat !== null, ead);

// ---------------------------------------------------------------- atualização (gestor/encarregado)
r = await rpc("gestor", "select atualizar_incidente($1, '{\"senha\":\"x\"}') r", [inc1]);
ok("I16", "Campo fora da lista é recusado", r.ok === false && r.erro.includes("não permitido"));
r = await rpc("gestor", "select atualizar_incidente($1, '{\"status\":\"encerrado\"}') r", [inc1]);
ok("I17", "Encerrar só pela função própria", r.ok === false);
r = await rpc("gestor", "select atualizar_incidente($1, jsonb_build_object('ciencia_em', (now() + interval '2 days')::text)) r", [inc1]);
ok("I18", "Data de ciência no futuro é recusada", r.ok === false);
r = await rpc("gestor", "select atualizar_incidente($1, $2::jsonb) r", [inc1, JSON.stringify({
  status: "em_analise", ciencia_em: new Date(Date.now() + 1000).toISOString(), categorias_dados: ["cadastrais", "assinatura"],
  categorias_titulares: ["empregados"], qtd_titulares: 40, criterios_art5: ["autenticacao"], afeta_significativamente: true,
  descricao: "Tablet com sessão aberta; contém nomes como Maria Souza (mat. 5001)", medidas_contencao: "Bloqueio remoto do tablet e troca de senhas" })]);
ok("I19", "Gestor preenche dados do art. 10 (listas, números, datas)", r.ok === true, JSON.stringify(r));
r = await rpc("gestor", "select atualizar_incidente($1, '{\"criterios_art5\":[\"inexistente\"]}') r", [inc1]);
ok("I20", "Critério do art. 5º fora da lista é recusado", r.ok === false);
r = await rpc("gestor", "select atualizar_incidente($1, '{\"avaliacao_risco\":\"risco_relevante\"}') r", [inc1]);
ok("I21", "Mudar avaliação de risco exige justificativa", r.ok === false && r.erro.includes("justificativa"));
r = await rpc("dpo", "select atualizar_incidente($1, '{\"avaliacao_risco\":\"risco_relevante\",\"justificativa_risco\":\"Credenciais de acesso expostas a terceiros\"}', 'Avaliação do encarregado após análise') r", [inc1]);
ok("I22", "Encarregado conclui avaliação com justificativa", r.ok === true);
await admin();
const h = await q("select * from incidentes_historico where incidente_id=$1 order by id", [inc1]);
ok("I23", "Histórico guarda de/para e autor de cada alteração", h.length >= 3 && h.some((x) => x.alteracoes?.avaliacao_risco?.para === "risco_relevante" && x.ator_id === U.dpo && x.comentario));
const evs = JSON.stringify(await q("select * from audit.eventos where categoria='incidente'"));
ok("I24", "Auditoria do incidente registra só nomes de campos (sem a descrição com dados pessoais)", !evs.includes("Maria Souza") && evs.includes("avaliacao_risco"));

// ---------------------------------------------------------------- visão com prazos e indício do art. 5º
await como("auditor");
let v = (await q("select * from v_incidentes where id=$1", [inc1]))[0];
ok("I25", "Auditor lê o registro com prazos calculados", v && v.prazo_anpd && v.indicio_art5 === true && v.dias_uteis_para_prazo >= 0, `prazo ${v?.prazo_anpd} / restam ${v?.dias_uteis_para_prazo}`);
r = await rpc("auditor", "select atualizar_incidente($1, '{\"titulo\":\"auditor altera\"}') r", [inc1]);
ok("I26", "Auditor não altera (somente leitura)", r.ok === false);
r = await rpc("gestor", "select definir_pequeno_porte(true, 'teste de permissão') r");
ok("I27", "Só o encarregado enquadra como pequeno porte (gestor negado, evento crítico)", r.ok === false && (await ultimoEv()).criticidade === "critica");
r = await rpc("dpo", "select definir_pequeno_porte(true, 'Enquadramento conforme Res. CD/ANPD 2/2022 art. 2º') r");
const rPP = await rpc("gestor", "select registrar_incidente('Incidente sob pequeno porte', 'teste') r");
await rpc("gestor", "select atualizar_incidente($1, jsonb_build_object('ciencia_em', now()::text)) r", [rPP.id]);
await como("auditor");
const v2 = (await q("select prazo_anpd, prazo_dias_uteis(ciencia_em, 6) esperado, agente_pequeno_porte from v_incidentes where id=$1", [rPP.id]))[0];
ok("I28", "Pequeno porte dobra o prazo (3 → 6 dias úteis) de incidente com ciência registrada após o enquadramento", r.ok && v2.agente_pequeno_porte === true && String(v2.prazo_anpd) === String(v2.esperado));
await rpc("dpo", "select definir_pequeno_porte(false, 'Volta ao regime geral após análise jurídica') r");

// ---------------------------------------------------------------- comunicações e encerramento
r = await rpc("gestor", "select encerrar_incidente($1, 'tentativa de encerrar sem comunicar') r", [inc1]);
ok("I29", "Risco relevante não encerra sem comunicação à ANPD e aos titulares", r.ok === false && r.erro.includes("ANPD"));
r = await rpc("dpo", "select registrar_comunicacao_incidente($1, 'anpd', now() + interval '1 day', 'Peticionamento ANPD', 'resumo enviado') r", [inc1]);
ok("I30", "Comunicação com data futura é recusada", r.ok === false);
r = await rpc("dpo", "select registrar_comunicacao_incidente($1, 'anpd', now(), 'Peticionamento eletrônico ANPD', 'Comunicação com os itens do art. 6º §2º', 'PROT-123') r", [inc1]);
ev = await ultimoEv();
ok("I31", "Comunicação à ANPD registrada e auditada com indicação de prazo", r.ok && ev.acao === "comunicacao_incidente" && ev.contexto.dentro_do_prazo === true);
await como("auditor");
v = (await q("select * from v_incidentes where id=$1", [inc1]))[0];
ok("I32", "Prazo de complementação (20 dias úteis da comunicação) calculado; ainda conta prazo dos titulares", v.prazo_complementacao && v.comunicado_anpd_em && v.dias_uteis_para_prazo !== null);
await rpc("dpo", "select registrar_comunicacao_incidente($1, 'titulares', now(), 'E-mail individual', 'Aviso aos 40 empregados com itens do art. 9º') r", [inc1]);
await como("auditor");
v = (await q("select * from v_incidentes where id=$1", [inc1]))[0];
ok("I33", "Com ANPD e titulares comunicados, não há mais contagem regressiva", v.dias_uteis_para_prazo === null);
r = await rpc("gestor", "select encerrar_incidente($1, 'curto') r", [inc1]);
ok("I34", "Encerramento exige motivo", r.ok === false);
r = await rpc("gestor", "select encerrar_incidente($1, 'Senhas trocadas, tablet bloqueado remotamente, comunicações feitas') r", [inc1]);
ok("I35", "Encerramento com requisitos cumpridos", r.ok === true);
r = await rpc("gestor", "select atualizar_incidente($1, '{\"titulo\":\"alterar encerrado\"}') r", [inc1]);
ok("I36", "Incidente encerrado não é alterado (só reabrindo)", r.ok === false);
r = await rpc("dpo", "select reabrir_incidente($1, 'Novo fato: tablet encontrado com dados copiados') r", [inc1]);
await admin();
ok("I37", "Reabertura com motivo fica no histórico", r.ok && (await q("select count(*)::int n from incidentes_historico where incidente_id=$1 and acao='reabertura'", [inc1]))[0].n === 1);

r = await rpc("gestor", "select registrar_incidente('Falso alarme de acesso', 'Alerta do navegador') r");
const inc2 = r.id;
await rpc("gestor", "select atualizar_incidente($1, '{\"avaliacao_risco\":\"sem_risco_relevante\"}', 'Sem dados pessoais envolvidos após análise') r", [inc2]);
r = await rpc("gestor", "select encerrar_incidente($1, 'Encerrado: sem dados pessoais afetados') r", [inc2]);
ok("I38", "Sem risco relevante exige justificativa registrada (art. 10, VIII)", r.ok === false && r.erro.includes("justificativa"));
await rpc("gestor", "select atualizar_incidente($1, '{\"justificativa_risco\":\"Nenhum dado pessoal foi acessado; logs revisados\"}') r", [inc2]);
r = await rpc("gestor", "select encerrar_incidente($1, 'Encerrado: sem dados pessoais afetados') r", [inc2]);
ok("Y01", "Mesmo sem risco relevante, o encerramento exige o conteúdo mínimo do art. 10 (II, III, IV)", r.ok === false && r.erro.includes("art. 10"));
await rpc("gestor", "select atualizar_incidente($1, '{\"descricao\":\"Alerta falso do navegador, sem acesso a dados\",\"categorias_dados\":[\"nenhum\"],\"qtd_titulares\":0}') r", [inc2]);
r = await rpc("gestor", "select encerrar_incidente($1, 'Encerrado: sem dados pessoais afetados') r", [inc2]);
ok("I39", "Sem risco relevante, com justificativa, encerra sem comunicação obrigatória", r.ok === true);

// ---------------------------------------------------------------- incidente automático
await admin();
await db.exec("alter table audit.eventos disable trigger trg_aud_bloq_linha");
const alvo = (await q("select id from audit.eventos order by id limit 1 offset 3"))[0].id;
await q("update audit.eventos set motivo='adulterado' where id=$1", [alvo]);
await db.exec("alter table audit.eventos enable trigger trg_aud_bloq_linha");
r = await rpc("auditor", "select verificar_integridade_auditoria() r");
await admin();
let auto = await q("select * from incidentes where origem='verificacao_integridade'");
ok("I40", "Falha de integridade abre incidente automaticamente", r.ok === false && auto.length === 1 && auto[0].descricao.includes(`#${alvo}`));
await rpc("auditor", "select verificar_integridade_auditoria() r");
await admin();
auto = await q("select * from incidentes where origem='verificacao_integridade'");
ok("I41", "Não duplica incidente automático enquanto o anterior estiver aberto", auto.length === 1);
r = await rpc("auditor", "select confirmar_ancora_auditoria(999999, repeat('a',64)) r");
await admin();
ok("I42", "Âncora que não confere abre incidente automaticamente", r.ok === false && r.incidente_aberto === true && (await q("select count(*)::int n from incidentes where origem='confirmacao_ancora'"))[0].n === 1);

// ---------------------------------------------------------------- achados da revisão independente (B.1)
await admin(); await db.exec("set role anon");
let ea = await erro("select prazo_dias_uteis(now(), 3)");
await db.exec("reset role");
ok("X01", "Funções de calendário não executam sem login (anon)", ea !== null && /permission/i.test(ea), ea);
await como("gestor");
ea = await erro("select prazo_dias_uteis(now(), 200000)");
const big = (await q("select dias_uteis_restantes('3000-01-01') a, dias_uteis_restantes('1000-01-01') b"))[0];
ok("X02", "Limites contra abuso de CPU (p_dias ≤ 60; distância > 400 dias limitada)", ea !== null && big.a === 999 && big.b === -999);
const venc = (await q(`select dias_uteis_restantes('2026-10-30','2026-10-30') d0, dias_uteis_restantes('2026-10-30','2026-10-31') sab,
  dias_uteis_restantes('2026-10-30','2026-11-01') dom, dias_uteis_restantes('2026-10-30','2026-11-02') fer, dias_uteis_restantes('2026-10-30','2026-11-03') ter`))[0];
ok("X03", "Prazo vencido em fim de semana/feriado NUNCA aparece como 0 ('vence hoje')", venc.d0 === 0 && venc.sab === -1 && venc.dom === -1 && venc.fer === -1 && venc.ter === -1, JSON.stringify(venc));
r = await rpc("gestor", "select registrar_incidente('Incidente para regime', 'teste de regime') r");
const incR = r.id;
await rpc("gestor", "select atualizar_incidente($1, jsonb_build_object('ciencia_em', now()::text)) r", [incR]);
await como("gestor"); const antesPP = (await q("select prazo_anpd from v_incidentes where id=$1", [incR]))[0].prazo_anpd;
await rpc("dpo", "select definir_pequeno_porte(true, 'Enquadramento conforme parecer jurídico nº 1') r");
await como("gestor"); const depoisPP = (await q("select prazo_anpd from v_incidentes where id=$1", [incR]))[0].prazo_anpd;
await rpc("dpo", "select definir_pequeno_porte(false, 'Retorno ao regime geral (teste)') r");
ok("X04", "Mudar o enquadramento não altera prazo de incidente com ciência já registrada", String(antesPP) === String(depoisPP));
r = await rpc("gestor", "select registrar_comunicacao_incidente($1, 'anpd', '2020-01-01', 'Peticionamento', 'comunicação retroativa') r", [incR]);
ok("X05", "Comunicação anterior à detecção é recusada", r.ok === false && r.erro.includes("anterior"));
r = await rpc("gestor", "select registrar_incidente('Incidente datas', 'x', now() - interval '10 days') r"); const incD = r.id;
r = await rpc("gestor", "select atualizar_incidente($1, jsonb_build_object('ciencia_em', (now() - interval '20 days')::text)) r", [incD]);
ok("X06", "Ciência anterior à detecção é recusada", r.ok === false && r.erro.includes("anterior"));
r = await rpc("gestor", "select atualizar_incidente($1, jsonb_build_object('ciencia_em', now()::text)) r", [incD]);
ok("X07", "Ciência > 2 dias após a detecção exige justificativa (adia o prazo legal)", r.ok === false && r.erro.includes("justifique"));
r = await rpc("gestor", "select atualizar_incidente($1, jsonb_build_object('ciencia_em', now()::text), 'Só soubemos hoje que havia dados pessoais na planilha') r", [incD]);
ev = await ultimoEv();
ok("X08", "Com justificativa, aceita e a auditoria sinaliza 'ciencia_tardia'", r.ok === true && ev.contexto.ciencia_tardia === true);
r = await rpc("gestor", "select registrar_incidente('Encerramento incompleto', 'Descrição suficiente do caso') r"); const incE = r.id;
await rpc("dpo", "select atualizar_incidente($1, '{\"avaliacao_risco\":\"risco_relevante\",\"justificativa_risco\":\"Credenciais expostas a terceiros\"}', 'Avaliação concluída pelo encarregado') r", [incE]);
await rpc("dpo", "select atualizar_incidente($1, jsonb_build_object('ciencia_em', now()::text)) r", [incE]);
await rpc("dpo", "select registrar_comunicacao_incidente($1, 'anpd', now(), 'Peticionamento', 'Comunicado com os itens') r", [incE]);
await rpc("dpo", "select registrar_comunicacao_incidente($1, 'titulares', now(), 'E-mail', 'Aviso aos titulares') r", [incE]);
r = await rpc("dpo", "select encerrar_incidente($1, 'Tentativa sem conteúdo mínimo') r", [incE]);
ok("X09", "Risco relevante não encerra sem o conteúdo mínimo do art. 10 (III, IV, VI)", r.ok === false && r.erro.includes("art. 10"));
let lim = [];
for (let i = 0; i < 6; i++) lim.push((await rpc("almox2", "select registrar_incidente($1) r", ["Suspeita repetida " + i])).ok);
ok("X10", "Limite de 5 comunicações/hora por almoxarife (registro permanente não é inundado)", lim.slice(0, 5).every(Boolean) && lim[5] === false);
r = await rpc("gestor", "select registrar_incidente($1) r", ["​‮​"]);
ok("X11", "Título só com caracteres invisíveis devolve erro amigável (não erro 500)", r.ok === false);
r = await rpc("gestor", "select atualizar_incidente($1, $2::jsonb) r", [incE, JSON.stringify({ sistemas_afetados: Array.from({ length: 31 }, (_, k) => "s" + k) })]);
ok("X12", "Listas acima do limite (31 sistemas) são recusadas", r.ok === false);
r = await rpc("gestor", "select atualizar_incidente($1, $2::jsonb) r", [incE, JSON.stringify({ titulo: "Novo\r\ntítulo‮" })]);
await admin(); const tt = (await q("select titulo from incidentes where id=$1", [incE]))[0].titulo;
ok("X13", "Título na atualização é sanitizado (sem quebra de linha nem U+202E)", r.ok && !/[\r\n‮]/.test(tt), JSON.stringify(tt));
r = await rpc("auditor", "select verificar_integridade_auditoria() r");
await admin();
const hAuto = (await q("select count(*)::int n from incidentes_historico h join incidentes i on i.id=h.incidente_id where i.origem='verificacao_integridade' and h.acao='nova_ocorrencia'"))[0].n;
ok("X14", "Nova falha de integridade com incidente aberto entra no histórico (nova_ocorrencia)", hAuto >= 1);
const incAuto = (await q("select id from incidentes where origem='verificacao_integridade'"))[0].id;
r = await rpc("gestor", "select atualizar_incidente($1, '{\"avaliacao_risco\":\"sem_risco_relevante\",\"justificativa_risco\":\"Teste de separação de funções\"}', 'Avaliação do gestor (teste)') r", [incAuto]);
const r15 = await rpc("gestor", "select encerrar_incidente($1, 'Gestor tentando encerrar incidente da trilha') r", [incAuto]);
ok("X15", "Incidente automático da trilha: só o encarregado altera e encerra (gestor recusado nos dois)", r.ok === false && r.erro.includes("encarregado") && r15.ok === false);
const f2024 = (await q("select e_feriado_nacional('2023-11-20') a, e_feriado_nacional('2024-11-20') b"))[0];
ok("X16", "20/11 é feriado nacional só a partir de 2024 (Lei 14.759/2023)", f2024.a === false && f2024.b === true);

// ---------------------------------------------------------------- resíduos da re-verificação (Y)
r = await rpc("gestor", "select atualizar_incidente($1, '{\"ciencia_em\":null}', 'Tentando apagar a ciência para recalcular') r", [incR]);
ok("Y02", "Ciência já registrada não pode ser apagada (impede recalcular o regime)", r.ok === false && r.erro.includes("não pode ser apagada"));
await rpc("dpo", "select definir_pequeno_porte(true, 'Teste de congelamento do regime') r");
await rpc("gestor", "select atualizar_incidente($1, jsonb_build_object('ciencia_em', (now() + interval '2 seconds')::text), 'Correção de horário da ciência (teste)') r", [incR]);
await como("gestor"); const reg2 = (await q("select agente_pequeno_porte from v_incidentes where id=$1", [incR]))[0];
await rpc("dpo", "select definir_pequeno_porte(false, 'Retorno ao regime geral (teste)') r");
ok("Y03", "Corrigir a ciência não recalcula o regime gravado na primeira ciência", reg2.agente_pequeno_porte === false);
r = await rpc("gestor", "select atualizar_incidente($1, $2::jsonb) r", [incR, JSON.stringify({ criterios_art5: Array(7).fill("sensiveis") })]);
ok("Y04", "Critérios do art. 5º limitados a 6 itens (sem repetição em massa)", r.ok === false);
r = await rpc("gestor", "select registrar_incidente('Detecção muito antiga', 'x', now() - interval '400 days') r");
ok("Y05", "Detecção com mais de 1 ano é recusada no registro comum", r.ok === false);
r = await rpc("gestor", "select registrar_incidente('Detecção de semana passada', 'x', now() - interval '8 days') r");
ev = await ultimoEv();
ok("Y06", "Detecção retroativa fica sinalizada na auditoria (dias)", r.ok && ev.contexto.deteccao_retroativa_dias >= 7);

// ---------------------------------------------------------------- regressão e reversão
await como("almox");
ok("I43", "Fluxos da Fase A continuam (almoxarife lê ferramentas)", (await q("select count(*)::int n from ferramentas"))[0].n > 0);
await admin();
const nInc = (await q("select count(*)::int n from incidentes"))[0].n;
e = await script(read("supabase/migrations/003_incidentes_reverter.sql"));
const nInc2 = (await q("select count(*)::int n from incidentes"))[0].n;
const semFunc = (await q("select count(*)::int n from pg_proc where proname='registrar_incidente'"))[0].n === 0;
ok("I44", "Reversão preserva os registros de incidente e remove as funções", e === null && nInc === nInc2 && semFunc, e);
e = await script(mig3);
ok("I45", "Migração 003 reaplicável após reversão", e === null, e);
e = await script(read("supabase/migrations/003_incidentes_reverter.sql"));
const e2 = await script(read("supabase/migrations/002_auditoria_fase_a_reverter.sql"));
const preserv = (await q("select count(*)::int n from incidentes"))[0].n;
ok("X17", "Reverter 003 e depois a Fase A funciona e preserva os registros de incidente", e === null && e2 === null && preserv === nInc2, e || e2);

log(`\nRESULTADO: ${falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " FALHA(S)"}`);
fs.mkdirSync(path.join(ROOT, "docs", "evidencias"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "evidencias", "testes_sql_fase_b1.txt"), out.join("\n") + "\n");
process.exit(falhas ? 1 : 0);
