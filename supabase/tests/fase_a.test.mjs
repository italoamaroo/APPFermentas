// Testes da Fase A (auditoria, perfis, integridade) — Postgres real em memória (PGlite)
// Executar:  npm run test:sql      (gera docs/evidencias/testes_sql_fase_a.txt)
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const db = new PGlite();
const out = [];
let falhas = 0;
const log = (s) => { out.push(s); console.log(s); };
function ok(id, desc, cond, detalhe = "") {
  if (!cond) falhas++;
  log(`${cond ? "PASSOU" : "FALHOU"}  ${id}  ${desc}${detalhe ? "  — " + detalhe : ""}`);
}
async function q(sql, params) { return (await db.query(sql, params)).rows; }
async function erro(sql, params) { try { await db.query(sql, params); return null; } catch (e) { return e.message; } }
async function script(sql) { try { await db.exec(sql); return null; } catch (e) { return e.message; } }

const U = {
  almox:   "00000000-0000-0000-0000-00000000000a",
  gestor:  "00000000-0000-0000-0000-00000000000b",
  auditor: "00000000-0000-0000-0000-00000000000c",
  sem:     "00000000-0000-0000-0000-00000000000d",
  taxa:    "00000000-0000-0000-0000-00000000000e",
};
const EMAIL = { almox: "almox@empresa.test", gestor: "gestor@empresa.test", auditor: "auditor@empresa.test", sem: "semperfil@empresa.test", taxa: "taxa@empresa.test" };
async function como(quem, headers = {}) {
  await db.exec("reset role");
  await q("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: U[quem], email: EMAIL[quem], role: "authenticated" })]);
  await q("select set_config('request.headers', $1, false)", [JSON.stringify(headers)]);
  await db.exec("set role authenticated");
}
async function admin() {
  await db.exec("reset role");
  await q("select set_config('request.jwt.claims', '', false)");
  await q("select set_config('request.headers', '', false)");
}
const ultimo = async () => (await admin(), (await q("select * from audit.eventos order by id desc limit 1"))[0]);

// ---------------------------------------------------------------- preparação
log(`# Testes SQL — Fase A — ${new Date().toISOString()}`);
await db.exec(read("supabase/tests/supabase_stub.sql"));
await db.exec(read("supabase/schema.sql"));
await db.exec(read("supabase/seed.sql"));
for (const k of ["almox", "gestor", "auditor", "taxa"]) await q("insert into auth.users values ($1,$2)", [U[k], EMAIL[k]]);

// situação ANTES da migração (reproduz a falha L1 do diagnóstico)
await como("almox");
const antes = await erro(`insert into movimentacoes (ferramenta_codigo, ferramenta_nome, acao, usuario_email, created_at)
                           values ('X','X','devolucao','outro@x','2020-01-01')`);
ok("T00", "Antes da migração: inserção forjada no histórico era possível (reprodução de L1)", antes === null);
await admin(); await db.exec("delete from movimentacoes");

const mig = read("supabase/migrations/002_auditoria_fase_a.sql");
let em = await script(mig);
ok("T01", "Migração 002 aplica sobre o schema existente", em === null, em);
em = await script(mig);
ok("T02", "Migração 002 é reexecutável (idempotente)", em === null, em);
await q("insert into auth.users values ($1,$2)", [U.sem, EMAIL.sem]);   // usuário criado depois: sem perfil
await q("insert into perfis (user_id, papel, concedido_por) values ($1,'gestor','teste'), ($2,'auditor','teste')", [U.gestor, U.auditor]);
await q("delete from perfis where user_id = $1 and papel = 'almoxarife'", [U.auditor]);
const pf = await q("select * from audit.eventos where recurso = 'perfis' and acao = 'insert' order by id desc limit 1");
ok("T03", "Concessão de perfil gera evento de criticidade 'critica'", pf[0]?.criticidade === "critica" && pf[0]?.contexto?.papel === "auditor");

const fer = Object.fromEntries((await q("select codigo, id from ferramentas")).map((r) => [r.codigo, r.id]));
const fun = Object.fromEntries((await q("select matricula, id from funcionarios")).map((r) => [r.matricula, r.id]));
let nAss = 0;
async function assinar(quem) {
  const nome = `2026/11/${String(++nAss).padStart(8, "0")}-1b4e-4ab0-883f-0016d3cca427.png`;
  await como(quem);
  // cada assinatura real tem conteúdo diferente => eTag (MD5) diferente
  await q("insert into storage.objects (bucket_id, name, metadata) values ('assinaturas', $1, jsonb_build_object('size', 1800 + $2::int, 'eTag', md5($1)))", [nome, nAss]);
  return nome;
}
const assin = await assinar("almox");

// ---------------------------------------------------------------- L1: histórico
await como("almox");
let e = await erro(`insert into movimentacoes (ferramenta_codigo, ferramenta_nome, acao, usuario_email, created_at)
                    values ('X','X','devolucao','outro@x','2020-01-01')`);
ok("T04", "Inserção direta/forjada em movimentações é bloqueada", e !== null, e);
e = await erro(`update ferramentas set status='em_uso', retirada_em=now() where codigo='FRT-003'`);
ok("T05", "Alterar status/posse da ferramenta fora das funções oficiais é bloqueado", e !== null, e);
await q(`insert into ferramentas (codigo, nome, status, retirada_em) values ('FRT-900','Teste','em_uso', now())`);
const f900 = (await q("select status, retirada_em from ferramentas where codigo='FRT-900'"))[0];
ok("T06", "Cadastro não consegue nascer 'em uso' (status forçado para disponível)", f900.status === "disponivel" && f900.retirada_em === null);

let r = (await q("select retirar_ferramenta_v2($1,$2) r", [fer["FRT-002"], fun["3021"]]))[0].r;
let ev = await ultimo();
ok("T07", "Retirada sem assinatura é recusada no servidor e registrada como falha", r.ok === false && ev.acao === "retirada" && ev.resultado === "falha" && ev.motivo === "assinatura_ausente");

await como("almox", { "x-correlacao": "corr-teste-0001" });
r = (await q("select retirar_ferramenta_v2($1,$2,null,$3,'obs') r", [fer["FRT-002"], fun["3021"], assin]))[0].r;
await admin();
const mov = (await q("select * from movimentacoes where id = $1", [r.movimentacao_id]))[0];
ev = (await q("select * from audit.eventos where recurso='movimentacoes' and recurso_id=$1", [r.movimentacao_id]))[0];
ok("T08", "Retirada válida: autor e e-mail vêm do token, data do servidor", r.ok && mov.usuario_id === U.almox && mov.usuario_email === EMAIL.almox && Math.abs(new Date(mov.created_at) - Date.now()) < 60000);
const movHash = (await q("select encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex') h from movimentacoes m where id=$1", [mov.id]))[0].h;
ok("T09", "Evento da retirada contém hash da movimentação (vínculo de integridade)", ev && ev.contexto.mov_hash === movHash);
ok("T10", "Identificador de correlação válido é registrado", ev.correlacao_id === "corr-teste-0001");
await como("almox", { "x-correlacao": "abc\ninjetado" });
await q("select auditar_evento('impressao_etiquetas', null, '{\"quantidade\":2}')");
ev = await ultimo();
ok("T11", "Correlação com caractere de controle é descartada", ev.acao === "impressao_etiquetas" && ev.correlacao_id === null);

// ---------------------------------------------------------------- L3: perfis
await como("sem");
r = (await q("select retirar_ferramenta_v2($1,$2,null,$3) r", [fer["FRT-003"], fun["3021"], assin]))[0].r;
ev = await ultimo();
ok("T12", "Usuário sem perfil: retirada negada no servidor e tentativa auditada", r.ok === false && ev.resultado === "negado" && ev.ator_id === U.sem);
await como("sem");
ok("T13", "Usuário sem perfil não lê ferramentas nem funcionários (RLS)", (await q("select count(*)::int n from ferramentas"))[0].n === 0 && (await q("select count(*)::int n from funcionarios"))[0].n === 0);
e = await erro("insert into perfis (user_id, papel) values ($1, 'auditor')", [U.sem]);
ok("T14", "Usuário não consegue se autoconceder perfil (escalada de privilégio)", e !== null, e);

await como("almox");
let del = await q("delete from funcionarios where matricula='0876' returning id");
ok("T15", "Almoxarife não exclui funcionário (somente gestor)", del.length === 0);
await como("gestor");
del = await q("delete from funcionarios where matricula='0876' returning id");
ev = await ultimo();
ok("T16", "Gestor exclui; evento 'delete' alta com matrícula e sem nome", del.length === 1 && ev.acao === "delete" && ev.criticidade === "alta" && ev.contexto.identificador === "0876" && !JSON.stringify(ev.contexto).includes("Wilson"));

// ---------------------------------------------------------------- RF-05 minimização
await como("almox");
await q("update funcionarios set telefone='81911112222', funcao='Mestre de obras' where matricula='2044'");
ev = await ultimo();
const evTxt = JSON.stringify(ev);
ok("T17", "Alteração de dado pessoal registra só o nome do campo, nunca o valor", ev.contexto.campos_pessoais_alterados?.includes("telefone") && ev.contexto.campos_pessoais_alterados?.includes("funcao") && !evTxt.includes("81911112222") && !evTxt.includes("Mestre"));
await como("almox");
await q("update ferramentas set site='Obra Nova' where codigo='FRT-005'");
ev = await ultimo();
ok("T18", "Alteração de campo não pessoal registra de/para", ev.contexto.alteracoes?.site?.de === "Dois Irmãos" && ev.contexto.alteracoes?.site?.para === "Obra Nova");
await q("update ferramentas set site='Obra Nova' where codigo='FRT-005'");
const n1 = (await (async () => { await admin(); return q("select count(*)::int n from audit.eventos"); })())[0].n;
await como("almox"); await q("update ferramentas set site='Obra Nova' where codigo='FRT-005'");
await admin(); const n2 = (await q("select count(*)::int n from audit.eventos"))[0].n;
ok("T19", "Atualização sem mudança real não gera evento (evita ruído de importações)", n1 === n2);

await como("almox");
await q(`select auditar_evento('importacao_funcionarios', null, $1::jsonb)`, [JSON.stringify({
  total: 10, novos: 2, senha: "123", token: "eyJabc", obs: "linha1\r\nFALSO EVENTO", "Chave Inválida": 1 })]);
ev = await ultimo();
const ctx = JSON.stringify(ev.contexto);
ok("T20", "Contexto: chaves sensíveis/ inválidas removidas e quebras de linha neutralizadas",
   ev.contexto.total === 10 && !("senha" in ev.contexto) && !("token" in ev.contexto) && !ctx.includes("Chave") && !/[\r\n]/.test(ev.contexto.obs));
ok("T21", "Ação fora da lista é recusada e registrada", (await (async () => { await como("almox"); return (await q("select auditar_evento('apagar_tudo') r"))[0].r; })()) === false && (await ultimo()).acao === "evento_invalido");
await como("auditor");
ok("T22", "Evento de aplicação exige o perfil correspondente (auditor não importa funcionários)", (await q("select auditar_evento('importacao_funcionarios') r"))[0].r === false && (await ultimo()).resultado === "negado");

await como("taxa");
let res = [];
for (let i = 0; i < 62; i++) res.push((await q("select auditar_evento('impressao_etiquetas') r"))[0].r);
await admin();
const lim = (await q("select count(*)::int n from audit.eventos where acao='limite_excedido' and ator_id=$1", [U.taxa]))[0].n;
ok("T23", "Limite de taxa: após 60 eventos/min recusa e registra 'limite_excedido' uma única vez", res.slice(0, 60).every(Boolean) && res[60] === false && res[61] === false && lim === 1);

// ---------------------------------------------------------------- RF-04 proteção da tabela de auditoria
await como("auditor");
e = await erro("select * from audit.eventos limit 1");
ok("T24", "Nem o auditor lê audit.eventos diretamente (só pelas funções)", e !== null, e);
await como("gestor");
e = await erro("insert into audit.eventos (evento_uuid) values (gen_random_uuid())");
ok("T25", "Usuário não insere direto em audit.eventos", e !== null, e);
await admin();
const eu = await erro("update audit.eventos set motivo='x' where id=1");
const ed = await erro("delete from audit.eventos where id=1");
const et = await erro("truncate audit.eventos");
ok("T26", "Administrador do banco não altera/apaga/trunca eventos sem desligar gatilhos (limitação: com gatilho desligado só a verificação/âncora detectam)", eu && ed && et, [eu, ed, et].map((x) => x && x.slice(0, 40)).join(" | "));
const mu = await erro("update movimentacoes set observacao='x'");
const md = await erro("delete from movimentacoes");
ok("T27", "Histórico de movimentações não pode ser alterado nem apagado (nem pelo admin)", mu && md);
const assG = await assinar("gestor");
await como("gestor");
await q("select retirar_ferramenta_v2($1,$2,null,$3)", [fer["FRT-007"], fun["1187"], assG]);
await q("select devolver_ferramenta_v2($1)", [fer["FRT-007"]]);
e = await erro("delete from ferramentas where codigo='FRT-007'");
await admin();
const orf = (await q("select count(*)::int n from movimentacoes where ferramenta_codigo='FRT-007' and ferramenta_id is null"))[0].n;
ok("T28", "Excluir ferramenta preserva o histórico (somente o vínculo vira nulo)", e === null && orf === 2, e);

// ---------------------------------------------------------------- RF-07 consulta/exportação
await como("almox");
r = (await q("select consultar_auditoria() r"))[0].r;
ok("T29", "Almoxarife não consulta auditoria; tentativa registrada", r.ok === false && (await ultimo()).resultado === "negado");
await como("auditor");
r = (await q("select consultar_auditoria(p_limite => 1000) r"))[0].r;
ok("T30", "Auditor consulta; limite máximo de 200 por página aplicado", r.ok && r.itens.length <= 200 && r.itens.length > 0);
await como("auditor");
const p1 = (await q("select consultar_auditoria(p_limite => 5) r"))[0].r;
await como("auditor");
const p2 = (await q("select consultar_auditoria(p_limite => 5, p_antes_de => $1) r", [p1.proximo_antes_de]))[0].r;
ok("T31", "Paginação por cursor sem sobreposição", p1.itens.length === 5 && p2.itens.length === 5 && Math.max(...p2.itens.map((x) => x.id)) < Math.min(...p1.itens.map((x) => x.id)));
ok("T32", "Consulta da auditoria é ela própria auditada", (await ultimo()).acao === "consulta_auditoria");
await como("auditor");
r = (await q("select consultar_auditoria(p_de => now() - interval '400 days') r"))[0].r;
ok("T33", "Período acima de 366 dias é recusado", r.ok === false);
await como("auditor");
r = (await q("select exportar_auditoria(now()-interval '1 day', now(), 'curto') r"))[0].r;
ok("T34", "Exportação exige finalidade", r.ok === false);
await como("auditor");
r = (await q("select exportar_auditoria(now()-interval '1 day', now(), 'Auditoria interna mensal de controles') r"))[0].r;
ev = await ultimo();
ok("T35", "Exportação autorizada registra linhas e finalidade", r.ok && ev.acao === "exportacao_auditoria" && ev.contexto.linhas === r.itens.length && ev.contexto.finalidade.startsWith("Auditoria"));
await como("gestor");
r = (await q("select exportar_auditoria(now()-interval '1 day', now(), 'Quero exportar tudo agora') r"))[0].r;
ok("T36", "Gestor não exporta auditoria (segregação de funções); tentativa crítica registrada", r.ok === false && (await ultimo()).criticidade === "critica");

// ---------------------------------------------------------------- visualização de assinatura
const movId = mov.id;
await como("almox");
r = (await q("select registrar_visualizacao_assinatura($1) r", [movId]))[0].r;
ok("T37", "Almoxarife não vê assinaturas; tentativa registrada", r.ok === false && (await ultimo()).resultado === "negado");
await como("gestor");
r = (await q("select registrar_visualizacao_assinatura($1) r", [movId]))[0].r;
ok("T38", "Gestor vê assinatura e a visualização é registrada", r.ok && r.caminho === assin && (await ultimo()).acao === "visualizacao_assinatura");
await como("almox");
const so = await q("select name from storage.objects where bucket_id='assinaturas'");
ok("T39", "Política do storage: almoxarife não lista/abre arquivos de assinatura", so.length === 0);

// ---------------------------------------------------------------- CA-05: sem segredos
await admin();
const tudo = JSON.stringify(await q("select * from audit.eventos"));
ok("T40", "Nenhum token/JWT/senha nos eventos", !/eyJ[A-Za-z0-9_-]{5,}/.test(tudo) && !/"senha"|"password"|"token"/.test(tudo));
const utc = (await q("select ocorrido_em::text t from audit.eventos order by id desc limit 1"))[0].t;
ok("T41", "Data/hora com fuso explícito (timestamptz, UTC no hash)", /[+-]\d\d$|[+-]\d\d:\d\d$/.test(utc), utc);

// ---------------------------------------------------------------- integridade (hash encadeado)
await como("auditor");
r = (await q("select verificar_integridade_auditoria() r"))[0].r;
ok("T42", "Cadeia íntegra verificada", r.ok === true && r.eventos_verificados > 50, `${r.eventos_verificados} eventos`);
await admin();
await db.exec("alter table audit.eventos disable trigger trg_aud_bloq_linha");
const alvoRow = (await q("select id, motivo from audit.eventos order by id limit 1 offset 10"))[0], alvo = alvoRow.id;
await q("update audit.eventos set motivo = 'adulterado' where id = $1", [alvo]);
await db.exec("alter table audit.eventos enable trigger trg_aud_bloq_linha");
await como("auditor");
r = (await q("select verificar_integridade_auditoria() r"))[0].r;
ok("T43", "Adulteração direta (superusuário) é detectada no evento exato", r.ok === false && r.primeiro_erro_id === alvo && r.tipo_erro === "conteudo_alterado");
ev = await ultimo();
ok("T44", "Falha de integridade gera evento crítico", ev.acao === "verificacao_integridade" && ev.criticidade === "critica" && ev.resultado === "falha");
await admin();
await db.exec("alter table audit.eventos disable trigger trg_aud_bloq_linha");
await q("update audit.eventos set motivo = $2 where id = $1", [alvo, alvoRow.motivo]);   // restaura o conteúdo original
const apagar = (await q("select id from audit.eventos order by id limit 1 offset 20"))[0].id;
await q("delete from audit.eventos where id = $1", [apagar]);
const seguinte = (await q("select min(id)::int i from audit.eventos where id > $1", [apagar]))[0].i;   // ids podem ter lacunas
await db.exec("alter table audit.eventos enable trigger trg_aud_bloq_linha");
await como("auditor");
r = (await q("select verificar_integridade_auditoria() r"))[0].r;
ok("T45", "Exclusão de evento intermediário é detectada (encadeamento quebrado)", r.ok === false && r.primeiro_erro_id === seguinte && r.tipo_erro === "encadeamento_quebrado");

// ---------------------------------------------------------------- regressão funcional
await como("almox");
r = (await q("select devolver_ferramenta_v2($1, null, 'ok') r", [fer["FRT-002"]]))[0].r;
const r2 = (await q("select manutencao_ferramenta_v2($1, true, 'motor') r", [fer["FRT-002"]]))[0].r;
const r3 = (await q("select manutencao_ferramenta_v2($1, false) r", [fer["FRT-002"]]))[0].r;
const st = (await q("select status from ferramentas where id=$1", [fer["FRT-002"]]))[0].status;
ok("T46", "Fluxo devolução → manutenção → disponível continua funcionando", r.ok && r2.ok && r3.ok && st === "disponivel");
const a1 = await assinar("almox"), a2 = await assinar("almox"); await como("almox");
r = (await q("select retirar_ferramenta_v2($1,$2,null,$3) r", [fer["FRT-001"], fun["3021"], a1]))[0].r;
const dup = (await q("select retirar_ferramenta_v2($1,$2,null,$3) r", [fer["FRT-001"], fun["1187"], a2]))[0].r;
ok("T47", "Retirada dupla da mesma ferramenta continua impedida", r.ok && dup.ok === false);
await admin();
const al = await q("select codigo from v_alertas_posse");
await db.exec("alter table ferramentas disable trigger trg_ferramentas_protege");
await q("update ferramentas set retirada_em = now() - interval '3 days' where codigo='FRT-001'");
await db.exec("alter table ferramentas enable trigger trg_ferramentas_protege");
await como("almox");
const al2 = await q("select codigo from v_alertas_posse");
ok("T48", "Alerta de +2 dias continua funcionando (com RLS por perfil)", al.length === 0 && al2.length === 1 && al2[0].codigo === "FRT-001");

// ---------------------------------------------------------------- achados da revisão independente
await admin();
await db.exec("alter table audit.eventos disable trigger trg_aud_bloq_linha");
await q("delete from audit.eventos where id >= $1", [apagar]);        // remove o dano dos testes T43–T45
await db.exec("alter table audit.eventos enable trigger trg_aud_bloq_linha");
// reconstrói uma cadeia limpa a partir daqui com um marco
await q("select audit.registrar('auditoria','marco_teste','baixa',null,null,'sucesso')");
await db.exec("alter table audit.eventos disable trigger trg_aud_bloq_linha");
await db.exec(`do $$ declare e audit.eventos; ant text := null; begin
  for e in select * from audit.eventos order by id loop
    e.hash_anterior := ant; e.hash := audit._hash(e);
    update audit.eventos set hash_anterior = e.hash_anterior, hash = e.hash where id = e.id; ant := e.hash; end loop; end $$`);
await db.exec("alter table audit.eventos enable trigger trg_aud_bloq_linha");

const b1 = await assinar("almox"); await como("almox");
await q("select devolver_ferramenta_v2($1)", [fer["FRT-001"]]);
r = (await q("select retirar_ferramenta_v2($1,$2,null,$3) r", [fer["FRT-001"], fun["3021"], b1]))[0].r;
const reuso = (await q("select retirar_ferramenta_v2($1,$2,null,$3) r", [fer["FRT-003"], fun["1187"], b1]))[0].r;
ok("R01", "Achado 1: assinatura já usada não comprova outra retirada", r.ok && reuso.ok === false && reuso.motivo === "assinatura_ausente");
const bG = await assinar("gestor"); await como("almox");
r = (await q("select retirar_ferramenta_v2($1,$2,null,$3) r", [fer["FRT-003"], fun["1187"], bG]))[0].r;
ok("R02", "Achado 1: assinatura enviada por outro usuário é recusada", r.ok === false);
const bVelha = await assinar("almox"); await admin();
await q("update storage.objects set created_at = now() - interval '20 minutes' where name = $1", [bVelha]);
await como("almox");
r = (await q("select retirar_ferramenta_v2($1,$2,null,$3) r", [fer["FRT-003"], fun["1187"], bVelha]))[0].r;
ok("R03", "Achado 1: assinatura enviada há mais de 15 min é recusada", r.ok === false);
await como("almox");
e = await erro("select assinatura_path from movimentacoes limit 1");
const tem = await q("select tem_assinatura from movimentacoes where tem_assinatura limit 1");
ok("R04", "Achado 1: almoxarife não lê o caminho das assinaturas (só 'tem_assinatura')", e !== null && tem.length === 1, e);
await como("almox");
e = await erro("insert into storage.objects (bucket_id, name) values ('assinaturas', 'qualquer/coisa.exe')");
ok("R05", "Achado 11: upload fora do padrão de nome é recusado pela política", e !== null, e);
ev = (await (async () => { await admin(); return q("select contexto from audit.eventos where acao='retirada' and resultado='sucesso' order by id desc limit 1"); })())[0];
ok("R06", "Achado 10: evento da retirada registra tamanho e eTag do arquivo da assinatura", /^\d+$/.test(ev.contexto.assinatura?.tamanho || "") && /^[0-9a-f]{32}$/.test(ev.contexto.assinatura?.etag || ""));

await admin(); let c0 = (await q("select count(*)::int n from audit.eventos"))[0].n;
await como("sem");
for (let i = 0; i < 150; i++) await q("select auditar_evento('acao_inexistente')");
for (let i = 0; i < 100; i++) await q("select consultar_auditoria()");
for (let i = 0; i < 100; i++) await q("select retirar_ferramenta_v2($1,$2)", [fer["FRT-003"], fun["1187"]]);
await admin(); let c1 = (await q("select count(*)::int n from audit.eventos"))[0].n;
ok("R07", "Achado 2: 350 tentativas inválidas/negadas geram no máximo ~61 eventos por minuto", c1 - c0 <= 64, `${c1 - c0} eventos gravados`);
ok("R08", "Achado 2: excesso sinalizado uma vez como 'limite_excedido'", (await q("select count(*)::int n from audit.eventos where acao='limite_excedido' and ator_id=$1", [U.sem]))[0].n === 1);
await como("almox");
const grande = JSON.stringify({ x: "a".repeat(3000) });
const rg = (await q("select auditar_evento('impressao_etiquetas', null, $1::jsonb) r", [grande]))[0].r;
ev = await ultimo();
ok("R09", "Achado 3: contexto acima de 2 KB é recusado e o evento gravado é pequeno", rg === false && ev.motivo === "contexto_grande" && JSON.stringify(ev).length < 2000);
await admin();
const aninhado = JSON.stringify({ a: Array.from({ length: 40 }, () => ({ b: Array.from({ length: 40 }, () => ({ c: "x".repeat(150) })) })) });
await q("select audit.registrar('teste','contexto_enorme','baixa','ferramentas','x','sucesso',null,jsonb_build_object('identificador','FRT-X') || $1::jsonb)", [aninhado]);
const evG = (await q("select contexto, octet_length(contexto::text) n from audit.eventos order by id desc limit 1"))[0];
ok("R10", "Achado 3: contexto enorme é reduzido no ponto de gravação, mantendo o identificador", evG.n < 16384 && evG.contexto.contexto_reduzido === true && evG.contexto.identificador === "FRT-X", `${evG.n} bytes`);
await admin();
const pAntes = (await q("select array_agg(papel order by papel) p from perfis where user_id=$1", [U.auditor]))[0].p;
em = await script(mig);
const pDepois = (await q("select array_agg(papel order by papel) p from perfis where user_id=$1", [U.auditor]))[0].p;
ok("R11", "Achado 7: reexecutar a migração não concede perfis de novo (separação de funções mantida)", em === null && JSON.stringify(pAntes) === JSON.stringify(pDepois), JSON.stringify(pDepois));
await como("almox");
await q("update ferramentas set observacoes = 'Entregue a Joao Silva CPF 123.456.789-00' where codigo='FRT-005'");
ev = await ultimo();
ok("R12", "Achado 9: texto livre (observações) registra só que mudou, não o conteúdo", ev.contexto.campos_pessoais_alterados?.includes("observacoes") && !JSON.stringify(ev).includes("CPF"));
await como("almox");
e = await erro("select set_config('app.via_rpc','on',false)");
const e2 = await erro("update ferramentas set status='manutencao' where codigo='FRT-005'");
await q("select set_config('app.via_rpc','',false)");
ok("R13", "Achado 13: mesmo com app.via_rpc ligado na sessão, usuário comum não muda status", e2 !== null, e2);
await como("almox");
await q("update ferramentas set nome = 'Chave Ajustável 12 pol.' where codigo='FRT-005'");
ok("R14", "Edição legítima de cadastro pelo almoxarife continua funcionando", (await q("select nome from ferramentas where codigo='FRT-005'"))[0].nome === "Chave Ajustável 12 pol.");
await como("almox");
e = await erro("select auditar_evento('impressao_etiquetas', null, '{}'::jsonb, null)");
ok("R15", "Achado 14: resultado nulo não gera erro interno", e === null, e);
await como("gestor");
e = await erro("delete from funcionarios where id = $1", [fun["3021"]]);
ok("R16", "Achado 15: excluir funcionário com ferramenta dá mensagem clara", e && e.includes("devolução antes de excluir"), e);
await como("almox");
await q("select auditar_evento('impressao_etiquetas', $1)", ["abc‮txt.exe​"]);
ev = await ultimo();
ok("R17", "Achado 17: caracteres bidirecionais/invisíveis são removidos", ev.recurso_id === "abctxt.exe");

await como("auditor");
let v = (await q("select verificar_integridade_auditoria(null, 20) r"))[0].r; let voltas = 1, totalV = v.eventos_verificados;
while (v.ok && v.proximo_a_partir_de) { await como("auditor"); v = (await q("select verificar_integridade_auditoria($1, 20) r", [v.proximo_a_partir_de]))[0].r; voltas++; totalV += v.eventos_verificados; }
await admin(); const totalEv = (await q("select count(*)::int n from audit.eventos where id <= $1", [v.ultimo_id]))[0].n;
ok("R18", "Achado 4: verificação em lotes percorre a cadeia inteira", v.ok && voltas > 1 && totalV === totalEv, `${voltas} lotes, ${totalV} eventos`);
const anc = (await q("select id, hash from audit.eventos order by id desc limit 1 offset 3"))[0];
await como("auditor");
r = (await q("select confirmar_ancora_auditoria($1,$2) r", [anc.id, anc.hash]))[0].r;
ok("R19", "Achado 8: âncora anotada fora do sistema é confirmada", r.ok === true);
await admin();
await db.exec("alter table audit.eventos disable trigger trg_aud_bloq_linha");
await q("delete from audit.eventos where id >= $1", [anc.id]);                // corte do final da cadeia
await db.exec("alter table audit.eventos enable trigger trg_aud_bloq_linha");
await como("auditor");
const vCorte = (await q("select verificar_integridade_auditoria() r"))[0].r;
await como("auditor");
r = (await q("select confirmar_ancora_auditoria($1,$2) r", [anc.id, anc.hash]))[0].r;
ok("R20", "Achado 8: corte do final passa na verificação simples, mas é detectado pela âncora externa", vCorte.ok === true && r.ok === false && r.existe === false);
await admin();
await q("select audit.registrar('auditoria','reparo_teste','baixa','etiquetas',null,'sucesso')");
await db.exec("alter table audit.eventos disable trigger trg_aud_bloq_linha");
const alvoC = (await q("select id from audit.eventos order by id desc limit 1"))[0].id;
await q("update audit.eventos set recurso = 'etiquetas|-', motivo = null where id = $1", [alvoC]);
await db.exec("alter table audit.eventos enable trigger trg_aud_bloq_linha");
await como("auditor");
r = (await q("select verificar_integridade_auditoria() r"))[0].r;
ok("R21", "Achado 12: troca ambígua de campos (separador) é detectada", r.ok === false && r.primeiro_erro_id === alvoC);

// ---------------------------------------------------------------- brechas da re-verificação (N1–N3)
await como("sem");
for (let i = 0; i < 70; i++) await q("select auditar_evento('acao_inexistente')");   // ainda acima do limite
await como("sem");
await q("select exportar_auditoria(now()-interval '1 day', now(), 'tentativa depois de inundar')");
await admin();
const crit = (await q("select count(*)::int n from audit.eventos where ator_id=$1 and acao='exportacao_auditoria' and resultado='negado'", [U.sem]))[0].n;
ok("R23", "N1: após estourar o limite com repetições, a 1ª tentativa crítica distinta continua registrada", crit === 1);
await como("almox");
e = await erro("update ferramentas set nome = $1 where codigo='FRT-005'", ["x".repeat(5000)]);
ok("R24", "N2: texto gigante em cadastro é recusado pelo limite de tamanho da coluna", e !== null, e && e.slice(0, 60));
await como("almox");
await q("update ferramentas set codigo='FRT-055', nome=$1 where codigo='FRT-005'", ["Chave " + "y".repeat(180)]);
ev = await ultimo();
ok("R25", "N2: alteração de código continua rastreada (de/para + identificador) mesmo com nome longo", ev.contexto.alteracoes?.codigo?.de === "FRT-005" && ev.contexto.alteracoes?.codigo?.para === "FRT-055" && ev.contexto.identificador === "FRT-055");
const bOrig = await assinar("almox"); await como("almox");
await q("select devolver_ferramenta_v2($1)", [fer["FRT-001"]]);
r = (await q("select retirar_ferramenta_v2($1,$2,null,$3) r", [fer["FRT-001"], fun["3021"], bOrig]))[0].r;
const copia = `2026/11/${"c".repeat(8)}-1b4e-4ab0-883f-0016d3cca427.png`;
await admin(); const mdOrig = (await q("select metadata from storage.objects where name=$1", [bOrig]))[0].metadata;
await como("almox");   // o Storage real calcula o eTag a partir do conteúdo: mesma imagem => mesmo eTag
await q("insert into storage.objects (bucket_id, name, metadata) values ('assinaturas', $1, $2)", [copia, mdOrig]);
await como("almox");
r = (await q("select retirar_ferramenta_v2($1,$2,null,$3) r", [fer["FRT-003"], fun["1187"], copia]))[0].r;
ok("R26", "N3: mesma imagem (eTag+tamanho) reenviada com outro nome é recusada", r.ok === false);

// ---------------------------------------------------------------- reversão e reaplicação
await admin();
const nAntes = (await q("select count(*)::int n from audit.eventos"))[0].n;
const rev = await script(read("supabase/migrations/002_auditoria_fase_a_reverter.sql"));
const nDepois = (await q("select count(*)::int n from audit.eventos"))[0].n;
await como("almox");
const velho = await erro("select retirar_ferramenta($1,$2)", [fer["FRT-003"], fun["3021"]]);
ok("T49", "Reversão aplica, preserva os eventos e restaura as funções antigas", rev === null && nDepois === nAntes + 1 && velho === null, rev || velho);
await admin();
const rev2 = await script(read("supabase/migrations/002_auditoria_fase_a_reverter.sql"));
ok("R22", "Achado 16: a reversão pode ser reexecutada", rev2 === null, rev2);
await admin();
em = await script(mig);
ok("T50", "Migração pode ser reaplicada após a reversão", em === null, em);

log(`\nRESULTADO: ${falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " FALHA(S)"}`);
fs.mkdirSync(path.join(ROOT, "docs", "evidencias"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "evidencias", "testes_sql_fase_a.txt"), out.join("\n") + "\n");
process.exit(falhas ? 1 : 0);
