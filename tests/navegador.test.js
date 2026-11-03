// Testes de navegador (Playwright). Executar: node tests/navegador.test.js  (com o site servido em :8765)
const { chromium, devices } = require("playwright");
const fs = require("fs"), path = require("path");
const BASE = process.env.BASE || "http://localhost:8765";
const OUT = path.join(__dirname, "..", "docs", "evidencias");
fs.mkdirSync(OUT, { recursive: true });
const log = []; let falhas = 0;
const ok = (id, d, c, det = "") => { if (!c) falhas++; const l = `${c ? "PASSOU" : "FALHOU"}  ${id}  ${d}${det ? "  — " + det : ""}`; log.push(l); console.log(l); };

// ---- Supabase simulado (injetado no lugar de vendor/supabase.js)
function mockSupabase(fx) {
  return `(function(){
  var FX = ${JSON.stringify(fx)}; window.__rpc = []; window.__headers = null;
  function Q(table){ this.t=table; this.op='select'; }
  ["select","order","range","eq","in"].forEach(function(m){ Q.prototype[m]=function(){ return this; }; });
  Q.prototype.insert=function(){ this.op='insert'; return this; }; Q.prototype.update=function(){ this.op='update'; return this; };
  Q.prototype.delete=function(){ this.op='delete'; return this; }; Q.prototype.upsert=function(){ this.op='upsert'; return this; };
  Q.prototype.then=function(res,rej){ var d = this.op==='select' ? (FX.tabelas[this.t]||[]) : null; return Promise.resolve({data:d,error:null}).then(res,rej); };
  window.supabase = { createClient: function(url,key,opts){ window.__headers = opts && opts.global && opts.global.headers; return {
    auth: { getSession: async function(){ return {data:{session: FX.sessao ? {user:{id:'u1',email:FX.sessao}} : null}}; },
            onAuthStateChange: function(){}, signOut: async function(){ window.__saiu=true; },
            signInWithPassword: async function(){ return {data:{user:{id:'u1',email:'x@y'}},error:null}; } },
    from: function(t){ return new Q(t); },
    rpc: async function(n,p){ window.__rpc.push({n:n,p:p}); var r = FX.rpc[n]; return {data: r===undefined ? true : r, error:null}; },
    storage: { from: function(){ return { upload: async function(){ return {data:{},error:null}; },
      createSignedUrl: async function(){ return {data:{signedUrl:'data:image/png;base64,iVBORw0KGgo='},error:null}; } }; } },
    channel: function(){ return { on: function(){ return this; }, subscribe: function(){} }; }
  }; } };
})();`;
}
const PROD_CFG = 'window.APP_CONFIG={"MODO":"producao","SUPABASE_URL":"https://teste.supabase.co","SUPABASE_ANON_KEY":"eyJteste","ALERTA_HORAS":48};';
const FER = [{ id: "f1", codigo: "FRT-001", nome: "Furadeira", status: "disponivel", site: "Obra A", tipo: "Elétrica", classificacao: "proprio" },
             { id: "f2", codigo: "FRT-002", nome: "Nível", status: "em_uso", funcionario_id: "w1", retirada_em: new Date(Date.now() - 80 * 3600e3).toISOString(), site: "Obra A" }];
const FUN = [{ id: "w1", matricula: "100", nome: "Ana Souza", ativo: true }];

