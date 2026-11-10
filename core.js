/* =====================================================================
   Almoxarifado — núcleo compartilhado (painel e app do celular)
   - Camada de dados: Supabase (produção) ou localStorage (modo demonstração)
   - Componentes: modal, toast, QR, leitor de QR, assinatura, seletor de funcionário
   ===================================================================== */
(function () {
  "use strict";

  var CFG = window.APP_CONFIG || {};
  // MODO vem do build.js. Em produção sem configuração => "erro" (falha fechada, nunca cai em demonstração)
  var MODO = CFG.MODO || ((!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) ? "demonstracao" : "producao");
  var DEMO = MODO === "demonstracao";
  var ALERTA_HORAS = Number(CFG.ALERTA_HORAS) || 48;

  /* ------------------------------------------------------------ helpers */
  // UUID v4 (também em navegadores sem crypto.randomUUID — o servidor exige o formato no nome da assinatura)
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b); else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  function nowISO() { return new Date().toISOString(); }
  function hoursAgoISO(h) { return new Date(Date.now() - h * 3600 * 1000).toISOString(); }
  // Calendário (espelho de public.prazo_dias_uteis): feriados nacionais (Portaria MGI 11.460/2025) + Paixão de Cristo
  function pascoa(y) {
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
      h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    return new Date(Date.UTC(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1));
  }
  function diaUtil(dt) {   // dt em UTC representando a data local
    var dow = dt.getUTCDay(), md = String(dt.getUTCMonth() + 1).padStart(2, "0") + "-" + String(dt.getUTCDate()).padStart(2, "0");
    if (dow === 0 || dow === 6) return false;
    if (["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "12-25"].indexOf(md) >= 0) return false;
    if (md === "11-20" && dt.getUTCFullYear() >= 2024) return false;   // Lei 14.759/2023
    var sexta = pascoa(dt.getUTCFullYear()); sexta.setUTCDate(sexta.getUTCDate() - 2);
    return dt.getTime() !== sexta.getTime();
  }
  function dataLocalRecife(iso) { var d = new Date(new Date(iso).getTime() - 3 * 3600000); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
  function prazoDiasUteis(iso, n) {
    if (!iso) return null; var d = dataLocalRecife(iso), c = 0;
    while (c < n) { d.setUTCDate(d.getUTCDate() + 1); if (diaUtil(d)) c++; }
    return d.toISOString().slice(0, 10);
  }
  function diasUteisRestantes(prazo, hojeIso) {
    if (!prazo) return null; var hoje = dataLocalRecife(hojeIso || new Date().toISOString()), alvo = new Date(prazo + "T00:00:00Z"), n = 0, d = new Date(hoje);
    if (alvo - hoje > 400 * 86400000) return 999; if (hoje - alvo > 400 * 86400000) return -999;
    if (alvo >= hoje) { while (d < alvo) { d.setUTCDate(d.getUTCDate() + 1); if (diaUtil(d)) n++; } return n; }
    d = new Date(alvo); while (d < hoje) { d.setUTCDate(d.getUTCDate() + 1); if (diaUtil(d)) n--; } return Math.min(n, -1);   // vencido nunca é 0
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDateTime(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return iso; }
  }
  function fmtElapsed(iso) {
    if (!iso) return "—";
    var ms = Math.max(0, Date.now() - new Date(iso).getTime());
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return "agora mesmo";
    if (mins < 60) return "há " + mins + " min";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return "há " + hrs + "h" + (mins % 60 ? " " + (mins % 60) + "min" : "");
    return "há " + Math.floor(hrs / 24) + "d " + (hrs % 24) + "h";
  }
  function hoursSince(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : 0; }
  function isLate(t) { return t && t.status === "em_uso" && hoursSince(t.retirada_em) > ALERTA_HORAS; }
  function daysLabel(iso) { var d = hoursSince(iso) / 24; return (d >= 10 ? Math.floor(d) : d.toFixed(1).replace(".", ",")) + " dias"; }
  function norm(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim(); }
  function initials(n) { var p = String(n || "?").trim().split(/\s+/); return ((p[0] || "")[0] + ((p.length > 1 ? p[p.length - 1] : "")[0] || "")).toUpperCase(); }
  function onlyDigits(s) { return String(s || "").replace(/\D/g, ""); }

  function toast(msg, ms) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove("show"); }, ms || 2600);
  }
  function errMsg(e) {
    var m = (e && (e.message || e.error_description || e.msg)) || String(e);
    if (/duplicate key.*codigo/i.test(m)) return "Já existe uma ferramenta com esse código.";
    if (/duplicate key.*matricula/i.test(m)) return "Já existe um funcionário com essa matrícula.";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Sem conexão com o servidor. Tente de novo.";
    return m;
  }

  var STATUS_LABEL = { disponivel: "Disponível", em_uso: "Em uso", manutencao: "Manutenção" };
  var STATUS_BADGE = { disponivel: "badge-good", em_uso: "badge-warn", manutencao: "badge-danger" };
  var ACTION_LABEL = { retirada: "Retirada", devolucao: "Devolução", manutencao_inicio: "Enviada p/ manutenção", manutencao_fim: "Manutenção concluída" };
  var ACTION_ICON = { retirada: "↗", devolucao: "↩", manutencao_inicio: "🔧", manutencao_fim: "✓" };

  /* ------------------------------------------------------------ estado */
  var S = { ferramentas: [], funcionarios: [], fornecedores: [], movimentacoes: [], incidentes: [], incidentesAtivos: false, user: null, papeis: [] };
  function tem(papeis) { papeis = [].concat(papeis); return S.papeis.some(function (p) { return papeis.indexOf(p) >= 0; }); }
  // Identificador de correlação desta sessão de página (vai no cabeçalho x-correlacao de toda requisição)
  var CORRELACAO = "s-" + uid();
  var listeners = [];
  function onChange(fn) { listeners.push(fn); }
  var emitT = null;
  function emit() { clearTimeout(emitT); emitT = setTimeout(function () { listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }, 30); }

  function funcById(id) { return S.funcionarios.find(function (f) { return f.id === id; }) || null; }
  function toolById(id) { return S.ferramentas.find(function (t) { return t.id === id; }) || null; }
  function toolByCode(code) { var c = norm(code); return S.ferramentas.find(function (t) { return norm(t.codigo) === c; }) || null; }
  function funcByMatricula(m) { var c = norm(m); return S.funcionarios.find(function (f) { return norm(f.matricula) === c; }) || null; }
  function holder(t) { return t && t.funcionario_id ? funcById(t.funcionario_id) : null; }
  function fmtWorker(f) { return f ? f.nome + " · mat. " + f.matricula : "—"; }
  function lateTools() {
    return S.ferramentas.filter(isLate).sort(function (a, b) { return new Date(a.retirada_em) - new Date(b.retirada_em); });
  }

  /* ------------------------------------------------------------ backend: Supabase */
  var sb = null;
  var Remote = {
    init: async function () {
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true },
        // ENVIAR_CORRELACAO=0 no Render desliga o cabeçalho caso algum proxy recuse cabeçalhos personalizados
        global: { headers: CFG.ENVIAR_CORRELACAO === false ? {} : { "x-correlacao": CORRELACAO } }
      });
      var r = await sb.auth.getSession();
      S.user = r.data && r.data.session ? r.data.session.user : null;
      sb.auth.onAuthStateChange(function (_ev, session) { S.user = session ? session.user : null; });
      return !!S.user;
    },
    signIn: async function (email, password) {
      var r = await sb.auth.signInWithPassword({ email: email, password: password });
      if (r.error) throw r.error;
      S.user = r.data.user;
    },
    signOut: async function () { await sb.auth.signOut(); S.user = null; S.papeis = []; },
    loadPapeis: async function () {
      var r = await sb.from("perfis").select("papel");
      if (r.error) throw r.error;
      S.papeis = (r.data || []).map(function (x) { return x.papel; });
      S.incidentesAtivos = true;   // quem só comunica não lista; se a função não existir, o erro aparece no envio
      return S.papeis;
    },
    // Evento declarado pela aplicação (lista fechada no servidor). Retorna true se gravado.
    auditar: async function (acao, recursoId, contexto, resultado) {
      var r = await sb.rpc("auditar_evento", { p_acao: acao, p_recurso_id: recursoId || null, p_contexto: contexto || {}, p_resultado: resultado || "sucesso" });
      if (r.error) throw r.error;
      return r.data === true;
    },
    consultarAuditoria: async function (f) {
      return this.rpcOk(await sb.rpc("consultar_auditoria", {
        p_de: f.de, p_ate: f.ate, p_acao: f.acao || null, p_categoria: f.categoria || null, p_resultado: f.resultado || null,
        p_recurso: f.recurso || null, p_recurso_id: f.recurso_id || null, p_ator_email: f.ator_email || null,
        p_correlacao: f.correlacao || null, p_antes_de: f.antes_de || null, p_limite: f.limite || 50
      }));
    },
    exportarAuditoria: async function (de, ate, finalidade) {
      return this.rpcOk(await sb.rpc("exportar_auditoria", { p_de: de, p_ate: ate, p_finalidade: finalidade }));
    },
    // Verifica a cadeia inteira em lotes de 20 000 eventos; para no primeiro erro
    verificarIntegridade: async function (onProgresso) {
      var desde = null, total = 0, r;
      do {
        r = await sb.rpc("verificar_integridade_auditoria", { p_a_partir_de: desde, p_lote: 20000 });
        if (r.error) throw r.error;
        r = r.data; if (r.erro) return r;
        total += r.eventos_verificados || 0; desde = r.proximo_a_partir_de;
        if (onProgresso) onProgresso(total);
      } while (r.ok && desde);
      r.eventos_verificados = total;
      return r;
    },
    confirmarAncora: async function (id, hash) {
      var r = await sb.rpc("confirmar_ancora_auditoria", { p_id: id, p_hash: hash });
      if (r.error) throw r.error;
      return r.data;
    },
    // RPCs que retornam {ok, erro}: recusa do servidor vira exceção legível
    rpcOk: function (r) {
      if (r.error) throw r.error;
      if (r.data && r.data.ok === false) throw new Error(r.data.erro || "Operação recusada pelo servidor");
      return r.data;
    },
    // movimentacoes: o caminho da assinatura NÃO é legível pelo cliente (privilégio por coluna)
    COLUNAS: { movimentacoes: "id,ferramenta_id,ferramenta_codigo,ferramenta_nome,acao,funcionario_id,funcionario_nome,matricula,site,observacao,usuario_email,usuario_id,tem_assinatura,created_at" },
    fetchAll: async function (table, order, asc, max) {
      var out = [], from = 0, step = 1000;
      while (true) {
        var q = sb.from(table).select(this.COLUNAS[table] || "*").order(order, { ascending: !!asc }).range(from, from + step - 1);
        var r = await q;
        if (r.error) throw r.error;
        out = out.concat(r.data);
        if (r.data.length < step || (max && out.length >= max)) break;
        from += step;
      }
      return out;
    },
    load: async function (which) {
      var all = !which;
      var jobs = [];
      if (all || which === "ferramentas") jobs.push(this.fetchAll("ferramentas", "codigo", true).then(function (d) { S.ferramentas = d; }));
      if (all || which === "funcionarios") jobs.push(this.fetchAll("funcionarios", "nome", true).then(function (d) { S.funcionarios = d; }));
      if (all || which === "fornecedores") jobs.push(this.fetchAll("fornecedores", "nome", true).then(function (d) { S.fornecedores = d; }));
      if (all || which === "movimentacoes") jobs.push(this.fetchAll("movimentacoes", "created_at", false, 1000).then(function (d) { S.movimentacoes = d; }));
      if ((all || which === "incidentes") && tem(["gestor", "encarregado", "auditor"])) jobs.push(this.listarIncidentes()
        .then(function (d) { S.incidentes = d; S.incidentesAtivos = true; })
        .catch(function (e) {
          var m = (e && (e.code || "") + " " + (e.message || "")) || "";
          if (/42P01|PGRST205|PGRST106|42501|does not exist|permission denied|Could not find/i.test(m)) { S.incidentes = []; S.incidentesAtivos = false; }   // 003 ausente ou revertida
          else toast("Não foi possível atualizar os incidentes (" + errMsg(e) + "). Os dados exibidos podem estar desatualizados.", 5000);
        }));
      await Promise.all(jobs);
      emit();
    },
    // ---- Registro de incidentes (Res. CD/ANPD 15/2024)
    listarIncidentes: async function () {
      var r = await sb.from("v_incidentes").select("*").order("numero", { ascending: false }).limit(500);
      if (r.error) throw r.error;
      return r.data;
    },
    detalheIncidente: async function (id) {
      var res = await Promise.all([
        sb.from("v_incidentes").select("*").eq("id", id).maybeSingle(),
        sb.from("incidentes_comunicacoes").select("*").eq("incidente_id", id).order("realizada_em"),
        sb.from("incidentes_historico").select("*").eq("incidente_id", id).order("id")
      ]);
      if (res[0].error) throw res[0].error;
      return { incidente: res[0].data, comunicacoes: res[1].data || [], historico: res[2].data || [] };
    },
    registrarIncidente: async function (titulo, descricao, detectado, ocorrido) {
      var d = this.rpcOk(await sb.rpc("registrar_incidente", { p_titulo: titulo, p_descricao: descricao || null, p_detectado_em: detectado || null, p_ocorrido_em: ocorrido || null }));
      await this.load("incidentes"); return d;
    },
    atualizarIncidente: async function (id, dados, comentario) {
      var d = this.rpcOk(await sb.rpc("atualizar_incidente", { p_id: id, p_dados: dados, p_comentario: comentario || null }));
      await this.load("incidentes"); return d;
    },
    registrarComunicacao: async function (id, dest, quando, meio, resumo, protocolo) {
      var d = this.rpcOk(await sb.rpc("registrar_comunicacao_incidente", { p_id: id, p_destinatario: dest, p_realizada_em: quando, p_meio: meio, p_resumo: resumo, p_protocolo: protocolo || null }));
      await this.load("incidentes"); return d;
    },
    encerrarIncidente: async function (id, motivo) { var d = this.rpcOk(await sb.rpc("encerrar_incidente", { p_id: id, p_motivo: motivo })); await this.load("incidentes"); return d; },
    reabrirIncidente: async function (id, motivo) { var d = this.rpcOk(await sb.rpc("reabrir_incidente", { p_id: id, p_motivo: motivo })); await this.load("incidentes"); return d; },
    lerConfigPrivacidade: async function () {
      var r = await sb.from("config_privacidade").select("*").maybeSingle();
      if (r.error) throw r.error; return r.data || {};
    },
    definirPequenoPorte: async function (valor, justificativa) {
      var d = this.rpcOk(await sb.rpc("definir_pequeno_porte", { p_valor: !!valor, p_justificativa: justificativa })); await this.load("incidentes"); return d;
    },
    subscribe: function () {
      var self = this, timers = {};
      var ch = sb.channel("almox-db");
      var tabs = ["ferramentas", "funcionarios", "fornecedores", "movimentacoes"];
      if (S.incidentesAtivos && tem(["gestor", "encarregado", "auditor"])) tabs.push("incidentes", "incidentes_comunicacoes");
      tabs.forEach(function (t) {
        var alvo = t === "incidentes_comunicacoes" ? "incidentes" : t;
        ch.on("postgres_changes", { event: "*", schema: "public", table: t }, function () {
          clearTimeout(timers[alvo]);
          timers[alvo] = setTimeout(function () { self.load(alvo).catch(console.error); }, 250);
        });
      });
      ch.subscribe();
      // rede de segurança caso o realtime caia
      setInterval(function () { if (!document.hidden) self.load().catch(function () {}); }, 120000);
      document.addEventListener("visibilitychange", function () { if (!document.hidden) self.load().catch(function () {}); });
    },
    ok: function (r) { if (r.error) throw r.error; return r.data; },
    saveFerramenta: async function (t) {
      var row = Object.assign({}, t); var id = row.id; delete row.id; delete row.created_at;
      if (id) this.ok(await sb.from("ferramentas").update(row).eq("id", id));
      else this.ok(await sb.from("ferramentas").insert(row));
      await this.load("ferramentas");
    },
    deleteFerramenta: async function (id) { this.ok(await sb.from("ferramentas").delete().eq("id", id)); await this.load("ferramentas"); },
    saveFornecedor: async function (f) {
      var row = Object.assign({}, f); var id = row.id; delete row.id; delete row.created_at;
      if (id) this.ok(await sb.from("fornecedores").update(row).eq("id", id));
      else this.ok(await sb.from("fornecedores").insert(row));
      await this.load("fornecedores");
    },
    deleteFornecedor: async function (id) { this.ok(await sb.from("fornecedores").delete().eq("id", id)); await this.load("fornecedores"); },
    saveFuncionario: async function (f) {
      var row = Object.assign({}, f); var id = row.id; delete row.id; delete row.created_at; delete row.updated_at;
      if (id) this.ok(await sb.from("funcionarios").update(row).eq("id", id));
      else this.ok(await sb.from("funcionarios").insert(row));
      await this.load("funcionarios");
    },
    deleteFuncionario: async function (id) { this.ok(await sb.from("funcionarios").delete().eq("id", id)); await this.load("funcionarios"); },
    upsertFuncionarios: async function (rows, deactivateIds, onProgress) {
      var chunk = 500;
      for (var i = 0; i < rows.length; i += chunk) {
        this.ok(await sb.from("funcionarios").upsert(rows.slice(i, i + chunk), { onConflict: "matricula" }));
        if (onProgress) onProgress(Math.min(i + chunk, rows.length), rows.length);
      }
      for (var j = 0; j < (deactivateIds || []).length; j += 200) {
        this.ok(await sb.from("funcionarios").update({ ativo: false }).in("id", deactivateIds.slice(j, j + 200)));
      }
      await this.load("funcionarios");
    },
    uploadAssinatura: async function (blob) {
      if (!blob) return null;
      var d = new Date();
      var path = d.getFullYear() + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + uid() + ".png";
      this.ok(await sb.storage.from("assinaturas").upload(path, blob, { contentType: "image/png", upsert: false }));
      return path;
    },
    // Visualização sempre passa pelo registro de auditoria; link temporário de 2 minutos
    assinaturaUrl: async function (mov) {
      var d = this.rpcOk(await sb.rpc("registrar_visualizacao_assinatura", { p_movimentacao: mov.id }));
      var r = await sb.storage.from("assinaturas").createSignedUrl(d.caminho, 120);
      if (r.error) throw r.error;
      return r.data.signedUrl;
    },
    retirar: async function (toolId, funcId, site, sigBlob, obs) {
      var path = await this.uploadAssinatura(sigBlob);
      this.rpcOk(await sb.rpc("retirar_ferramenta_v2", { p_ferramenta: toolId, p_funcionario: funcId, p_site: site || null, p_assinatura: path, p_obs: obs || null }));
      await Promise.all([this.load("ferramentas"), this.load("movimentacoes")]);
    },
    devolver: async function (toolId, sigBlob, obs) {
      var path = await this.uploadAssinatura(sigBlob);
      this.rpcOk(await sb.rpc("devolver_ferramenta_v2", { p_ferramenta: toolId, p_assinatura: path, p_obs: obs || null }));
      await Promise.all([this.load("ferramentas"), this.load("movimentacoes")]);
    },
    manutencao: async function (toolId, iniciar, obs) {
      this.rpcOk(await sb.rpc("manutencao_ferramenta_v2", { p_ferramenta: toolId, p_iniciar: !!iniciar, p_obs: obs || null }));
      await Promise.all([this.load("ferramentas"), this.load("movimentacoes")]);
    }
  };

  /* ------------------------------------------------------------ backend: demonstração (localStorage) */
  var LS_KEY = "almox_demo_v2";
  var Local = {
    init: async function () {
      var raw = null;
      try { raw = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (e) { }
      if (!raw) raw = this.seed();
      S.ferramentas = raw.ferramentas; S.funcionarios = raw.funcionarios;
      S.fornecedores = raw.fornecedores; S.movimentacoes = raw.movimentacoes;
      S.user = { email: "demonstracao@local" };
      this.save();
      return true;
    },
    seed: function () {
      var fn = [
        { matricula: "3021", nome: "Edivaldo dos Santos", funcao: "Pedreiro", setor: "Obra Muribeca", telefone: "81999990001" },
        { matricula: "1187", nome: "José Cláudio", funcao: "Eletricista", setor: "Obra Muribeca", telefone: "81999990002" },
        { matricula: "2044", nome: "Ricardo Alves", funcao: "Carpinteiro", setor: "Obra Muribeca", telefone: "" },
        { matricula: "0876", nome: "Wilson Berto", funcao: "Servente", setor: "Dois Irmãos", telefone: "" }
      ].map(function (f) { return Object.assign({ id: uid(), ativo: true, created_at: nowISO() }, f); });
      var byMat = {}; fn.forEach(function (f) { byMat[f.matricula] = f; });
      function T(codigo, nome, tipo, cls, forn, pat, site, status, mat, h, obs) {
        return { id: uid(), codigo: codigo, nome: nome, tipo: tipo, classificacao: cls, fornecedor: forn, patrimonio: pat, site: site,
          status: status, funcionario_id: mat ? byMat[mat].id : null, retirada_em: h != null ? hoursAgoISO(h) : null, observacoes: obs || "", created_at: nowISO() };
      }
      var ft = [
        T("FRT-001", "Furadeira Martelete SDS 65M", "Elétrica", "proprio", "Makita Brasil", "PAT-1102", "Almoxarifado Muribeca", "em_uso", "3021", 70),
        T("FRT-002", "Parafusadeira de Impacto 18V", "Elétrica", "proprio", "Makita Brasil", "PAT-1103", "Almoxarifado Muribeca", "disponivel"),
        T("FRT-003", "Jogo de Chaves Combinadas 6-22mm", "Manual", "proprio", "Tramontina Ferramentas", "PAT-0087", "Almoxarifado Muribeca", "disponivel"),
        T("FRT-004", "Alicate Universal 8\"", "Manual", "proprio", "Tramontina Ferramentas", "PAT-0091", "Almoxarifado Muribeca", "em_uso", "1187", 0.5),
        T("FRT-005", "Chave Ajustável 12\"", "Manual", "proprio", "Vonder Ferramentas", "PAT-0102", "Dois Irmãos", "disponivel"),
        T("FRT-006", "Betoneira 400L", "Equipamento", "alugado", "Vonder Ferramentas", "PAT-2201", "Dois Irmãos", "manutencao", null, null, "Motor com ruído — aguardando técnico"),
        T("FRT-007", "Nível a Laser", "Elétrica", "proprio", "Makita Brasil", "PAT-1140", "Almoxarifado Muribeca", "em_uso", "2044", 55),
        T("FRT-008", "Capacete de Segurança", "EPI", "proprio", "Vonder Ferramentas", "PAT-0500", "Dois Irmãos", "disponivel")
      ];
      var mv = [];
      ft.forEach(function (t) {
        if (t.status === "em_uso") {
          var f = funcById.call(null, t.funcionario_id) || fn.find(function (x) { return x.id === t.funcionario_id; });
          mv.push({ id: uid(), ferramenta_id: t.id, ferramenta_codigo: t.codigo, ferramenta_nome: t.nome, acao: "retirada", funcionario_id: f.id,
            funcionario_nome: f.nome, matricula: f.matricula, site: t.site, assinatura_path: null, created_at: t.retirada_em, usuario_email: "demonstracao@local" });
        }
      });
      mv.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
      return {
        ferramentas: ft, funcionarios: fn, movimentacoes: mv,
        fornecedores: [
          { id: uid(), nome: "Vonder Ferramentas", contato: "(81) 3231-4455" },
          { id: uid(), nome: "Makita Brasil", contato: "(11) 4004-8000" },
          { id: uid(), nome: "Tramontina Ferramentas", contato: "(54) 3457-3000" }
        ]
      };
    },
    save: function () {
      try { localStorage.setItem(LS_KEY, JSON.stringify({ ferramentas: S.ferramentas, funcionarios: S.funcionarios, fornecedores: S.fornecedores, movimentacoes: S.movimentacoes.slice(0, 1000) })); }
      catch (e) { }
      emit();
    },
    signIn: async function () { }, signOut: async function () { },
    load: async function () { emit(); },
    loadPapeis: async function () { S.papeis = ["almoxarife", "gestor", "auditor", "encarregado"]; S.incidentesAtivos = true; return S.papeis; },
    // ---- incidentes em memória (demonstração; mesmas regras principais do servidor)
    incs: [], incCom: [], incHist: [], pp: false,
    _vis: function (i) {
      var self = this, n = this.pp ? 6 : 3;
      var com = this.incCom.filter(function (c) { return c.incidente_id === i.id; });
      var anpd = com.filter(function (c) { return c.destinatario === "anpd"; })[0], tit = com.filter(function (c) { return c.destinatario === "titulares"; })[0];
      if (i.ciencia_em && i.pp_ciencia == null) i.pp_ciencia = this.pp;      // regime congelado na ciência
      var pp = i.pp_ciencia != null ? i.pp_ciencia : this.pp; n = pp ? 6 : 3;
      var prazo = prazoDiasUteis(i.ciencia_em, n);
      var pc = anpd ? prazoDiasUteis(anpd.realizada_em, pp ? 40 : 20) : null;
      return Object.assign({}, i, { agente_pequeno_porte: pp, prazo_anpd: prazo, prazo_titulares: prazo,
        prazo_complementacao: pc, dias_uteis_complementacao: pc && i.status !== "encerrado" ? diasUteisRestantes(pc) : null,
        comunicado_anpd_em: anpd ? anpd.realizada_em : null, comunicado_titulares_em: tit ? tit.realizada_em : null, comunicacoes: com.length,
        indicio_art5: !!i.afeta_significativamente && (i.criterios_art5 || []).length > 0,
        dias_uteis_para_prazo: (i.status === "encerrado" || !i.ciencia_em || i.avaliacao_risco === "sem_risco_relevante" || (anpd && tit)) ? null : diasUteisRestantes(prazo) });
    },
    _hist: function (id, acao, alt, com) { this.incHist.push({ id: this.incHist.length + 1, incidente_id: id, acao: acao, alteracoes: alt || {}, comentario: com || null, ator_email: "demonstracao@local", em: nowISO() }); },
    listarIncidentes: async function () { var self = this; return this.incs.map(function (i) { return self._vis(i); }).sort(function (a, b) { return b.numero - a.numero; }); },
    detalheIncidente: async function (id) {
      var i = this.incs.find(function (x) { return x.id === id; });
      return { incidente: i ? this._vis(i) : null, comunicacoes: this.incCom.filter(function (c) { return c.incidente_id === id; }),
               historico: this.incHist.filter(function (h) { return h.incidente_id === id; }) };
    },
    registrarIncidente: async function (titulo, descricao, detectado, ocorrido) {
      if (!titulo || titulo.trim().length < 3) throw new Error("Descreva o incidente em poucas palavras (título).");
      var i = { id: uid(), numero: this.incs.length + 1, titulo: titulo.trim(), descricao: descricao || null, status: "suspeita", origem: "manual",
        detectado_em: detectado || nowISO(), ocorrido_em: ocorrido || null, ciencia_em: null, sistemas_afetados: [], categorias_dados: [], categorias_titulares: [],
        criterios_art5: [], avaliacao_risco: "pendente", ancora_evento_id: this.eventos.length, ancora_hash: "demonstracao", criado_em: nowISO() };
      this.incs.push(i); this._hist(i.id, "registro", { origem: "manual" }); S.incidentes = await this.listarIncidentes(); emit();
      return { ok: true, id: i.id, numero: i.numero };
    },
    atualizarIncidente: async function (id, dados, comentario) {
      var i = this.incs.find(function (x) { return x.id === id; }); if (!i) throw new Error("Incidente não encontrado.");
      if (i.status === "encerrado") throw new Error("Incidente encerrado: reabra para alterar.");
      if (("avaliacao_risco" in dados && dados.avaliacao_risco !== i.avaliacao_risco) && (!comentario || comentario.trim().length < 10))
        throw new Error("Alterar a avaliação de risco exige justificativa (mín. 10 caracteres).");
      var alt = {}; Object.keys(dados).forEach(function (k) { if (JSON.stringify(i[k]) !== JSON.stringify(dados[k])) alt[k] = { de: i[k], para: dados[k] }; });
      Object.assign(i, dados); this._hist(id, "atualizacao", alt, comentario); S.incidentes = await this.listarIncidentes(); emit(); return { ok: true };
    },
    registrarComunicacao: async function (id, dest, quando, meio, resumo, protocolo) {
      if (!quando || new Date(quando) > new Date(Date.now() + 300000)) throw new Error("Informe a data/hora em que a comunicação foi feita (não futura).");
      this.incCom.push({ id: uid(), incidente_id: id, destinatario: dest, realizada_em: quando, meio: meio, resumo: resumo, protocolo: protocolo || null, registrado_em: nowISO() });
      this._hist(id, "comunicacao", { destinatario: dest }); S.incidentes = await this.listarIncidentes(); emit(); return { ok: true };
    },
    encerrarIncidente: async function (id, motivo) {
      var i = this.incs.find(function (x) { return x.id === id; });
      if (!motivo || motivo.trim().length < 10) throw new Error("Descreva o motivo do encerramento (mín. 10 caracteres).");
      if (!i.descricao || i.descricao.trim().length < 10 || !(i.categorias_dados || []).length || i.qtd_titulares == null)
        throw new Error("Preencha o conteúdo mínimo do art. 10: circunstâncias (II), categorias de dados — ou \"nenhum dado pessoal\" (III) — e número de titulares, que pode ser 0 (IV).");
      if (i.avaliacao_risco === "pendente") throw new Error("Conclua a avaliação de risco antes de encerrar (art. 10, V).");
      if (!i.justificativa_risco || i.justificativa_risco.trim().length < 10) throw new Error("Registre a justificativa da avaliação de risco (art. 10, V e VIII).");
      var v = this._vis(i);
      if (i.avaliacao_risco === "risco_relevante" && !(v.comunicado_anpd_em && v.comunicado_titulares_em)) throw new Error("Risco relevante: registre as comunicações à ANPD e aos titulares antes de encerrar.");
      i.status = "encerrado"; i.encerrado_em = nowISO(); i.motivo_encerramento = motivo; this._hist(id, "encerramento", {}, motivo);
      S.incidentes = await this.listarIncidentes(); emit(); return { ok: true };
    },
    reabrirIncidente: async function (id, motivo) {
      var i = this.incs.find(function (x) { return x.id === id; });
      if (!motivo || motivo.trim().length < 10) throw new Error("Descreva o motivo da reabertura (mín. 10 caracteres).");
      i.status = "em_analise"; i.encerrado_em = null; this._hist(id, "reabertura", {}, motivo); S.incidentes = await this.listarIncidentes(); emit(); return { ok: true };
    },
    lerConfigPrivacidade: async function () { return { agente_pequeno_porte: this.pp }; },
    definirPequenoPorte: async function (v) { this.pp = !!v; S.incidentes = await this.listarIncidentes(); emit(); return { ok: true }; },
    // Demonstração: auditoria apenas em memória (sem garantias de integridade)
    eventos: [],
    auditar: async function (acao, recursoId, contexto, resultado) {
      this.eventos.unshift({ id: this.eventos.length + 1, ocorrido_em: nowISO(), ator_email: "demonstracao@local", categoria: "aplicacao",
        acao: acao, criticidade: "baixa", recurso: null, recurso_id: recursoId || null, resultado: resultado || "sucesso",
        origem: "aplicacao", correlacao_id: CORRELACAO, contexto: contexto || {} });
      return true;
    },
    consultarAuditoria: async function (f) {
      var it = this.eventos.filter(function (e) {
        return (!f.acao || e.acao === f.acao) && (!f.resultado || e.resultado === f.resultado) && (!f.antes_de || e.id < f.antes_de);
      });
      var lim = f.limite || 50;
      return { ok: true, itens: it.slice(0, lim), proximo_antes_de: it.length > lim ? it[lim - 1].id : null };
    },
    exportarAuditoria: async function () { return { ok: true, itens: this.eventos.slice() }; },
    verificarIntegridade: async function () { return { ok: true, eventos_verificados: this.eventos.length, ultimo_id: this.eventos.length, ultimo_hash: "demonstracao-sem-hash" }; },
    confirmarAncora: async function () { return { ok: true, existe: true, mensagem: "Demonstração: âncoras não são verificadas." }; },
    subscribe: function () {
      window.addEventListener("storage", function (e) { if (e.key === LS_KEY) Local.init(); });
    },
    upsertList: function (list, obj, uniqueKey, label) {
      if (uniqueKey) {
        var dup = list.find(function (x) { return x.id !== obj.id && norm(x[uniqueKey]) === norm(obj[uniqueKey]); });
        if (dup) throw new Error("duplicate key " + uniqueKey);
      }
      if (obj.id) { var cur = list.find(function (x) { return x.id === obj.id; }); if (cur) Object.assign(cur, obj); }
      else list.push(Object.assign({ id: uid(), created_at: nowISO() }, obj));
    },
    saveFerramenta: async function (t) { this.upsertList(S.ferramentas, t, "codigo"); this.save(); },
    deleteFerramenta: async function (id) { S.ferramentas = S.ferramentas.filter(function (x) { return x.id !== id; }); this.save(); },
    saveFornecedor: async function (f) { this.upsertList(S.fornecedores, f); this.save(); },
    deleteFornecedor: async function (id) { S.fornecedores = S.fornecedores.filter(function (x) { return x.id !== id; }); this.save(); },
    saveFuncionario: async function (f) { if (f.ativo == null) f.ativo = true; this.upsertList(S.funcionarios, f, "matricula"); this.save(); },
    deleteFuncionario: async function (id) {
      S.funcionarios = S.funcionarios.filter(function (x) { return x.id !== id; });
      S.ferramentas.forEach(function (t) { if (t.funcionario_id === id) t.funcionario_id = null; });
      this.save();
    },
    upsertFuncionarios: async function (rows, deactivateIds, onProgress) {
      rows.forEach(function (r) {
        var cur = funcByMatricula(r.matricula);
        if (cur) Object.assign(cur, r); else S.funcionarios.push(Object.assign({ id: uid(), created_at: nowISO(), ativo: true }, r));
      });
      (deactivateIds || []).forEach(function (id) { var f = funcById(id); if (f) f.ativo = false; });
      if (onProgress) onProgress(rows.length, rows.length);
      S.funcionarios.sort(function (a, b) { return a.nome.localeCompare(b.nome); });
      this.save();
    },
    blobToDataUrl: function (blob) {
      return new Promise(function (res) { if (!blob) return res(null); var r = new FileReader(); r.onload = function () { res(r.result); }; r.readAsDataURL(blob); });
    },
    assinaturaUrl: async function (mov) { return mov.assinatura_path; },
    addMov: function (t, acao, f, sig, obs) {
      S.movimentacoes.unshift({ id: uid(), ferramenta_id: t.id, ferramenta_codigo: t.codigo, ferramenta_nome: t.nome, acao: acao,
        funcionario_id: f ? f.id : null, funcionario_nome: f ? f.nome : null, matricula: f ? f.matricula : null, site: t.site,
        assinatura_path: sig, tem_assinatura: !!sig, observacao: obs || null, usuario_email: "demonstracao@local", created_at: nowISO() });
    },
    retirar: async function (toolId, funcId, site, sigBlob, obs) {
      var t = toolById(toolId), f = funcById(funcId);
      if (!t) throw new Error("Ferramenta não encontrada");
      if (t.status !== "disponivel") throw new Error("A ferramenta " + t.codigo + " não está disponível");
      if (!f) throw new Error("Funcionário não encontrado");
      if (!f.ativo) throw new Error("Funcionário " + f.nome + " está inativo");
      var sig = await this.blobToDataUrl(sigBlob);
      Object.assign(t, { status: "em_uso", funcionario_id: f.id, retirada_em: nowISO(), site: site || t.site });
      this.addMov(t, "retirada", f, sig, obs); this.save();
    },
    devolver: async function (toolId, sigBlob, obs) {
      var t = toolById(toolId);
      if (!t || t.status !== "em_uso") throw new Error("A ferramenta não está em uso");
      var f = holder(t); var sig = await this.blobToDataUrl(sigBlob);
      Object.assign(t, { status: "disponivel", funcionario_id: null, retirada_em: null });
      this.addMov(t, "devolucao", f, sig, obs); this.save();
    },
    manutencao: async function (toolId, iniciar, obs) {
      var t = toolById(toolId);
      if (iniciar && t.status === "em_uso") throw new Error("Registre a devolução antes de enviar para manutenção");
      Object.assign(t, { status: iniciar ? "manutencao" : "disponivel", funcionario_id: null, retirada_em: null, observacoes: obs || t.observacoes });
      this.addMov(t, iniciar ? "manutencao_inicio" : "manutencao_fim", null, null, obs); this.save();
    }
  };

  var API = DEMO ? Local : Remote;

  /* ------------------------------------------------------------ boot + login */
  function loginScreen(onDone) {
    var root = document.createElement("div");
    root.className = "login-wrap"; root.id = "loginScreen";
    root.innerHTML =
      '<form class="card login-card" id="loginForm">' +
        '<div class="brand-mark">🧰</div>' +
        '<h1>Almoxarifado</h1>' +
        '<p class="muted small" style="margin:0 0 16px;">Entre com o usuário do almoxarife.</p>' +
        '<div class="form-grid">' +
          '<label class="field full">E-mail<input id="lg_email" type="email" required autocomplete="username"></label>' +
          '<label class="field full">Senha<input id="lg_pass" type="password" required autocomplete="current-password"></label>' +
        '</div>' +
        '<div class="form-error" id="lg_err"></div>' +
        '<button class="btn btn-primary btn-block" style="margin-top:8px;" type="submit">Entrar</button>' +
      '</form>';
    document.body.appendChild(root);
    document.getElementById("loginForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var btn = e.target.querySelector("button"); btn.disabled = true;
      document.getElementById("lg_err").textContent = "";
      try {
        await API.signIn(document.getElementById("lg_email").value.trim(), document.getElementById("lg_pass").value);
        root.remove(); onDone(true);
      } catch (err) {
        document.getElementById("lg_err").textContent = /Invalid login/i.test(err.message) ? "E-mail ou senha incorretos." : errMsg(err);
      } finally { btn.disabled = false; }
    });
  }

  function blockingScreen(title, html, withLogout) {
    var root = document.createElement("div");
    root.className = "login-wrap";
    root.innerHTML = '<div class="card login-card"><div class="brand-mark">🧰</div><h1 style="font-size:20px">' + esc(title) + '</h1>' +
      '<div class="small" style="line-height:1.5;margin-top:8px">' + html + '</div>' +
      (withLogout ? '<button class="btn btn-ghost btn-block" style="margin-top:16px" id="blkOut">Sair</button>' : "") + '</div>';
    document.body.appendChild(root);
    if (withLogout) root.querySelector("#blkOut").addEventListener("click", function () { API.signOut().then(function () { location.reload(); }); });
  }

  // Eventos de baixa criticidade: falha não bloqueia a operação, mas fica visível no console
  function auditarSilencioso(acao, recursoId, contexto) {
    return API.auditar(acao, recursoId, contexto).catch(function (e) { console.warn("[auditoria] evento não gravado:", acao, e && e.message); return false; });
  }
  // Eventos de alta criticidade (exportação/importação): se a auditoria falhar, a operação NÃO prossegue
  async function auditarObrigatorio(acao, recursoId, contexto) {
    var ok = false;
    try { ok = await API.auditar(acao, recursoId, contexto); } catch (e) { throw new Error("Não foi possível registrar a auditoria desta operação (" + errMsg(e) + "). Operação cancelada."); }
    if (!ok) throw new Error("Operação não autorizada para o seu perfil ou limite de registros excedido.");
    return true;
  }

  async function boot(onReady) {
    var appEl = document.querySelector(".app");
    if (appEl) appEl.hidden = true;
    if (MODO === "erro") {
      blockingScreen("Sistema não configurado", "As variáveis <strong>SUPABASE_URL</strong> e <strong>SUPABASE_ANON_KEY</strong> não foram definidas no servidor. " +
        "Por segurança o sistema não abre em modo de demonstração em produção. Avise o administrador.");
      return;
    }
    var start = async function (novoLogin) {
      try { await API.loadPapeis(); }
      catch (e) {   // falha de rede NÃO é "usuário sem perfil" (evita alerta falso na auditoria)
        blockingScreen("Não foi possível carregar seu perfil", "Verifique a conexão e recarregue a página. Detalhe: " + esc(errMsg(e)), true);
        return;
      }
      if (!S.papeis.length) {
        auditarSilencioso("login_sem_perfil");
        blockingScreen("Usuário sem perfil de acesso", "Seu login funcionou, mas nenhum perfil (almoxarife, gestor ou auditor) foi atribuído a <strong>" +
          esc(S.user && S.user.email) + "</strong>. Peça ao administrador para liberar o acesso.", true);
        return;
      }
      if (novoLogin === true) auditarSilencioso("login", null, { papeis: S.papeis });
      if (appEl) appEl.hidden = false;
      try { await API.load(); } catch (e) { toast("Erro ao carregar dados: " + errMsg(e), 5000); }
      API.subscribe();
      onReady();
    };
    var logged = false;
    try { logged = await API.init(); } catch (e) { console.error(e); }
    if (logged) start(false); else loginScreen(start);
  }
  async function logout() { await auditarSilencioso("logout"); await API.signOut(); location.reload(); }

  /* ------------------------------------------------------------ modal */
  var modalStack = [];
  function openModal(html, opts) {
    opts = opts || {};
    var root = document.getElementById("modalRoot");
    var wrap = document.createElement("div");
    wrap.className = "modal-overlay";
    wrap.innerHTML = '<div class="modal-card"' + (opts.wide ? ' style="max-width:720px"' : "") + '>' + html + "</div>";
    wrap.addEventListener("click", function (e) { if (e.target === wrap && !opts.sticky) closeModal(); });
    wrap.addEventListener("click", function (e) { if (e.target.closest("[data-close]")) closeModal(); });
    root.appendChild(wrap);
    modalStack.push({ el: wrap, onClose: opts.onClose });
    return wrap;
  }
  function closeModal() {
    var m = modalStack.pop();
    if (!m) return;
    m.el.remove();
    if (m.onClose) try { m.onClose(); } catch (e) { }
  }
  function modalHead(title) { return '<div class="modal-head"><h2>' + esc(title) + '</h2><button type="button" class="modal-close" data-close>✕</button></div>'; }
  function askConfirm(message, action, label) {
    var el = openModal(modalHead("Confirmar") +
      '<p style="font-size:14px;line-height:1.5;">' + esc(message) + '</p>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-close>Cancelar</button>' +
      '<button class="btn btn-danger" id="cfOk">' + esc(label || "Confirmar") + '</button></div>');
    el.querySelector("#cfOk").addEventListener("click", function () { closeModal(); action(); });
  }

  /* ------------------------------------------------------------ QR */
  function qrSvg(text) {
    try {
      var q = qrcode(0, "M"); q.addData(String(text)); q.make();
      return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) { return '<div class="mono" style="font-weight:700">' + esc(text) + "</div>"; }
  }
  var FUNC_PREFIX = "FUNC:";

  /* ------------------------------------------------------------ leitor de QR (câmera) */
  function Scanner(video, onCode) {
    var stream = null, active = false, timer = null, detector = null, canvas = document.createElement("canvas");
    var last = { text: "", at: 0 };
    async function start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Câmera não disponível neste navegador.");
      if (!window.isSecureContext) throw new Error("A câmera só funciona em HTTPS.");
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream; video.setAttribute("playsinline", ""); video.muted = true;
      try { await video.play(); } catch (e) { }
      if ("BarcodeDetector" in window) {
        try { detector = new window.BarcodeDetector({ formats: ["qr_code"] }); } catch (e) { detector = null; }
      }
      active = true; loop();
    }
    function stop() {
      active = false; clearTimeout(timer);
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null; video.srcObject = null;
    }
    function hit(text) {
      text = String(text || "").trim();
      if (!text) return false;
      if (text === last.text && Date.now() - last.at < 2500) return false;
      last = { text: text, at: Date.now() };
      return onCode(text) !== false;
    }
    async function loop() {
      if (!active) return;
      try {
        if (video.readyState >= 2) {
          if (detector) {
            var codes = await detector.detect(video);
            if (codes && codes.length && hit(codes[0].rawValue)) return;
          } else if (typeof jsQR === "function") {
            var w = video.videoWidth, h = video.videoHeight, sc = Math.min(1, 800 / Math.max(w, h));
            canvas.width = Math.round(w * sc); canvas.height = Math.round(h * sc);
            var ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            var r = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (r && r.data && hit(r.data)) return;
          }
        }
      } catch (e) { }
      timer = setTimeout(loop, 180);
    }
    return { start: start, stop: stop, get active() { return active; } };
  }
  function scannerMarkup(id) {
    return '<div class="scan-wrap"><video id="' + id + '" playsinline muted></video>' +
      '<div class="scan-frame"><i class="cnr cnr-tl"></i><i class="cnr cnr-tr"></i><i class="cnr cnr-bl"></i><i class="cnr cnr-br"></i></div></div>';
  }
  function beep() {
    try { if (navigator.vibrate) navigator.vibrate(80); } catch (e) { }
    try {
      var A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      var ctx = beep.ctx || (beep.ctx = new A()); var o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 1200; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.09);
    } catch (e) { }
  }

  /* modal que lê um QR (usado para crachá de funcionário) */
  function scanModal(title, onText) {
    var sc = null;
    var el = openModal(modalHead(title) + scannerMarkup("modalScanVideo") +
      '<div class="scan-status" id="modalScanStatus">Aponte a câmera para o QR.</div>', { onClose: function () { if (sc) sc.stop(); } });
    sc = Scanner(el.querySelector("#modalScanVideo"), function (text) {
      var ok = onText(text);
      if (ok !== false) { beep(); closeModal(); return true; }
      el.querySelector("#modalScanStatus").textContent = "QR não reconhecido: " + text;
      return false;
    });
    sc.start().catch(function (e) { el.querySelector("#modalScanStatus").textContent = e.message || "Não foi possível abrir a câmera."; });
  }

  /* ------------------------------------------------------------ assinatura */
  function SignaturePad(canvas) {
    var ctx = canvas.getContext("2d"), drawing = false, empty = true, lastPt = null, strokes = 0;
    function size() {
      var r = canvas.getBoundingClientRect(), dpr = Math.max(1, window.devicePixelRatio || 1);
      var data = empty ? null : canvas.toDataURL();
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#111"; ctx.lineWidth = 2.4;
      if (data) { var img = new Image(); img.onload = function () { ctx.drawImage(img, 0, 0, r.width, r.height); }; img.src = data; }
    }
    function pt(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    canvas.addEventListener("pointerdown", function (e) {
      e.preventDefault(); drawing = true; lastPt = pt(e); canvas.setPointerCapture(e.pointerId);
      ctx.beginPath(); ctx.arc(lastPt.x, lastPt.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = "#111"; ctx.fill();
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!drawing) return; e.preventDefault();
      var p = pt(e); ctx.beginPath(); ctx.moveTo(lastPt.x, lastPt.y);
      var mx = (lastPt.x + p.x) / 2, my = (lastPt.y + p.y) / 2;
      ctx.quadraticCurveTo(lastPt.x, lastPt.y, mx, my); ctx.lineTo(p.x, p.y); ctx.stroke();
      lastPt = p; empty = false;
    });
    function end() { if (drawing) { drawing = false; strokes++; if (api.onchange) api.onchange(); } }
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end); canvas.addEventListener("pointerleave", end);
    var api = {
      clear: function () { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore(); empty = true; strokes = 0; if (api.onchange) api.onchange(); },
      isEmpty: function () { return empty; },
      toBlob: function () {
        return new Promise(function (res) {
          if (empty) return res(null);
          // fundo branco + recorte (arquivo pequeno)
          var out = document.createElement("canvas"); out.width = canvas.width; out.height = canvas.height;
          var o = out.getContext("2d"); o.fillStyle = "#fff"; o.fillRect(0, 0, out.width, out.height); o.drawImage(canvas, 0, 0);
          out.toBlob(function (b) { res(b); }, "image/png");
        });
      },
      resize: size, onchange: null
    };
    size();
    window.addEventListener("resize", function () { if (document.body.contains(canvas)) size(); });
    return api;
  }
  function signatureMarkup(id, hint) {
    return '<div class="sig-box"><canvas id="' + id + '"></canvas><div class="sig-line"></div><div class="sig-hint">' + esc(hint || "Assine com o dedo acima da linha") + '</div></div>' +
      '<div class="sig-actions"><span id="' + id + '_st">Aguardando assinatura</span><button type="button" class="btn btn-outline btn-sm" id="' + id + '_clr">Limpar</button></div>';
  }
  function mountSignature(root, id) {
    var pad = SignaturePad(root.querySelector("#" + id));
    var st = root.querySelector("#" + id + "_st");
    root.querySelector("#" + id + "_clr").addEventListener("click", function () { pad.clear(); });
    var prev = null;
    pad.onchange = function () { st.textContent = pad.isEmpty() ? "Aguardando assinatura" : "✓ Assinado"; if (prev) prev(); };
    pad.setOnChange = function (fn) { prev = fn; };
    return pad;
  }

  /* ------------------------------------------------------------ seletor de funcionário */
  function funcionarioPicker(root, opts) {
    opts = opts || {};
    var selected = null;
    root.innerHTML =
      '<div class="row" style="gap:8px;flex-wrap:nowrap;">' +
        '<input class="search-input" data-q placeholder="Buscar por nome ou matrícula" autocomplete="off" style="min-width:0;">' +
        '<button type="button" class="btn btn-ghost" data-scan title="Ler QR do crachá">📷 Crachá</button>' +
      '</div>' +
      '<div class="picker-results" data-res></div>' +
      '<div data-novo hidden></div>' +
      '<div data-sel hidden></div>';
    var q = root.querySelector("[data-q]"), res = root.querySelector("[data-res]"), sel = root.querySelector("[data-sel]"), novo = root.querySelector("[data-novo]");
    var podeCadastrar = tem(["almoxarife", "gestor"]);
    function botaoNovo(term) {
      if (!podeCadastrar) return '<div class="muted small">Peça ao almoxarife ou gestor para cadastrar o funcionário.</div>';
      return '<button type="button" class="btn btn-ghost btn-block" data-novo-btn style="margin-top:6px">+ Cadastrar ' +
        (term ? '“' + esc(term) + '” como novo funcionário' : 'novo funcionário') + '</button>';
    }
    // Cadastro rápido sem sair da retirada (validação e auditoria ficam no servidor)
    function abrirCadastro(pref) {
      pref = pref || {};
      res.hidden = true; q.parentNode.hidden = true; novo.hidden = false;
      novo.innerHTML = '<div class="card" style="box-shadow:none;background:var(--surface-2)">' +
        '<div style="font-weight:700;margin-bottom:8px">Novo funcionário</div><div class="form-grid">' +
          '<label class="field full">Nome completo *<input data-f="nome" maxlength="200" autocomplete="off" value="' + esc(pref.nome || "") + '"></label>' +
          '<label class="field">Matrícula *<input data-f="matricula" maxlength="40" class="mono" autocomplete="off" inputmode="text" value="' + esc(pref.matricula || "") + '"></label>' +
          '<label class="field">Função<input data-f="funcao" maxlength="120" placeholder="Ex.: Pedreiro"></label>' +
          '<label class="field">Setor / obra<input data-f="setor" maxlength="120"></label>' +
          '<label class="field">Telefone (WhatsApp)<input data-f="telefone" maxlength="40" inputmode="tel" placeholder="81999999999"></label>' +
        '</div><div class="form-error" data-nerr></div>' +
        '<div class="row" style="margin-top:10px;justify-content:flex-end"><button type="button" class="btn btn-ghost" data-ncancel>Cancelar</button>' +
        '<button type="button" class="btn btn-primary" data-nsalvar>Cadastrar e usar</button></div></div>';
      var campo = function (k) { return novo.querySelector('[data-f="' + k + '"]'); };
      novo.addEventListener("input", function () { novo.querySelector("[data-nerr]").textContent = ""; });
      (pref.nome ? campo("matricula") : campo("nome")).focus();
      novo.querySelector("[data-ncancel]").addEventListener("click", function () { fecharCadastro(); q.focus(); });
      novo.querySelector("[data-nsalvar]").addEventListener("click", async function () {
        var b = this, err = novo.querySelector("[data-nerr]");
        var row = { nome: campo("nome").value.trim().replace(/\s+/g, " "), matricula: campo("matricula").value.trim(),
          funcao: campo("funcao").value.trim() || null, setor: campo("setor").value.trim() || null, telefone: campo("telefone").value.trim() || null, ativo: true };
        if (row.nome.length < 3) { err.textContent = "Informe o nome completo."; return; }
        if (!row.matricula) { err.textContent = "Informe a matrícula."; return; }
        var existente = funcByMatricula(row.matricula);
        if (existente) {
          if (existente.ativo === false) { err.textContent = "A matrícula " + row.matricula + " já existe (" + existente.nome + "), mas está inativa. Peça ao gestor para reativar."; return; }
          fecharCadastro(); choose(existente); toast("Matrícula já cadastrada: " + existente.nome + " selecionado."); return;
        }
        b.disabled = true; b.textContent = "Salvando…"; err.textContent = "";
        try {
          await API.saveFuncionario(row);
          var f = funcByMatricula(row.matricula);
          if (!f) throw new Error("Cadastro salvo, mas não foi possível carregá-lo. Busque pela matrícula.");
          fecharCadastro(); choose(f); toast("Funcionário cadastrado: " + f.nome);
          if (opts.onCadastro) opts.onCadastro(f);
        } catch (e) { err.textContent = errMsg(e); b.disabled = false; b.textContent = "Cadastrar e usar"; }
      });
    }
    function fecharCadastro() { novo.hidden = true; novo.innerHTML = ""; res.hidden = false; q.parentNode.hidden = false; draw(); }
    function prefDoTermo(t) { t = String(t || "").trim(); return /^[0-9A-Za-z.\-\/]+$/.test(t) && /\d/.test(t) ? { matricula: t } : { nome: t }; }
    function draw() {
      var term = norm(q.value), list = S.funcionarios.filter(function (f) { return f.ativo !== false; });
      if (term) list = list.filter(function (f) { return norm(f.nome).indexOf(term) >= 0 || norm(f.matricula).indexOf(term) >= 0; });
      var total = list.length; list = list.slice(0, 30);
      if (!S.funcionarios.length) { res.innerHTML = '<div class="muted small">Nenhum funcionário cadastrado ainda. Importe a planilha na aba Funcionários ou cadastre agora.</div>' + botaoNovo(q.value.trim()); return; }
      res.innerHTML = list.map(function (f) {
        var n = S.ferramentas.filter(function (t) { return t.funcionario_id === f.id; }).length;
        return '<button type="button" class="picker-item" data-id="' + f.id + '"><span class="av">' + esc(initials(f.nome)) + '</span>' +
          '<span class="info"><span class="name">' + esc(f.nome) + '</span><br><span class="meta mono">mat. ' + esc(f.matricula) + '</span>' +
          '<span class="meta">' + (f.funcao ? " · " + esc(f.funcao) : "") + (n ? " · " + n + " ferramenta(s) em posse" : "") + '</span></span></button>';
      }).join("") + (total > 30 ? '<div class="muted small">+' + (total - 30) + ' — refine a busca</div>' : "") +
        (!total ? '<div class="muted small">Nenhum funcionário encontrado' + (q.value.trim() ? ' para “' + esc(q.value.trim()) + '”' : '') + '.</div>' : "") +
        botaoNovo(total ? "" : q.value.trim());
    }
    function choose(f) {
      selected = f;
      if (!f) { sel.hidden = true; res.hidden = false; q.parentNode.hidden = false; draw(); if (opts.onSelect) opts.onSelect(null); return; }
      var late = S.ferramentas.filter(function (t) { return t.funcionario_id === f.id && isLate(t); });
      sel.innerHTML = '<div class="picked"><span class="av">' + esc(initials(f.nome)) + '</span>' +
        '<div class="info" style="flex:1;min-width:0;"><div style="font-weight:700;">' + esc(f.nome) + '</div>' +
        '<div class="small muted mono">mat. ' + esc(f.matricula) + (f.funcao ? " · " + esc(f.funcao) : "") + '</div></div>' +
        '<button type="button" class="btn btn-outline btn-sm" data-change>Trocar</button></div>' +
        (late.length ? '<div class="late-box">⚠ Este funcionário já está com ' + late.length + ' ferramenta(s) há mais de ' + (ALERTA_HORAS / 24) + ' dias: ' + late.map(function (t) { return esc(t.codigo); }).join(", ") + '</div>' : "");
      sel.hidden = false; res.hidden = true; q.parentNode.hidden = true;
      sel.querySelector("[data-change]").addEventListener("click", function () { choose(null); q.focus(); });
      if (opts.onSelect) opts.onSelect(f);
    }
    q.addEventListener("input", draw);
    res.addEventListener("click", function (e) {
      if (e.target.closest("[data-novo-btn]")) return abrirCadastro(prefDoTermo(q.value));
      var b = e.target.closest("[data-id]"); if (b) choose(funcById(b.dataset.id));
    });
    root.querySelector("[data-scan]").addEventListener("click", function () {
      scanModal("Ler crachá do funcionário", function (text) {
        var m = text.indexOf(FUNC_PREFIX) === 0 ? text.slice(FUNC_PREFIX.length) : text;
        var f = funcByMatricula(m);
        if (!f) {
          if (!podeCadastrar) { toast("Matrícula " + m + " não cadastrada"); return false; }
          setTimeout(function () { abrirCadastro({ matricula: m }); }, 0);    // crachá novo: cadastra com a matrícula lida
          toast("Matrícula " + m + " não cadastrada — complete o cadastro.", 3500);
          return true;
        }
        if (f.ativo === false) { toast(f.nome + " está inativo. Peça ao gestor para reativar."); return false; }
        choose(f); return true;
      });
    });
    draw();
    return { get: function () { return selected; }, set: choose };
  }

  /* ------------------------------------------------------------ fluxos de retirada / devolução */
  function openCheckout(tool, done) {
    var el = openModal(modalHead("Retirar ferramenta") +
      '<p class="small muted" style="margin:0 0 12px;"><strong style="color:var(--ink)">' + esc(tool.nome) + '</strong> <span class="mono">(' + esc(tool.codigo) + ')</span></p>' +
      '<div class="section-title" style="margin-top:0">1. Funcionário</div><div id="coPicker"></div>' +
      '<div class="section-title">2. Assinatura do funcionário</div>' + signatureMarkup("coSig") +
      '<div class="form-grid" style="margin-top:12px;">' +
        '<label class="field">Almoxarifado / obra<input id="coSite" value="' + esc(tool.site || "") + '"></label>' +
        '<label class="field">Observação<input id="coObs" placeholder="Opcional"></label>' +
      '</div>' +
      '<div class="form-error" id="coErr"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-close>Cancelar</button>' +
      '<button class="btn btn-primary" id="coOk" disabled>Confirmar retirada</button></div>', { sticky: true });
    var okBtn = el.querySelector("#coOk");
    var pad = mountSignature(el, "coSig");
    var picker = funcionarioPicker(el.querySelector("#coPicker"), { onSelect: upd });
    function upd() { okBtn.disabled = !(picker.get() && !pad.isEmpty()); }
    pad.setOnChange(upd);
    okBtn.addEventListener("click", async function () {
      okBtn.disabled = true; okBtn.textContent = "Salvando…";
      try {
        var blob = await pad.toBlob();
        await API.retirar(tool.id, picker.get().id, el.querySelector("#coSite").value.trim(), blob, el.querySelector("#coObs").value.trim());
        var f = picker.get(); closeModal(); toast("Retirada registrada — " + f.nome); if (done) done(f);
      } catch (e) { el.querySelector("#coErr").textContent = errMsg(e); okBtn.disabled = false; okBtn.textContent = "Confirmar retirada"; }
    });
  }

  function openReturn(tool, done) {
    var f = holder(tool);
    var el = openModal(modalHead("Registrar devolução") +
      '<p class="small" style="margin:0 0 4px;"><strong>' + esc(tool.nome) + '</strong> <span class="mono muted">(' + esc(tool.codigo) + ')</span></p>' +
      '<p class="small muted" style="margin:0 0 12px;">Com ' + esc(fmtWorker(f)) + ' · ' + fmtElapsed(tool.retirada_em) + '</p>' +
      (isLate(tool) ? '<div class="late-box" style="margin:0 0 12px;">⚠ Ficou ' + daysLabel(tool.retirada_em) + ' com o funcionário</div>' : "") +
      '<div class="section-title" style="margin-top:0">Assinatura de quem devolve <span style="text-transform:none;letter-spacing:0;font-weight:500">(opcional)</span></div>' +
      signatureMarkup("dvSig") +
      '<label class="field" style="margin-top:12px;">Observação / estado da ferramenta<input id="dvObs" placeholder="Ex.: devolvida sem a broca"></label>' +
      '<div class="form-error" id="dvErr"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-close>Cancelar</button>' +
      '<button class="btn btn-good" id="dvOk">Confirmar devolução</button></div>', { sticky: true });
    var pad = mountSignature(el, "dvSig");
    var okBtn = el.querySelector("#dvOk");
    okBtn.addEventListener("click", async function () {
      okBtn.disabled = true; okBtn.textContent = "Salvando…";
      try {
        await API.devolver(tool.id, await pad.toBlob(), el.querySelector("#dvObs").value.trim());
        closeModal(); toast("Devolução registrada"); if (done) done();
      } catch (e) { el.querySelector("#dvErr").textContent = errMsg(e); okBtn.disabled = false; okBtn.textContent = "Confirmar devolução"; }
    });
  }

  async function showSignature(mov) {
    var el = openModal(modalHead("Assinatura") +
      '<p class="small muted" style="margin:0 0 12px;">' + esc(ACTION_LABEL[mov.acao] || mov.acao) + ' · ' + esc(mov.ferramenta_nome) +
      ' · ' + esc(mov.funcionario_nome || "") + (mov.matricula ? " (mat. " + esc(mov.matricula) + ")" : "") + ' · ' + fmtDateTime(mov.created_at) + '</p>' +
      '<div id="sigHolder" class="muted small" style="text-align:center;padding:20px;">Carregando…</div>');
    try {
      var url = await API.assinaturaUrl(mov);
      el.querySelector("#sigHolder").innerHTML = '<img class="sig-img" alt="Assinatura" src="' + esc(url) + '">';
    } catch (e) { el.querySelector("#sigHolder").textContent = "Não foi possível abrir: " + errMsg(e); }
  }

  function waLink(f, tool) {
    var tel = onlyDigits(f && f.telefone);
    if (!tel) return null;
    if (tel.length <= 11) tel = "55" + tel;
    var msg = "Olá " + f.nome.split(" ")[0] + ", a ferramenta " + tool.nome + " (" + tool.codigo + ") está com você desde " +
      fmtDateTime(tool.retirada_em) + ". Por favor, devolva ao almoxarifado ou procure o almoxarife.";
    return "https://wa.me/" + tel + "?text=" + encodeURIComponent(msg);
  }

  /* ------------------------------------------------------------ comunicar incidente (qualquer perfil) */
  function isoParaLocal(iso) { if (!iso) return ""; var d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
  function localParaIso(v) { return v ? new Date(v).toISOString() : null; }
  function openReportIncident(depois) {
    if (!S.incidentesAtivos) return toast("O registro de incidentes ainda não foi ativado no banco (migração 003).", 4500);
    var el = openModal(modalHead("Comunicar incidente de segurança") +
      '<p class="small muted" style="margin:0 0 12px">Use para qualquer suspeita: aparelho perdido, senha vazada, acesso de quem não deveria, dados enviados para a pessoa errada, sistema fora do ar… ' +
      'O encarregado/gestor avalia. <strong>Não coloque aqui dados pessoais além do necessário.</strong></p>' +
      '<div class="form-grid">' +
        '<label class="field full">O que aconteceu? (resumo)<input id="ri_t" maxlength="200" placeholder="Ex.: celular do almoxarifado perdido"></label>' +
        '<label class="field full">Detalhes<textarea id="ri_d" rows="4" maxlength="4000" placeholder="Quando, onde, como percebeu, o que pode ter sido exposto"></textarea></label>' +
        '<label class="field">Quando percebeu<input type="datetime-local" id="ri_det" value="' + isoParaLocal(new Date().toISOString()) + '"></label>' +
        '<label class="field">Quando ocorreu (se souber)<input type="datetime-local" id="ri_oc"></label>' +
      '</div><div class="form-error" id="ri_err"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-danger" id="ri_ok">Registrar comunicação</button></div>', { sticky: true });
    el.querySelector("#ri_ok").addEventListener("click", async function () {
      var b = this; b.disabled = true;
      try {
        var r = await API.registrarIncidente(el.querySelector("#ri_t").value.trim(), el.querySelector("#ri_d").value.trim(),
          localParaIso(el.querySelector("#ri_det").value), localParaIso(el.querySelector("#ri_oc").value));
        closeModal(); toast("Incidente nº " + r.numero + " registrado. O responsável foi informado pelo painel.", 4500);
        if (depois) depois(r);
      } catch (e) { el.querySelector("#ri_err").textContent = errMsg(e); b.disabled = false; }
    });
  }

  /* ------------------------------------------------------------ export */
  window.Almox = {
    CFG: CFG, DEMO: DEMO, ALERTA_HORAS: ALERTA_HORAS, S: S, API: API,
    STATUS_LABEL: STATUS_LABEL, STATUS_BADGE: STATUS_BADGE, ACTION_LABEL: ACTION_LABEL, ACTION_ICON: ACTION_ICON, FUNC_PREFIX: FUNC_PREFIX,
    uid: uid, esc: esc, fmtDateTime: fmtDateTime, fmtElapsed: fmtElapsed, hoursSince: hoursSince, isLate: isLate, daysLabel: daysLabel,
    norm: norm, initials: initials, toast: toast, errMsg: errMsg,
    funcById: funcById, toolById: toolById, toolByCode: toolByCode, funcByMatricula: funcByMatricula, holder: holder, fmtWorker: fmtWorker, lateTools: lateTools,
    onChange: onChange, boot: boot, logout: logout, tem: tem, MODO: MODO, CORRELACAO: CORRELACAO,
    auditarSilencioso: auditarSilencioso, auditarObrigatorio: auditarObrigatorio,
    openModal: openModal, closeModal: closeModal, modalHead: modalHead, askConfirm: askConfirm,
    qrSvg: qrSvg, Scanner: Scanner, scannerMarkup: scannerMarkup, scanModal: scanModal, beep: beep,
    SignaturePad: SignaturePad, signatureMarkup: signatureMarkup, mountSignature: mountSignature, funcionarioPicker: funcionarioPicker,
    openCheckout: openCheckout, openReturn: openReturn, showSignature: showSignature, waLink: waLink,
    openReportIncident: openReportIncident, isoParaLocal: isoParaLocal, localParaIso: localParaIso, prazoDiasUteis: prazoDiasUteis, diasUteisRestantes: diasUteisRestantes
  };
})();
