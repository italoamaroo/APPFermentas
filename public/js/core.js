/* =====================================================================
   Almoxarifado — núcleo compartilhado (painel e app do celular)
   - Camada de dados: Supabase (produção) ou localStorage (modo demonstração)
   - Componentes: modal, toast, QR, leitor de QR, assinatura, seletor de funcionário
   ===================================================================== */
(function () {
  "use strict";

  var CFG = window.APP_CONFIG || {};
  var DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
  var ALERTA_HORAS = Number(CFG.ALERTA_HORAS) || 48;

  /* ------------------------------------------------------------ helpers */
  function uid() { return (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)); }
  function nowISO() { return new Date().toISOString(); }
  function hoursAgoISO(h) { return new Date(Date.now() - h * 3600 * 1000).toISOString(); }
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
  var S = { ferramentas: [], funcionarios: [], fornecedores: [], movimentacoes: [], user: null };
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
        auth: { persistSession: true, autoRefreshToken: true }
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
    signOut: async function () { await sb.auth.signOut(); S.user = null; },
    fetchAll: async function (table, order, asc, max) {
      var out = [], from = 0, step = 1000;
      while (true) {
        var q = sb.from(table).select("*").order(order, { ascending: !!asc }).range(from, from + step - 1);
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
      await Promise.all(jobs);
      emit();
    },
    subscribe: function () {
      var self = this, timers = {};
      var ch = sb.channel("almox-db");
      ["ferramentas", "funcionarios", "fornecedores", "movimentacoes"].forEach(function (t) {
        ch.on("postgres_changes", { event: "*", schema: "public", table: t }, function () {
          clearTimeout(timers[t]);
          timers[t] = setTimeout(function () { self.load(t).catch(console.error); }, 250);
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
    assinaturaUrl: async function (path) {
      if (!path) return null;
      if (/^data:/.test(path)) return path;
      var r = await sb.storage.from("assinaturas").createSignedUrl(path, 600);
      if (r.error) throw r.error;
      return r.data.signedUrl;
    },
    retirar: async function (toolId, funcId, site, sigBlob, obs) {
      var path = await this.uploadAssinatura(sigBlob);
      this.ok(await sb.rpc("retirar_ferramenta", { p_ferramenta: toolId, p_funcionario: funcId, p_site: site || null, p_assinatura: path, p_obs: obs || null }));
      await Promise.all([this.load("ferramentas"), this.load("movimentacoes")]);
    },
    devolver: async function (toolId, sigBlob, obs) {
      var path = await this.uploadAssinatura(sigBlob);
      this.ok(await sb.rpc("devolver_ferramenta", { p_ferramenta: toolId, p_assinatura: path, p_obs: obs || null }));
      await Promise.all([this.load("ferramentas"), this.load("movimentacoes")]);
    },
    manutencao: async function (toolId, iniciar, obs) {
      this.ok(await sb.rpc("manutencao_ferramenta", { p_ferramenta: toolId, p_iniciar: !!iniciar, p_obs: obs || null }));
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
    assinaturaUrl: async function (p) { return p; },
    addMov: function (t, acao, f, sig, obs) {
      S.movimentacoes.unshift({ id: uid(), ferramenta_id: t.id, ferramenta_codigo: t.codigo, ferramenta_nome: t.nome, acao: acao,
        funcionario_id: f ? f.id : null, funcionario_nome: f ? f.nome : null, matricula: f ? f.matricula : null, site: t.site,
        assinatura_path: sig, observacao: obs || null, usuario_email: "demonstracao@local", created_at: nowISO() });
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
        root.remove(); onDone();
      } catch (err) {
        document.getElementById("lg_err").textContent = /Invalid login/i.test(err.message) ? "E-mail ou senha incorretos." : errMsg(err);
      } finally { btn.disabled = false; }
    });
  }

  async function boot(onReady) {
    var appEl = document.querySelector(".app");
    if (appEl) appEl.hidden = true;
    var start = async function () {
      if (appEl) appEl.hidden = false;
      try { await API.load(); } catch (e) { toast("Erro ao carregar dados: " + errMsg(e), 5000); }
      API.subscribe();
      onReady();
    };
    var logged = false;
    try { logged = await API.init(); } catch (e) { console.error(e); }
    if (logged) start(); else loginScreen(start);
  }
  async function logout() { await API.signOut(); location.reload(); }

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
      '<div data-sel hidden></div>';
    var q = root.querySelector("[data-q]"), res = root.querySelector("[data-res]"), sel = root.querySelector("[data-sel]");
    function draw() {
      var term = norm(q.value), list = S.funcionarios.filter(function (f) { return f.ativo !== false; });
      if (term) list = list.filter(function (f) { return norm(f.nome).indexOf(term) >= 0 || norm(f.matricula).indexOf(term) >= 0; });
      var total = list.length; list = list.slice(0, 30);
      if (!S.funcionarios.length) { res.innerHTML = '<div class="muted small">Nenhum funcionário cadastrado. Importe a planilha na aba Funcionários.</div>'; return; }
      res.innerHTML = list.map(function (f) {
        var n = S.ferramentas.filter(function (t) { return t.funcionario_id === f.id; }).length;
        return '<button type="button" class="picker-item" data-id="' + f.id + '"><span class="av">' + esc(initials(f.nome)) + '</span>' +
          '<span class="info"><span class="name">' + esc(f.nome) + '</span><br><span class="meta mono">mat. ' + esc(f.matricula) + '</span>' +
          '<span class="meta">' + (f.funcao ? " · " + esc(f.funcao) : "") + (n ? " · " + n + " ferramenta(s) em posse" : "") + '</span></span></button>';
      }).join("") + (total > 30 ? '<div class="muted small">+' + (total - 30) + ' — refine a busca</div>' : "") +
        (!total ? '<div class="muted small">Nenhum funcionário encontrado.</div>' : "");
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
    res.addEventListener("click", function (e) { var b = e.target.closest("[data-id]"); if (b) choose(funcById(b.dataset.id)); });
    root.querySelector("[data-scan]").addEventListener("click", function () {
      scanModal("Ler crachá do funcionário", function (text) {
        var m = text.indexOf(FUNC_PREFIX) === 0 ? text.slice(FUNC_PREFIX.length) : text;
        var f = funcByMatricula(m);
        if (!f) { toast("Matrícula " + m + " não cadastrada"); return false; }
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
      var url = await API.assinaturaUrl(mov.assinatura_path);
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

  /* ------------------------------------------------------------ export */
  window.Almox = {
    CFG: CFG, DEMO: DEMO, ALERTA_HORAS: ALERTA_HORAS, S: S, API: API,
    STATUS_LABEL: STATUS_LABEL, STATUS_BADGE: STATUS_BADGE, ACTION_LABEL: ACTION_LABEL, ACTION_ICON: ACTION_ICON, FUNC_PREFIX: FUNC_PREFIX,
    uid: uid, esc: esc, fmtDateTime: fmtDateTime, fmtElapsed: fmtElapsed, hoursSince: hoursSince, isLate: isLate, daysLabel: daysLabel,
    norm: norm, initials: initials, toast: toast, errMsg: errMsg,
    funcById: funcById, toolById: toolById, toolByCode: toolByCode, funcByMatricula: funcByMatricula, holder: holder, fmtWorker: fmtWorker, lateTools: lateTools,
    onChange: onChange, boot: boot, logout: logout,
    openModal: openModal, closeModal: closeModal, modalHead: modalHead, askConfirm: askConfirm,
    qrSvg: qrSvg, Scanner: Scanner, scannerMarkup: scannerMarkup, scanModal: scanModal, beep: beep,
    SignaturePad: SignaturePad, signatureMarkup: signatureMarkup, mountSignature: mountSignature, funcionarioPicker: funcionarioPicker,
    openCheckout: openCheckout, openReturn: openReturn, showSignature: showSignature, waLink: waLink
  };
})();
