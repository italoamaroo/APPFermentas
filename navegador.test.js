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
  function Q(table){ this.t=table; this.op='select'; this.um=false; }
  ["select","order","range","eq","in","limit"].forEach(function(m){ Q.prototype[m]=function(){ return this; }; });
  Q.prototype.maybeSingle=function(){ this.um=true; return this; };
  Q.prototype.insert=function(){ this.op='insert'; return this; }; Q.prototype.update=function(){ this.op='update'; return this; };
  Q.prototype.delete=function(){ this.op='delete'; return this; }; Q.prototype.upsert=function(){ this.op='upsert'; return this; };
  Q.prototype.then=function(res,rej){
    if ((FX.erros||{})[this.t]) return Promise.resolve({data:null,error:{message:'relation "'+this.t+'" does not exist'}}).then(res,rej);
    var d = this.op==='select' ? (FX.tabelas[this.t]||[]) : null; if (this.um) d = d && d.length ? d[0] : null;
    return Promise.resolve({data:d,error:null}).then(res,rej); };
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

  // ---- Fase B.1: incidentes
  // B01 — calendário do front-end bate com o do banco (mesmos casos dos testes SQL I05–I08)
  p = await pagina(b, { config: 'window.APP_CONFIG={"MODO":"demonstracao","SUPABASE_URL":"","SUPABASE_ANON_KEY":"","ALERTA_HORAS":48};' });
  await p.goto(BASE + "/index.html"); await p.waitForTimeout(700);
  const cal = await p.evaluate(() => ["2026-11-13T13:00:00Z", "2026-11-18T13:00:00Z", "2026-11-19T02:30:00Z", "2026-12-23T12:00:00Z"].map((x) => window.Almox.prazoDiasUteis(x, 3)));
  ok("B01", "Prazo em dias úteis no navegador = banco (18/11, 24/11, 24/11, 29/12)", JSON.stringify(cal) === JSON.stringify(["2026-11-18", "2026-11-24", "2026-11-24", "2026-12-29"]), JSON.stringify(cal));
  const venc = await p.evaluate(() => ["2026-10-30T12:00:00Z", "2026-10-31T12:00:00Z", "2026-11-01T12:00:00Z", "2026-11-02T12:00:00Z", "2026-11-03T12:00:00Z"]
    .map((h) => window.Almox.diasUteisRestantes("2026-10-30", h)));
  ok("B01b", "Navegador = banco: vencido em fim de semana/feriado nunca vira 0 (0, -1, -1, -1, -1)", JSON.stringify(venc) === "[0,-1,-1,-1,-1]", JSON.stringify(venc));
  await p.click("#reportIncBtn"); await p.fill("#ri_t", "Celular do almoxarifado perdido"); await p.fill("#ri_d", "Perdido na obra; app aberto");
  await p.click("#ri_ok"); await p.waitForTimeout(300);
  await p.click('.tab-btn[data-tab=incidentes]'); await p.waitForTimeout(300);
  ok("B02", "Botão ⚠ registra incidente e ele aparece na aba Incidentes", (await p.textContent("#incList")).includes("Celular do almoxarifado perdido"));
  await p.click('#incList [data-inc]'); await p.waitForTimeout(300);
  await p.fill("#in_ci", "2026-11-02T09:00"); await p.check("#in_sig"); await p.check('input[name=a5][value=autenticacao]');
  ok("B03", "Indício do art. 5º aparece ao marcar 'afeta significativamente' + critério", await p.$eval("#in_ind", (e) => e.style.display !== "none"));
  await p.selectOption("#in_av", "risco_relevante"); await p.click("#in_salvar"); await p.waitForTimeout(200);
  ok("B04", "Mudar avaliação sem justificativa é recusado", (await p.textContent("#in_err")).includes("justificativa"));
  await p.fill("#in_jr", "Sessão aberta com acesso a cadastros"); await p.check('input[name=cd][value=cadastrais]'); await p.fill("#in_q", "40");
  await p.fill("#in_mc", "Bloqueio remoto do aparelho e troca de senhas");
  await p.fill("#in_com", "Avaliação inicial do gestor"); await p.click("#in_salvar"); await p.waitForTimeout(400);
  const txtInc = await p.textContent(".modal-card");
  ok("B05", "Após salvar, prazo calculado aparece (ciência 02/11 → ANPD até 05/11)", txtInc.includes("05/11/2026"), txtInc.match(/até\s+\S+/)?.[0]);
  await p.screenshot({ path: path.join(OUT, "b05_incidente_ficha.png"), fullPage: false });
  await p.click("#in_enc"); await p.fill("#mt_t", "Tentando encerrar sem comunicar"); await p.click("#mt_ok"); await p.waitForTimeout(200);
  ok("B06", "Não encerra risco relevante sem comunicações", (await p.textContent("#mt_err")).includes("ANPD"));
  await p.evaluate(() => window.Almox.closeModal());
  for (const dest of ["anpd", "titulares"]) {
    await p.click("details summary"); await p.selectOption("#cm_dest", dest); await p.fill("#cm_m", "Peticionamento / e-mail"); await p.fill("#cm_r", "Comunicado com os itens exigidos");
    await p.click("#cm_ok"); await p.waitForTimeout(400);
  }
  ok("B07", "Comunicações à ANPD e aos titulares registradas", (await p.$$eval("#in_coms .hist-row", (x) => x.length)) === 2);
  await p.click("#in_enc"); await p.fill("#mt_t", "Aparelho bloqueado e senhas trocadas"); await p.click("#mt_ok"); await p.waitForTimeout(400);
  ok("B08", "Encerramento com requisitos cumpridos", (await p.textContent(".modal-card .tag-row")).includes("Encerrado"));
  await p.evaluate(() => { window.print = () => { window.__impresso = document.getElementById("printArea").innerText; }; const mm = window.matchMedia.bind(window); window.matchMedia = (q) => q === "print" ? { matches: true } : mm(q); });
  await p.click("#in_print"); await p.waitForTimeout(200);
  const imp = await p.evaluate(() => window.__impresso || "");
  ok("B09", "Registro imprimível com os itens do art. 10 (I a VIII)", ["I · Data de conhecimento", "III · Natureza", "V · Avaliação", "VII · Comunicações", "VIII · Motivos"].every((t) => imp.includes(t)));
  ok("B10", "Sem erros de JavaScript no fluxo de incidentes", p.__erros.length === 0, p.__erros.join(" | "));
  await p.context().close();

  // B11 — almoxarife: sem aba Incidentes, mas pode comunicar
  p = await pagina(b, { config: PROD_CFG, fx: { sessao: "almox@empresa", tabelas: { perfis: [{ papel: "almoxarife" }], ferramentas: FER, funcionarios: FUN, v_incidentes: [] },
    rpc: { registrar_incidente: { ok: true, id: "i1", numero: 7 } } } });
  await p.goto(BASE + "/index.html"); await p.waitForTimeout(600);
  ok("B11", "Almoxarife não vê a aba Incidentes", await p.$eval("#tabIncidentes", (e) => e.hidden));
  await p.click("#reportIncBtn"); await p.fill("#ri_t", "Senha anotada em papel achada"); await p.click("#ri_ok"); await p.waitForTimeout(300);
  ok("B12", "Almoxarife comunica incidente (chama registrar_incidente)", (await p.evaluate(() => window.__rpc.some((x) => x.n === "registrar_incidente" && x.p.p_titulo.includes("Senha")))));
  await p.context().close();

  // B13 — gestor com prazo quase vencido: alerta no painel e contador vermelho
  const incVence = [{ id: "i9", numero: 9, titulo: "Planilha enviada ao e-mail errado", status: "em_analise", avaliacao_risco: "risco_relevante",
    ciencia_em: new Date().toISOString(), prazo_anpd: "2026-11-05", dias_uteis_para_prazo: 1, origem: "manual", detectado_em: new Date().toISOString(), indicio_art5: true }];
  p = await pagina(b, { config: PROD_CFG, fx: { sessao: "gestor@empresa", tabelas: { perfis: [{ papel: "gestor" }], ferramentas: FER, funcionarios: FUN, v_incidentes: incVence }, rpc: {} } });
  await p.goto(BASE + "/index.html"); await p.waitForTimeout(700);
  const pn = await p.textContent("#pnInc");
  ok("B13", "Gestor vê alerta de prazo de incidente no Painel", pn.includes("incidente(s) de segurança em aberto") && pn.includes("vence em 1 dia"));
  ok("B14", "Contador vermelho na aba Incidentes quando prazo ≤ 1 dia útil", await p.$eval("#incCount", (e) => !e.hidden && e.style.background.includes("danger")));
  await p.screenshot({ path: path.join(OUT, "b13_alerta_incidente.png") });
  ok("B15", "Botão 'Enquadramento' só para o encarregado (gestor não vê)", await (async () => { await p.click('.tab-btn[data-tab=incidentes]'); await p.waitForTimeout(200); return p.$eval("#incPPBtn", (e) => e.offsetParent === null); })());
  await p.context().close();

  // B16 — encarregado sem outros perfis abre direto em Incidentes
  p = await pagina(b, { config: PROD_CFG, fx: { sessao: "dpo@empresa", tabelas: { perfis: [{ papel: "encarregado" }], v_incidentes: incVence }, rpc: {} } });
  await p.goto(BASE + "/index.html"); await p.waitForTimeout(700);
  ok("B16", "Encarregado abre direto na aba Incidentes e vê 'Enquadramento'", await p.$eval("#view-incidentes", (e) => !e.hidden) && await p.$eval("#incPPBtn", (e) => e.offsetParent !== null));
  await p.context().close();

  // B17 — banco sem a migração 003: nada quebra
  p = await pagina(b, { config: PROD_CFG, fx: { sessao: "gestor@empresa", tabelas: { perfis: [{ papel: "gestor" }], ferramentas: FER, funcionarios: FUN }, erros: { v_incidentes: true }, rpc: {} } });
  await p.goto(BASE + "/index.html"); await p.waitForTimeout(700);
  await p.click('.tab-btn[data-tab=incidentes]'); await p.waitForTimeout(200);
  ok("B17", "Sem a migração 003 o painel funciona e avisa que o registro não foi ativado", (await p.textContent("#incList")).includes("ainda não foi ativado") && p.__erros.length === 0 && (await p.textContent("#ferList, #view-painel")).length > 0);
  await p.context().close();

  // ---- Cadastro rápido de funcionário na retirada
  const DEMO_CFG = 'window.APP_CONFIG={"MODO":"demonstracao","SUPABASE_URL":"","SUPABASE_ANON_KEY":"","ALERTA_HORAS":48};';
  p = await pagina(b, { config: DEMO_CFG, device: "Pixel 7" });
  await p.goto(BASE + "/app.html"); await p.waitForTimeout(700);
  await p.fill("#codeIn", "frt-003"); await p.click("#codeForm button"); await p.click("#goOut");
  await p.fill("[data-q]", "Carlos Novato"); await p.waitForTimeout(150);
  ok("C01", "Busca sem resultado oferece 'Cadastrar … como novo funcionário'", (await p.textContent("#pickBox")).includes("Cadastrar “Carlos Novato” como novo funcionário"));
  await p.click("[data-novo-btn]"); await p.waitForTimeout(150);
  ok("C02", "Formulário abre com o nome digitado já preenchido", (await p.inputValue('[data-f="nome"]')) === "Carlos Novato");
  await p.click("[data-nsalvar]"); await p.waitForTimeout(150);
  ok("C03", "Sem matrícula não cadastra", (await p.textContent("[data-nerr]")).includes("matrícula"));
  await p.fill('[data-f="matricula"]', "9001"); await p.fill('[data-f="funcao"]', "Ajudante");
  await p.screenshot({ path: path.join(OUT, "c03_cadastro_rapido_celular.png") });
  await p.click("[data-nsalvar]"); await p.waitForTimeout(400);
  ok("C04", "Cadastra, seleciona automaticamente e libera a assinatura", (await p.textContent("#pickBox .picked")).includes("Carlos Novato") && await p.$eval("#toSign", (e) => !e.disabled));
  await p.click("#toSign"); await p.waitForTimeout(200);
  const sg = await p.$("#sig"); const sb2 = await sg.boundingBox();
  await p.mouse.move(sb2.x + 20, sb2.y + 100); await p.mouse.down(); for (let i = 0; i < 15; i++) await p.mouse.move(sb2.x + 20 + i * 14, sb2.y + 100 + Math.sin(i) * 25); await p.mouse.up();
  await p.click("#confirmOut"); await p.waitForTimeout(400);
  const mv = await p.evaluate(() => { const m = window.Almox.S.movimentacoes[0]; return m.acao + "|" + m.matricula + "|" + m.funcionario_nome; });
  ok("C05", "Retirada concluída com o funcionário recém-cadastrado", mv === "retirada|9001|Carlos Novato", mv);
  await p.click("#nextScan"); await p.fill("#codeIn", "frt-005"); await p.click("#codeForm button"); await p.click("#goOut");
  await p.fill("[data-q]", "3021x"); await p.click("[data-novo-btn]"); await p.waitForTimeout(100);
  ok("C06", "Termo com número vira matrícula no formulário", (await p.inputValue('[data-f="matricula"]')) === "3021x" && (await p.inputValue('[data-f="nome"]')) === "");
  await p.fill('[data-f="matricula"]', "3021"); await p.fill('[data-f="nome"]', "Outro Nome");
  await p.click("[data-nsalvar]"); await p.waitForTimeout(300);
  const nFunc = await p.evaluate(() => window.Almox.S.funcionarios.filter((f) => f.matricula === "3021").length);
  ok("C07", "Matrícula já existente não duplica: seleciona o cadastro existente", nFunc === 1 && (await p.textContent("#pickBox .picked")).includes("Edivaldo"));
  ok("C08", "Sem erros de JavaScript no cadastro rápido (celular)", p.__erros.length === 0, p.__erros.join(" | "));
  await p.context().close();

  p = await pagina(b, { config: DEMO_CFG });
  await p.goto(BASE + "/index.html#ferramentas"); await p.waitForTimeout(700);
  await p.click('#ferList [data-a="out"]'); await p.fill("[data-q]", "Joana Recém"); await p.click("[data-novo-btn]");
  await p.fill('[data-f="matricula"]', "9002"); await p.click("[data-nsalvar]"); await p.waitForTimeout(400);
  ok("C09", "Cadastro rápido também funciona na retirada pelo painel", (await p.textContent("#coPicker .picked")).includes("Joana Recém"));
  await p.screenshot({ path: path.join(OUT, "c09_cadastro_rapido_painel.png") });
  await p.context().close();

  p = await pagina(b, { config: PROD_CFG, fx: { sessao: "aud@empresa", tabelas: { perfis: [{ papel: "auditor" }], ferramentas: FER, funcionarios: FUN }, rpc: {} } });
  await p.goto(BASE + "/index.html"); await p.waitForTimeout(600);
  const semBotao = await p.evaluate(() => { const d = document.createElement("div"); document.body.appendChild(d); window.Almox.funcionarioPicker(d); d.querySelector("[data-q]").value = "ninguém"; d.querySelector("[data-q]").dispatchEvent(new Event("input")); return !d.querySelector("[data-novo-btn]") && d.textContent.includes("Peça ao almoxarife"); });
  ok("C10", "Perfil sem permissão de cadastro (auditor) não vê o botão", semBotao);
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