async function pagina(browser, { config, fx, device } = {}) {
  const ctx = await browser.newContext(device ? devices[device] : { viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  if (config) await ctx.route("**/js/config.js", (r) => r.fulfill({ contentType: "text/javascript", body: config }));
  if (fx) await ctx.route("**/vendor/supabase.js", (r) => r.fulfill({ contentType: "text/javascript", body: mockSupabase(fx) }));
  await ctx.route("**/fonts.googleapis.com/**", (r) => r.abort());
  const p = await ctx.newPage(); p.__erros = [];
  p.on("pageerror", (e) => p.__erros.push(e.message));
  return p;
}

(async () => {
  log.push(`# Testes de navegador — ${new Date().toISOString()}`);
  const b = await chromium.launch();

  // N01 — falha fechada
  let p = await pagina(b, { config: 'window.APP_CONFIG={"MODO":"erro","SUPABASE_URL":"","SUPABASE_ANON_KEY":""};' });
  await p.goto(BASE + "/index.html"); await p.waitForTimeout(500);
  ok("N01", "Produção sem configuração mostra 'Sistema não configurado' e não abre demonstração",
     (await p.textContent("body")).includes("Sistema não configurado") && await p.$eval(".app", (e) => e.hidden));
  await p.screenshot({ path: path.join(OUT, "n01_falha_fechada.png") }); await p.context().close();

  // N02 — usuário sem perfil
  p = await pagina(b, { config: PROD_CFG, fx: { sessao: "novo@empresa", tabelas: { perfis: [] }, rpc: {} } });
  await p.goto(BASE + "/index.html"); await p.waitForTimeout(600);
  const rpcs2 = await p.evaluate(() => window.__rpc.map((x) => x.p && x.p.p_acao));
  ok("N02", "Usuário sem perfil vê bloqueio e o evento 'login_sem_perfil' é enviado",
     (await p.textContent("body")).includes("sem perfil de acesso") && rpcs2.includes("login_sem_perfil"));
  const hdr = await p.evaluate(() => window.__headers);
  ok("N03", "Cliente envia cabeçalho de correlação x-correlacao", hdr && /^s-[0-9a-f-]{8,}/.test(hdr["x-correlacao"]), hdr && hdr["x-correlacao"]);
  await p.context().close();

  // N04/N05 — perfil auditor: aba Auditoria visível, botões de operação ocultos
  p = await pagina(b, { config: PROD_CFG, fx: { sessao: "aud@empresa", tabelas: { perfis: [{ papel: "auditor" }], ferramentas: FER, funcionarios: FUN },
    rpc: { consultar_auditoria: { ok: true, itens: [{ id: 7, ocorrido_em: new Date().toISOString(), ator_email: "almox@empresa", ator_tipo: "usuario", categoria: "dados", acao: "delete",
      criticidade: "alta", recurso: "funcionarios", recurso_id: "abc", resultado: "sucesso", contexto: { identificador: "0876<script>alert(1)</script>" }, hash: "aa" }], proximo_antes_de: null },
      verificar_integridade_auditoria: { ok: true, eventos_verificados: 7, ultimo_id: 7, ultimo_hash: "ab12", proximo_a_partir_de: null },
      confirmar_ancora_auditoria: { ok: false, existe: false, mensagem: "O evento anotado NÃO existe mais: possível exclusão/corte da cadeia." } } } });
  await p.goto(BASE + "/index.html#ferramentas"); await p.waitForTimeout(600);
  const visiveis = await p.$$eval("#ferList button", (bs) => bs.filter((x) => x.offsetParent).map((x) => x.textContent));
  ok("N04", "Auditor (somente consulta): botões Retirar/Editar/Excluir ocultos", !visiveis.some((t) => /Retirar|Editar|Excluir|Manutenção/.test(t)), visiveis.join(","));
  ok("N05", "Aba Auditoria visível só para o auditor", await p.$eval("#tabAuditoria", (e) => !e.hidden));
  await p.click('.tab-btn[data-tab=etiquetas]'); await p.waitForTimeout(200);
  ok("N05b", "Auditor não vê o botão de imprimir etiquetas", await p.$eval("#etqPrint", (e) => e.offsetParent === null));
  await p.click('.tab-btn[data-tab=auditoria]'); await p.waitForTimeout(400);
  const nCons = await p.evaluate(() => window.__rpc.filter((x) => x.n === "consultar_auditoria").length);
  await p.evaluate(() => window.Almox && 0); await p.waitForTimeout(300);
  await p.click('.tab-btn[data-tab=painel]'); await p.click('.tab-btn[data-tab=auditoria]'); await p.waitForTimeout(300);
  const nCons2 = await p.evaluate(() => window.__rpc.filter((x) => x.n === "consultar_auditoria").length);
  ok("N06", "Aba Auditoria consulta uma vez e não reconsulta sozinha ao re-renderizar", nCons === 1 && nCons2 === 1, `${nCons}/${nCons2}`);
  await p.click('[data-ev="7"]'); await p.waitForTimeout(200);
  const xss = await p.evaluate(() => !!document.querySelector(".modal-card script"));
  ok("N07", "Conteúdo do evento é exibido escapado (sem injeção de HTML)", !xss && (await p.textContent(".modal-card")).includes("<script>"));
  await p.screenshot({ path: path.join(OUT, "n07_auditoria_detalhe.png") });
  await p.evaluate(() => window.Almox.closeModal());
  await p.click("#audVerif"); await p.waitForTimeout(300);
  ok("N08", "Verificação de integridade mostra resultado e último hash", (await p.textContent(".modal-card")).includes("ab12"));
  await p.fill("#anc_id", "5"); await p.fill("#anc_h", "a".repeat(64)); await p.click("#anc_ok"); await p.waitForTimeout(200);
  ok("N08b", "Conferência de âncora externa exibe divergência", (await p.textContent("#anc_res")).includes("NÃO existe"));
  await p.screenshot({ path: path.join(OUT, "n08_integridade.png") });
  await p.evaluate(() => window.Almox.closeModal());
  await p.click("#audExp"); await p.click("#ex_ok"); await p.waitForTimeout(200);
  const nExp = await p.evaluate(() => window.__rpc.filter((x) => x.n === "exportar_auditoria").length);
  ok("N09", "Exportação de auditoria exige finalidade antes de chamar o servidor", nExp === 0 && (await p.textContent("#ex_err")).includes("finalidade"));
  await p.context().close();

  // N10 — almoxarife: recusa do servidor vira mensagem; exportação exige auditoria
  p = await pagina(b, { config: PROD_CFG, fx: { sessao: "almox@empresa", tabelas: { perfis: [{ papel: "almoxarife" }], ferramentas: FER, funcionarios: FUN },
    rpc: { devolver_ferramenta_v2: { ok: false, erro: "Acesso negado: teste do servidor." }, auditar_evento: false } } });
  await p.goto(BASE + "/index.html#ferramentas"); await p.waitForTimeout(600);
  ok("N10", "Almoxarife não vê aba Auditoria nem botão Excluir", await p.$eval("#tabAuditoria", (e) => e.hidden) &&
     !(await p.$$eval("#ferList button", (bs) => bs.filter((x) => x.offsetParent).map((x) => x.textContent))).includes("Excluir"));
  await p.click('#ferList [data-a="back"]'); await p.click("#dvOk"); await p.waitForTimeout(300);
  ok("N11", "Recusa do servidor ({ok:false}) aparece para o usuário e não é tratada como sucesso", (await p.textContent("#dvErr")).includes("teste do servidor"));
  await p.evaluate(() => window.Almox.closeModal());
  await p.click('.tab-btn[data-tab=historico]'); await p.waitForTimeout(200);
  let baixou = false; p.on("download", () => { baixou = true; });
  await p.evaluate(() => { window.Almox.S.movimentacoes = [{ id: "m1", acao: "retirada", ferramenta_nome: "Furadeira", ferramenta_codigo: "FRT-001", created_at: new Date().toISOString() }]; });
  await p.selectOption("#hisDias", "0"); await p.click("#hisExport"); await p.waitForTimeout(600);
  ok("N12", "Exportação do histórico é cancelada se a auditoria não for gravada (falha fechada)", !baixou && (await p.textContent("#toast")).length > 0, await p.textContent("#toast"));
  await p.context().close();

  // N13+ — regressão em modo demonstração (fluxos completos)
  p = await pagina(b, { config: 'window.APP_CONFIG={"MODO":"demonstracao","SUPABASE_URL":"","SUPABASE_ANON_KEY":"","ALERTA_HORAS":48};' });
  await p.goto(BASE + "/index.html"); await p.waitForTimeout(800);
  ok("N13", "Demonstração: painel abre com alertas de +2 dias", (await p.textContent("#pnAlert")).includes("há mais de 2 dias"));
  await p.click('.tab-btn[data-tab=ferramentas]');
  await p.click('#ferList [data-a="out"]'); await p.fill("[data-q]", "wil"); await p.click(".picker-item");
  const c = await p.$("#coSig"); const bb = await c.boundingBox();
  await p.mouse.move(bb.x + 30, bb.y + 90); await p.mouse.down(); for (let i = 0; i < 15; i++) await p.mouse.move(bb.x + 30 + i * 15, bb.y + 90 + Math.sin(i) * 25); await p.mouse.up();
  await p.click("#coOk"); await p.waitForTimeout(300);
  ok("N14", "Retirada com assinatura continua funcionando", (await p.evaluate(() => window.Almox.S.movimentacoes[0].acao)) === "retirada");
  await p.click('.tab-btn[data-tab=funcionarios]'); await p.click("#funImport");
  await p.setInputFiles("#impFile", path.join(__dirname, "fixtures", "funcionarios.xlsx")); await p.waitForTimeout(800);
  const prev = await p.textContent("#funImportBox");
  ok("N15", "Importação .xlsx com a nova biblioteca: cabeçalho fora da 1ª linha, duplicada e sem matrícula detectadas",
     prev.includes("Maria da Silva") && prev.includes("Matrícula repetida") && prev.includes("Sem matrícula"));
  await p.screenshot({ path: path.join(OUT, "n15_importacao_xlsx.png"), fullPage: true });
  await p.click("#impGo"); await p.waitForTimeout(400);
  ok("N16", "Importação grava funcionários", (await p.evaluate(() => window.Almox.S.funcionarios.some((f) => f.matricula === "5001"))));
  await p.click("#funImport"); await p.setInputFiles("#impFile", path.join(__dirname, "fixtures", "funcionarios.csv")); await p.waitForTimeout(500);
  const prevCsv = await p.textContent("#funImportBox");
  ok("N17", "Importação .csv (separador ;, aspas e acentos)", prevCsv.includes("Joana D'Arc; Lima") && prevCsv.includes("6001"));
  await p.click("#impCancel");
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 5000 }).catch(() => null), (async () => { await p.click("#funImport"); await p.click("#impTpl"); })()]);
  let tplOk = false;
  if (dl) { const fp = path.join(OUT, "modelo_baixado.xlsx"); await dl.saveAs(fp); tplOk = fs.readFileSync(fp).slice(0, 2).toString() === "PK"; }
  ok("N18", "Modelo .xlsx é gerado (arquivo zip válido)", tplOk);
  await p.click('.tab-btn[data-tab=historico]'); await p.selectOption("#hisDias", "0");
  const [dl2] = await Promise.all([p.waitForEvent("download", { timeout: 5000 }).catch(() => null), p.click("#hisExport")]);
  let expOk = false;
  if (dl2) { const fp = path.join(OUT, "historico_exportado.xlsx"); await dl2.saveAs(fp); expOk = fs.readFileSync(fp).slice(0, 2).toString() === "PK"; }
  ok("N19", "Exportação do histórico gera .xlsx", expOk);
  ok("N20", "Exportação ficou registrada na auditoria (demonstração)", (await p.evaluate(() => window.Almox.API.eventos.map((e) => e.acao))).includes("exportacao_historico"));
  await p.click('.tab-btn[data-tab=auditoria]'); await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, "n21_aba_auditoria.png"), fullPage: true });
  ok("N21", "Aba Auditoria lista eventos", (await p.$$("#audList tbody tr")).length > 0);
  ok("N22", "Sem erros de JavaScript nas páginas", p.__erros.length === 0, p.__erros.join(" | "));
  await p.context().close();

  // N23 — app do celular
  p = await pagina(b, { config: 'window.APP_CONFIG={"MODO":"demonstracao","SUPABASE_URL":"","SUPABASE_ANON_KEY":"","ALERTA_HORAS":48};', device: "Pixel 7" });
  await p.goto(BASE + "/app.html"); await p.waitForTimeout(700);
  await p.fill("#codeIn", "frt-002"); await p.click("#codeForm button"); await p.click("#goOut");
  await p.fill("[data-q]", "1187"); await p.click(".picker-item"); await p.click("#toSign"); await p.waitForTimeout(200);
  const s2 = await p.$("#sig"); const b2 = await s2.boundingBox();
  await p.mouse.move(b2.x + 20, b2.y + 100); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(b2.x + 20 + i * 12, b2.y + 100 + Math.cos(i / 2) * 30); await p.mouse.up();
  await p.click("#confirmOut"); await p.waitForTimeout(400);
  ok("N23", "App do celular: escanear/código → funcionário → assinatura → confirmar", (await p.textContent("#view-scan")).includes("Retirada registrada") && p.__erros.length === 0, p.__erros.join(" | "));
  await p.screenshot({ path: path.join(OUT, "n23_app_celular.png") });
  await b.close();

  log.push(`\nRESULTADO: ${falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " FALHA(S)"}`);
  fs.writeFileSync(path.join(OUT, "testes_navegador.txt"), log.join("\n") + "\n");
  console.log(log[log.length - 1]);
  process.exit(falhas ? 1 : 0);
})();
