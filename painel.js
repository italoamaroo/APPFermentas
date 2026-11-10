/* =====================================================================
   Almoxarifado — Painel (desktop / tablet)
   ===================================================================== */
(function () {
  "use strict";
  var A = window.Almox, S = A.S, esc = A.esc;

  var TABS = ["painel", "escanear", "ferramentas", "funcionarios", "etiquetas", "historico", "fornecedores", "incidentes", "auditoria"];
  var currentTab = "painel";
  var currentSite = "all";
  try { currentSite = localStorage.getItem("almox_site") || "all"; } catch (e) { }

  function siteTools() { return currentSite === "all" ? S.ferramentas : S.ferramentas.filter(function (t) { return t.site === currentSite; }); }
  function siteMovs() { return currentSite === "all" ? S.movimentacoes : S.movimentacoes.filter(function (m) { return m.site === currentSite; }); }
  function sites() { var o = {}; S.ferramentas.forEach(function (t) { if (t.site) o[t.site] = 1; }); return Object.keys(o).sort(); }
  function $(id) { return document.getElementById(id); }
  function on(el, ev, sel, fn) { el.addEventListener(ev, function (e) { var t = e.target.closest(sel); if (t && el.contains(t)) fn(t, e); }); }
  function nextCode() {
    var max = 0;
    S.ferramentas.forEach(function (t) { var m = /^FRT-(\d+)$/i.exec(t.codigo || ""); if (m) max = Math.max(max, parseInt(m[1], 10)); });
    return "FRT-" + String(max + 1).padStart(3, "0");
  }
  // Planilhas: read-excel-file / write-excel-file (substituem o SheetJS 0.18.5 — CVE-2023-30533)
  async function lerXlsx(file) {
    if (typeof window.readXlsxFile !== "function") throw new Error("Leitor de planilhas não carregou");
    var res = await window.readXlsxFile(file);
    if (Array.isArray(res) && res.length && res[0] && !Array.isArray(res[0]) && Array.isArray(res[0].data)) res = res[0].data;
    return (res || []).map(function (row) { return (row || []).map(function (v) { return v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v); }); });
  }
  function lerCsv(texto) {
    texto = String(texto || "").replace(/^\uFEFF/, "");
    var primeira = texto.split(/\r?\n/)[0] || "";
    var sep = (primeira.split(";").length > primeira.split(",").length) ? ";" : ",";
    var rows = [], row = [], cell = "", q = false;
    for (var i = 0; i < texto.length; i++) {
      var c = texto[i];
      if (q) { if (c === '"') { if (texto[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === sep) { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && texto[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  async function salvarXlsx(linhas, nomeArquivo) {
    if (typeof window.writeXlsxFile !== "function") throw new Error("Gerador de planilhas não carregou");
    // células sempre como texto/número: nunca fórmula (evita injeção de fórmulas no Excel)
    var data = linhas.map(function (r) { return r.map(function (v) { return { value: v == null ? "" : (typeof v === "number" ? v : String(v)), type: typeof v === "number" ? Number : String }; }); });
    var w = window.writeXlsxFile(data, { fileName: nomeArquivo });
    if (w && typeof w.toFile === "function") await w.toFile(nomeArquivo); else await w;
  }

  async function run(promise, okMsg) {
    try { await promise; if (okMsg) A.toast(okMsg); return true; }
    catch (e) { A.toast(A.errMsg(e), 4500); return false; }
  }

  /* ================================================================ PAINEL */
  var Painel = {
    build: function (el) {
      el.innerHTML = '<div id="pnInc"></div><div id="pnStats"></div><div id="pnAlert"></div>' +
        '<div class="quick-row" style="margin-top:16px;">' +
          '<button class="btn btn-primary" data-go="escanear">🔎 Escanear ferramenta</button>' +
          '<button class="btn btn-ghost op-only" id="pnNew">+ Cadastrar ferramenta</button>' +
          '<button class="btn btn-ghost" data-go="etiquetas">🏷️ Imprimir etiquetas</button>' +
        '</div>' +
        '<div class="section-title">Em uso agora</div><div id="pnUso"></div>' +
        '<div class="section-title">Atividade recente</div><div id="pnHist"></div>' +
        '<div id="pnTop"></div>';
      on(el, "click", "[data-go]", function (b) { setTab(b.dataset.go); });
      on(el, "click", "[data-inc]", function (b) { setTab("incidentes"); abrirIncidente(b.dataset.inc); });
      $("pnNew").addEventListener("click", function () { toolForm(null); });
      on(el, "click", "[data-ret]", function (b) { var t = A.toolById(b.dataset.ret); if (t) A.openReturn(t); });
      on(el, "click", "[data-notif]", function () {
        if (!("Notification" in window)) return A.toast("Este navegador não suporta notificações");
        Notification.requestPermission().then(function () { Painel.update(); notifyLate(true); });
      });
      on(el, "click", "[data-sig]", function (b) { var m = S.movimentacoes.find(function (x) { return x.id === b.dataset.sig; }); if (m) A.showSignature(m); });
    },
    update: function () {
      $("pnInc").innerHTML = incidentesAlertaHtml();
      var tools = siteTools();
      var c = { total: tools.length, disp: 0, uso: 0, man: 0 };
      tools.forEach(function (t) { if (t.status === "disponivel") c.disp++; else if (t.status === "em_uso") c.uso++; else c.man++; });
      var late = A.lateTools().filter(function (t) { return currentSite === "all" || t.site === currentSite; });
      $("pnStats").innerHTML = '<div class="stat-grid five">' +
        '<div class="stat-card"><div class="num mono">' + c.total + '</div><div class="lbl">Ferramentas</div></div>' +
        '<div class="stat-card good"><div class="num mono">' + c.disp + '</div><div class="lbl">Disponíveis</div></div>' +
        '<div class="stat-card warn"><div class="num mono">' + c.uso + '</div><div class="lbl">Em uso</div></div>' +
        '<div class="stat-card danger"><div class="num mono">' + c.man + '</div><div class="lbl">Manutenção</div></div>' +
        '<div class="stat-card ' + (late.length ? "alert" : "") + '"><div class="num mono">' + late.length + '</div><div class="lbl">+' + (A.ALERTA_HORAS / 24) + ' dias c/ funcionário</div></div>' +
      '</div>';

      var ah = "";
      if (late.length) {
        var canNotify = "Notification" in window && Notification.permission === "default";
        ah = '<div class="alert-card"><h3>⚠ ' + late.length + ' ferramenta(s) há mais de ' + (A.ALERTA_HORAS / 24) + ' dias com o mesmo funcionário</h3>' +
          '<p>Cobre a devolução ou registre a renovação (devolver e retirar de novo).' + (canNotify ? ' <button class="btn btn-outline btn-sm" data-notif>🔔 Ativar avisos no navegador</button>' : "") + '</p>' +
          late.map(function (t) {
            var f = A.holder(t), wa = A.waLink(f, t);
            return '<div class="alert-row"><span class="days-pill">' + A.daysLabel(t.retirada_em) + '</span>' +
              '<div class="info"><div class="name">' + esc(t.nome) + ' <span class="mono muted" style="font-weight:500">' + esc(t.codigo) + '</span></div>' +
              '<div class="meta">com <strong>' + esc(A.fmtWorker(f)) + '</strong> · desde ' + A.fmtDateTime(t.retirada_em) + (t.site ? " · " + esc(t.site) : "") + '</div></div>' +
              (wa ? '<a class="btn btn-outline btn-sm op-only" target="_blank" rel="noopener" data-wa="' + t.id + '" href="' + esc(wa) + '">WhatsApp</a>' : "") +
              '<button class="btn btn-good btn-sm op-only" data-ret="' + t.id + '">Devolver</button></div>';
          }).join("") + '</div>';
      }
      $("pnAlert").innerHTML = ah;

      var emUso = tools.filter(function (t) { return t.status === "em_uso"; }).sort(function (a, b) { return new Date(b.retirada_em || 0) - new Date(a.retirada_em || 0); });
      $("pnUso").innerHTML = !emUso.length ? '<div class="card empty"><span class="ic">✅</span>Nenhuma ferramenta em uso neste almoxarifado.</div>' :
        '<div class="list">' + emUso.map(function (t) {
          var late = A.isLate(t);
          return '<div class="tool-row"' + (late ? ' style="border-color:var(--danger)"' : "") + '><div class="info"><div class="name">' + esc(t.nome) +
            (late ? ' <span class="badge badge-late">' + A.daysLabel(t.retirada_em) + '</span>' : "") + '</div>' +
            '<div class="meta">com <strong>' + esc(A.fmtWorker(A.holder(t))) + '</strong> · ' + A.fmtElapsed(t.retirada_em) + ' · <span class="mono">' + esc(t.codigo) + '</span></div></div>' +
            '<button class="btn btn-good btn-sm op-only" data-ret="' + t.id + '">Devolver</button></div>';
        }).join("") + '</div>';

      var hist = siteMovs().slice(0, 6);
      $("pnHist").innerHTML = !hist.length ? '<div class="card empty"><span class="ic">🕓</span>Nenhuma movimentação registrada ainda.</div>' :
        '<div class="card"><div class="list">' + hist.map(function (h) { return histRow(h, false); }).join("") + '</div></div>';

      var count = {}, names = {};
      siteMovs().forEach(function (m) { if (m.acao === "retirada") { count[m.ferramenta_codigo] = (count[m.ferramenta_codigo] || 0) + 1; names[m.ferramenta_codigo] = m.ferramenta_nome; } });
      var top = Object.keys(count).map(function (k) { return { k: k, n: count[k] }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 3);
      $("pnTop").innerHTML = !top.length ? "" : '<div class="section-title">Mais utilizadas</div><div class="card"><div class="list">' + top.map(function (u) {
        return '<div style="display:flex;justify-content:space-between;font-size:13.5px;"><span>' + esc(names[u.k] || u.k) + '</span><strong class="mono">' + u.n + 'x</strong></div>';
      }).join("") + '</div></div>';
    }
  };

  function histRow(h, full) {
    var cls = h.acao === "retirada" ? "badge-warn" : h.acao === "devolucao" ? "badge-good" : "badge-danger";
    var who = h.funcionario_nome ? h.funcionario_nome + (h.matricula ? " · mat. " + h.matricula : "") : "Sistema";
    return '<div class="hist-row"><div class="hist-ic ' + cls + '" style="background:var(--surface-2);">' + (A.ACTION_ICON[h.acao] || "•") + '</div>' +
      '<div style="flex:1;min-width:0;">' +
        (full ? '<div style="font-size:13px;font-weight:600;">' + esc(h.ferramenta_nome) + ' <span class="mono" style="color:var(--muted);font-weight:500;">' + esc(h.ferramenta_codigo || "") + '</span></div>' +
                '<div style="font-size:12px;color:var(--muted);">' + (A.ACTION_LABEL[h.acao] || h.acao) + (h.funcionario_nome ? " · " + esc(who) : "") + (h.site ? " · " + esc(h.site) : "") +
                (h.observacao ? " · “" + esc(h.observacao) + "”" : "") + (h.usuario_email ? " · por " + esc(h.usuario_email) : "") + '</div>'
              : '<div style="font-size:13px;font-weight:600;">' + esc(who) + ' · ' + (A.ACTION_LABEL[h.acao] || h.acao) + '</div>' +
                '<div style="font-size:12px;color:var(--muted);">' + esc(h.ferramenta_nome) + ' · ' + A.fmtDateTime(h.created_at) + '</div>') +
      '</div>' +
      (h.tem_assinatura ? '<button class="btn btn-outline btn-sm sig-only" data-sig="' + h.id + '" title="Ver assinatura (acesso registrado)">✍️</button>' : "") +
      (full ? '<div class="mono" style="font-size:11.5px;color:var(--muted);white-space:nowrap;">' + A.fmtDateTime(h.created_at) + '</div>' : "") +
    '</div>';
  }

  /* notificação do navegador para alertas novos */
  function notifyLate(force) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    var seen = {};
    try { seen = JSON.parse(sessionStorage.getItem("almox_notified") || "{}"); } catch (e) { }
    var fresh = A.lateTools().filter(function (t) { return force || !seen[t.id + t.retirada_em]; });
    if (!fresh.length) return;
    fresh.forEach(function (t) { seen[t.id + t.retirada_em] = 1; });
    try { sessionStorage.setItem("almox_notified", JSON.stringify(seen)); } catch (e) { }
    var body = fresh.slice(0, 4).map(function (t) { var f = A.holder(t); return t.codigo + " com " + (f ? f.nome : "?") + " (" + A.daysLabel(t.retirada_em) + ")"; }).join("\n");
    try { new Notification("Almoxarifado: " + fresh.length + " ferramenta(s) há mais de " + (A.ALERTA_HORAS / 24) + " dias", { body: body, icon: "icons/icon-192.png", tag: "almox-late" }); } catch (e) { }
  }

  /* ================================================================ ESCANEAR */
  var scanner = null, selectedId = null;
  var Escanear = {
    build: function (el) {
      el.innerHTML =
        '<div class="card" style="max-width:460px;margin:0 auto;">' + A.scannerMarkup("scanVideo") +
          '<div class="scan-status" id="scanStatus">Toque em "Iniciar câmera" para escanear o QR da ferramenta.</div>' +
          '<div class="scan-controls"><button class="btn btn-primary" id="scanToggle">Iniciar câmera</button></div>' +
          '<div class="divider-or">ou</div>' +
          '<form id="manualForm"><label class="field full">Código da ferramenta<input id="manualCode" class="mono" list="codeList" placeholder="Ex.: FRT-001" autocomplete="off"></label>' +
          '<datalist id="codeList"></datalist><button type="submit" class="btn btn-ghost btn-block" style="margin-top:10px;">Buscar ferramenta</button></form>' +
        '</div><div id="scanResult" style="max-width:460px;margin:16px auto 0;"></div>';
      scanner = A.Scanner($("scanVideo"), function (text) {
        var t = A.toolByCode(text);
        if (!t) { $("scanStatus").textContent = "QR lido (" + text + ") não corresponde a nenhuma ferramenta."; return false; }
        A.beep(); selectedId = t.id; stopScan(); Escanear.update(); return true;
      });
      $("scanToggle").addEventListener("click", function () {
        if (scanner.active) return stopScan();
        $("scanStatus").textContent = "Abrindo câmera…";
        scanner.start().then(function () { $("scanToggle").textContent = "Parar câmera"; $("scanStatus").textContent = "Procurando código…"; })
          .catch(function (e) { $("scanStatus").textContent = (e && e.message) || "Não foi possível acessar a câmera — use a busca manual."; });
      });
      $("manualForm").addEventListener("submit", function (e) {
        e.preventDefault();
        var code = $("manualCode").value.trim(); if (!code) return;
        var t = A.toolByCode(code);
        if (t) { selectedId = t.id; stopScan(); Escanear.update(); }
        else {
          selectedId = null;
          $("scanResult").innerHTML = '<div class="card"><p style="font-size:13.5px;">Nenhuma ferramenta com o código <span class="mono">' + esc(code) + '</span>.</p>' +
            '<button class="btn btn-primary btn-block" id="newWithCode">Cadastrar esta ferramenta</button></div>';
          $("newWithCode").addEventListener("click", function () { toolForm({ codigo: code }); });
        }
      });
      on($("scanResult"), "click", "[data-act]", function (b) {
        var t = A.toolById(selectedId); if (!t) return;
        var act = b.dataset.act;
        if (act === "out") A.openCheckout(t, function () { selectedId = null; Escanear.update(); });
        else if (act === "back") A.openReturn(t, function () { selectedId = null; Escanear.update(); });
        else if (act === "maint") run(A.API.manutencao(t.id, false), "Manutenção concluída").then(function () { selectedId = null; Escanear.update(); });
        else if (act === "clear") { selectedId = null; Escanear.update(); }
      });
    },
    update: function () {
      $("codeList").innerHTML = S.ferramentas.map(function (t) { return '<option value="' + esc(t.codigo) + '">' + esc(t.nome) + '</option>'; }).join("");
      var t = selectedId && A.toolById(selectedId);
      $("scanResult").innerHTML = t ? toolCard(t) : "";
    }
  };
  function stopScan() {
    if (scanner) scanner.stop();
    var b = $("scanToggle"); if (b) b.textContent = "Iniciar câmera";
  }
  function toolCard(t) {
    var f = A.holder(t);
    var h = '<div class="card result-detail">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">' +
        '<div><div class="name">' + esc(t.nome) + '</div><div class="mono" style="color:var(--muted);font-size:12.5px;">' + esc(t.codigo) + '</div></div>' +
        '<span class="badge ' + A.STATUS_BADGE[t.status] + '">' + A.STATUS_LABEL[t.status] + '</span></div>' +
      '<dl class="kv"><dt>Patrimônio</dt><dd>' + esc(t.patrimonio || "—") + '</dd><dt>Tipo</dt><dd>' + esc(t.tipo || "—") + '</dd>' +
        '<dt>Fornecedor</dt><dd>' + esc(t.fornecedor || "—") + '</dd><dt>Almoxarifado</dt><dd>' + esc(t.site || "—") + '</dd>' +
        (t.status === "em_uso" ? '<dt>Com</dt><dd>' + esc(A.fmtWorker(f)) + ' · ' + A.fmtElapsed(t.retirada_em) + '</dd>' : "") +
        (t.observacoes ? '<dt>Nota</dt><dd>' + esc(t.observacoes) + '</dd>' : "") +
      '</dl>' +
      (A.isLate(t) ? '<div class="late-box">⚠ Há ' + A.daysLabel(t.retirada_em) + ' com o mesmo funcionário</div>' : "");
    if (t.status === "disponivel") h += '<button class="btn btn-primary btn-block op-only" style="margin-top:14px;" data-act="out">Retirar ferramenta</button>';
    else if (t.status === "em_uso") h += '<button class="btn btn-good btn-block op-only" style="margin-top:14px;" data-act="back">Registrar devolução</button>';
    else h += '<button class="btn btn-outline btn-block op-only" style="margin-top:14px;" data-act="maint">Concluir manutenção</button>';
    return h + '<button class="btn btn-ghost btn-block" style="margin-top:8px;" data-act="clear">Escanear outra ferramenta</button></div>';
  }

  /* ================================================================ FERRAMENTAS */
  var ferF = { q: "", status: "todos" };
  var Ferramentas = {
    build: function (el) {
      el.innerHTML = '<div class="toolbar">' +
        '<input class="search-input" id="ferSearch" placeholder="Buscar por nome, código ou patrimônio">' +
        '<select class="select-input" id="ferStatus"><option value="todos">Todos os status</option><option value="disponivel">Disponível</option>' +
        '<option value="em_uso">Em uso</option><option value="atrasada">Em uso +' + (A.ALERTA_HORAS / 24) + ' dias</option><option value="manutencao">Manutenção</option></select>' +
        '<button class="btn btn-primary op-only" id="ferNew">+ Nova</button></div><div id="ferList"></div>';
      $("ferSearch").addEventListener("input", function (e) { ferF.q = e.target.value; Ferramentas.update(); });
      $("ferStatus").addEventListener("change", function (e) { ferF.status = e.target.value; Ferramentas.update(); });
      $("ferNew").addEventListener("click", function () { toolForm(null); });
      on($("ferList"), "click", "[data-a]", function (b) {
        var t = A.toolById(b.dataset.id); if (!t) return;
        var a = b.dataset.a;
        if (a === "qr") qrModal(t);
        else if (a === "edit") toolForm(t);
        else if (a === "label") { Etq.mode = "ferramentas"; Etq.sel = {}; Etq.sel[t.id] = 1; setTab("etiquetas"); }
        else if (a === "maint") {
          if (t.status === "em_uso") return A.toast("Registre a devolução antes de enviar para manutenção");
          run(A.API.manutencao(t.id, t.status !== "manutencao"), t.status === "manutencao" ? "Manutenção concluída" : "Enviada para manutenção");
        }
        else if (a === "del") A.askConfirm('Excluir "' + t.nome + '"? O histórico é mantido.', function () { run(A.API.deleteFerramenta(t.id), "Ferramenta excluída"); }, "Excluir");
        else if (a === "out") A.openCheckout(t);
        else if (a === "back") A.openReturn(t);
      });
    },
    update: function () {
      var q = A.norm(ferF.q);
      var list = siteTools().filter(function (t) {
        var okQ = !q || [t.nome, t.codigo, t.patrimonio].some(function (v) { return A.norm(v).indexOf(q) >= 0; });
        var okS = ferF.status === "todos" || (ferF.status === "atrasada" ? A.isLate(t) : t.status === ferF.status);
        return okQ && okS;
      }).sort(function (a, b) { return (a.codigo || "").localeCompare(b.codigo || ""); });
      $("ferList").innerHTML = !list.length ? '<div class="card empty"><span class="ic">🧰</span>Nenhuma ferramenta encontrada.</div>' :
        '<div class="list">' + list.map(function (t) {
          var late = A.isLate(t), f = A.holder(t);
          return '<div class="tool-row tool-row-wrap" style="align-items:flex-start;' + (late ? "border-color:var(--danger)" : "") + '"><div class="info">' +
            '<div class="name">' + esc(t.nome) + '</div>' +
            '<div class="meta mono">' + esc(t.codigo) + (t.patrimonio ? ' · ' + esc(t.patrimonio) : '') + '</div>' +
            (t.status === "em_uso" ? '<div class="meta">com <strong>' + esc(A.fmtWorker(f)) + '</strong> · ' + A.fmtElapsed(t.retirada_em) + '</div>' : "") +
            '<div class="tag-row"><span class="badge ' + A.STATUS_BADGE[t.status] + '">' + A.STATUS_LABEL[t.status] + '</span>' +
              (late ? '<span class="badge badge-late">' + A.daysLabel(t.retirada_em) + '</span>' : "") +
              '<span class="tag">' + esc(t.tipo || "—") + '</span><span class="tag">' + (t.classificacao === "alugado" ? "Alugado" : "Próprio") + '</span>' +
              (t.site ? '<span class="tag">' + esc(t.site) + '</span>' : "") + '</div></div>' +
            '<div class="tool-actions">' +
              (t.status === "disponivel" ? '<button class="btn btn-primary btn-sm op-only" data-a="out" data-id="' + t.id + '">Retirar</button>' : "") +
              (t.status === "em_uso" ? '<button class="btn btn-good btn-sm op-only" data-a="back" data-id="' + t.id + '">Devolver</button>' : "") +
              '<button class="btn btn-outline btn-sm" data-a="qr" data-id="' + t.id + '">QR</button>' +
              '<button class="btn btn-outline btn-sm op-only" data-a="label" data-id="' + t.id + '">Etiqueta</button>' +
              '<button class="btn btn-outline btn-sm op-only" data-a="edit" data-id="' + t.id + '">Editar</button>' +
              '<button class="btn btn-outline btn-sm op-only" data-a="maint" data-id="' + t.id + '">' + (t.status === "manutencao" ? "Concluir" : "Manutenção") + '</button>' +
              '<button class="btn btn-danger btn-sm gestor-only" data-a="del" data-id="' + t.id + '">Excluir</button>' +
            '</div></div>';
        }).join("") + '</div>';
    }
  };

  function toolForm(existing) {
    var isEdit = !!(existing && existing.id);
    var t = Object.assign({ codigo: nextCode(), nome: "", tipo: "Manual", classificacao: "proprio", fornecedor: "", patrimonio: "", site: currentSite !== "all" ? currentSite : "", observacoes: "" }, existing || {});
    var el = A.openModal(A.modalHead(isEdit ? "Editar ferramenta" : "Nova ferramenta") +
      '<form id="toolForm"><div class="form-grid">' +
        '<label class="field full">Nome<input required id="tf_nome" value="' + esc(t.nome) + '" placeholder="Ex.: Furadeira de Impacto 650W"></label>' +
        '<label class="field">Código (vai no QR)<input required id="tf_codigo" class="mono" value="' + esc(t.codigo) + '"></label>' +
        '<label class="field">Patrimônio<input id="tf_pat" value="' + esc(t.patrimonio || "") + '" placeholder="PAT-0000"></label>' +
        '<label class="field">Tipo<select id="tf_tipo">' + ["Manual", "Elétrica", "Equipamento", "EPI", "Medição"].map(function (o) { return '<option' + (t.tipo === o ? " selected" : "") + '>' + o + '</option>'; }).join("") + '</select></label>' +
        '<label class="field">Classificação<select id="tf_class"><option value="proprio"' + (t.classificacao === "proprio" ? " selected" : "") + '>Próprio</option><option value="alugado"' + (t.classificacao === "alugado" ? " selected" : "") + '>Alugado</option></select></label>' +
        '<label class="field">Fornecedor<input id="tf_forn" list="dlForn" value="' + esc(t.fornecedor || "") + '"></label>' +
        '<label class="field">Almoxarifado<input id="tf_site" list="dlSite" value="' + esc(t.site || "") + '" placeholder="Ex.: Almoxarifado Muribeca"></label>' +
        '<label class="field full">Observações<textarea id="tf_obs" rows="2" placeholder="Opcional">' + esc(t.observacoes || "") + '</textarea></label>' +
      '</div>' +
      '<datalist id="dlSite">' + sites().map(function (s) { return '<option value="' + esc(s) + '">'; }).join("") + '</datalist>' +
      '<datalist id="dlForn">' + S.fornecedores.map(function (s) { return '<option value="' + esc(s.nome) + '">'; }).join("") + '</datalist>' +
      '<div class="form-error" id="tfErr"></div>' +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button type="submit" class="btn btn-primary">' + (isEdit ? "Salvar alterações" : "Cadastrar ferramenta") + '</button></div></form>');
    el.querySelector("#toolForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var row = {
        nome: $("tf_nome").value.trim(), codigo: $("tf_codigo").value.trim().toUpperCase(), patrimonio: $("tf_pat").value.trim(),
        tipo: $("tf_tipo").value, classificacao: $("tf_class").value, fornecedor: $("tf_forn").value.trim(), site: $("tf_site").value.trim(), observacoes: $("tf_obs").value.trim()
      };
      if (!row.nome || !row.codigo) return;
      if (isEdit) row.id = t.id; else row.status = "disponivel";
      try { await A.API.saveFerramenta(row); A.closeModal(); A.toast(isEdit ? "Ferramenta atualizada" : "Ferramenta cadastrada"); }
      catch (err) { $("tfErr").textContent = A.errMsg(err); }
    });
  }

  function qrModal(t) {
    var el = A.openModal(A.modalHead("QR da ferramenta") +
      '<div class="qr-label"><div class="qr-box" style="width:200px;height:200px;">' + A.qrSvg(t.codigo) + '</div>' +
      '<div style="margin-top:12px;font-weight:700;font-size:14px;">' + esc(t.nome) + '</div>' +
      '<div class="mono" style="font-size:13px;color:var(--muted);margin-top:2px;">' + esc(t.codigo) + (t.patrimonio ? " · " + esc(t.patrimonio) : "") + '</div>' +
      '<button class="btn btn-primary" style="margin-top:14px;" id="qrPrint">🏷️ Imprimir etiqueta 70×25</button></div>');
    el.querySelector("#qrPrint").addEventListener("click", function () { A.closeModal(); Etq.mode = "ferramentas"; Etq.sel = {}; Etq.sel[t.id] = 1; setTab("etiquetas"); });
  }

  /* ================================================================ FUNCIONÁRIOS */
  var funF = { q: "", status: "ativos" };
  var importState = null;
  var Funcionarios = {
    build: function (el) {
      el.innerHTML = '<div class="toolbar">' +
        '<input class="search-input" id="funSearch" placeholder="Buscar por nome, matrícula, função ou setor">' +
        '<select class="select-input" id="funStatus"><option value="ativos">Ativos</option><option value="posse">Com ferramenta</option><option value="atraso">Com atraso (+' + (A.ALERTA_HORAS / 24) + ' dias)</option><option value="inativos">Inativos</option><option value="todos">Todos</option></select>' +
        '<button class="btn btn-ghost op-only" id="funImport">⬆ Importar planilha</button>' +
        '<button class="btn btn-primary op-only" id="funNew">+ Novo</button></div>' +
        '<div id="funImportBox"></div><div id="funList"></div>';
      $("funSearch").addEventListener("input", function (e) { funF.q = e.target.value; Funcionarios.update(); });
      $("funStatus").addEventListener("change", function (e) { funF.status = e.target.value; Funcionarios.update(); });
      $("funNew").addEventListener("click", function () { funcForm(null); });
      $("funImport").addEventListener("click", function () { importState = importState ? null : { step: "pick" }; drawImport(); });
      on($("funList"), "click", "[data-a]", function (b) {
        var f = A.funcById(b.dataset.id); if (!f) return;
        var a = b.dataset.a;
        if (a === "edit") funcForm(f);
        else if (a === "view") funcDetail(f);
        else if (a === "badge") { Etq.mode = "funcionarios"; Etq.sel = {}; Etq.sel[f.id] = 1; setTab("etiquetas"); }
        else if (a === "del") {
          if (S.ferramentas.some(function (t) { return t.funcionario_id === f.id; })) return A.toast("Este funcionário está com ferramentas. Registre a devolução antes.");
          A.askConfirm("Excluir " + f.nome + "? (Se preferir, apenas desative pela edição.)", function () { run(A.API.deleteFuncionario(f.id), "Funcionário excluído"); }, "Excluir");
        }
      });
    },
    update: function () {
      var q = A.norm(funF.q);
      var posse = {}, atraso = {};
      S.ferramentas.forEach(function (t) { if (t.funcionario_id) { (posse[t.funcionario_id] = posse[t.funcionario_id] || []).push(t); if (A.isLate(t)) atraso[t.funcionario_id] = (atraso[t.funcionario_id] || 0) + 1; } });
      var list = S.funcionarios.filter(function (f) {
        if (funF.status === "ativos" && f.ativo === false) return false;
        if (funF.status === "inativos" && f.ativo !== false) return false;
        if (funF.status === "posse" && !posse[f.id]) return false;
        if (funF.status === "atraso" && !atraso[f.id]) return false;
        return !q || [f.nome, f.matricula, f.funcao, f.setor].some(function (v) { return A.norm(v).indexOf(q) >= 0; });
      });
      var total = list.length; list = list.slice(0, 300);
      var head = '<div class="small muted" style="margin:0 0 8px;">' + total + ' funcionário(s)' + (total > 300 ? " — mostrando os 300 primeiros, use a busca" : "") + '</div>';
      $("funList").innerHTML = !S.funcionarios.length ?
        '<div class="card empty"><span class="ic">👷</span>Nenhum funcionário cadastrado.<br><button class="btn btn-primary" style="margin-top:12px" onclick="document.getElementById(\'funImport\').click()">Importar planilha de funcionários</button></div>' :
        !total ? '<div class="card empty"><span class="ic">🔍</span>Nenhum funcionário encontrado.</div>' :
        head + '<div class="list">' + list.map(function (f) {
          var p = posse[f.id] || [], late = atraso[f.id] || 0;
          return '<div class="tool-row tool-row-wrap"' + (late ? ' style="border-color:var(--danger)"' : "") + '>' +
            '<span class="av">' + esc(A.initials(f.nome)) + '</span>' +
            '<div class="info" style="flex:1 1 200px;"><div class="name">' + esc(f.nome) + '</div>' +
              '<div class="meta"><span class="mono">mat. ' + esc(f.matricula) + '</span>' + (f.funcao ? " · " + esc(f.funcao) : "") + (f.setor ? " · " + esc(f.setor) : "") + (f.telefone ? " · " + esc(f.telefone) : "") + '</div>' +
              '<div class="tag-row">' + (f.ativo === false ? '<span class="badge badge-danger">Inativo</span>' : '<span class="badge badge-good">Ativo</span>') +
                (p.length ? '<span class="badge badge-warn">' + p.length + ' em posse</span>' : "") +
                (late ? '<span class="badge badge-late">' + late + ' há +' + (A.ALERTA_HORAS / 24) + ' dias</span>' : "") + '</div></div>' +
            '<div class="tool-actions">' +
              '<button class="btn btn-outline btn-sm" data-a="view" data-id="' + f.id + '">Ver</button>' +
              '<button class="btn btn-outline btn-sm" data-a="badge" data-id="' + f.id + '">Crachá QR</button>' +
              '<button class="btn btn-outline btn-sm op-only" data-a="edit" data-id="' + f.id + '">Editar</button>' +
              '<button class="btn btn-danger btn-sm gestor-only" data-a="del" data-id="' + f.id + '">Excluir</button></div></div>';
        }).join("") + '</div>';
    }
  };

  function funcForm(existing) {
    var isEdit = !!existing;
    var f = Object.assign({ matricula: "", nome: "", funcao: "", setor: "", telefone: "", ativo: true }, existing || {});
    var el = A.openModal(A.modalHead(isEdit ? "Editar funcionário" : "Novo funcionário") +
      '<form id="funForm"><div class="form-grid">' +
        '<label class="field full">Nome completo<input required id="ff_nome" value="' + esc(f.nome) + '"></label>' +
        '<label class="field">Matrícula<input required id="ff_mat" class="mono" value="' + esc(f.matricula) + '"></label>' +
        '<label class="field">Telefone (WhatsApp)<input id="ff_tel" value="' + esc(f.telefone || "") + '" placeholder="81999999999"></label>' +
        '<label class="field">Função<input id="ff_funcao" value="' + esc(f.funcao || "") + '"></label>' +
        '<label class="field">Setor / obra<input id="ff_setor" value="' + esc(f.setor || "") + '"></label>' +
        '<label class="chk full"><input type="checkbox" id="ff_ativo"' + (f.ativo !== false ? " checked" : "") + '> Ativo (pode retirar ferramentas)</label>' +
      '</div><div class="form-error" id="ffErr"></div>' +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button type="submit" class="btn btn-primary">Salvar</button></div></form>');
    el.querySelector("#funForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var row = { nome: $("ff_nome").value.trim(), matricula: $("ff_mat").value.trim(), telefone: $("ff_tel").value.trim(), funcao: $("ff_funcao").value.trim(), setor: $("ff_setor").value.trim(), ativo: $("ff_ativo").checked };
      if (isEdit) row.id = f.id;
      try { await A.API.saveFuncionario(row); A.closeModal(); A.toast("Funcionário salvo"); } catch (err) { $("ffErr").textContent = A.errMsg(err); }
    });
  }

  function funcDetail(f) {
    var posse = S.ferramentas.filter(function (t) { return t.funcionario_id === f.id; });
    var movs = S.movimentacoes.filter(function (m) { return m.funcionario_id === f.id || (m.matricula && m.matricula === f.matricula); }).slice(0, 15);
    var el = A.openModal(A.modalHead(f.nome) +
      '<p class="small muted mono" style="margin:0 0 12px;">mat. ' + esc(f.matricula) + (f.funcao ? " · " + esc(f.funcao) : "") + (f.setor ? " · " + esc(f.setor) : "") + '</p>' +
      '<div class="section-title" style="margin-top:0">Ferramentas em posse (' + posse.length + ')</div>' +
      (posse.length ? '<div class="list">' + posse.map(function (t) {
        return '<div class="tool-row"' + (A.isLate(t) ? ' style="border-color:var(--danger)"' : "") + '><div class="info"><div class="name">' + esc(t.nome) + '</div><div class="meta"><span class="mono">' + esc(t.codigo) + '</span> · ' + A.fmtElapsed(t.retirada_em) + '</div></div>' +
          (A.isLate(t) ? '<span class="badge badge-late">' + A.daysLabel(t.retirada_em) + '</span>' : "") + '</div>';
      }).join("") + '</div>' : '<div class="muted small">Nenhuma.</div>') +
      '<div class="section-title">Últimas movimentações</div>' +
      (movs.length ? '<div class="list">' + movs.map(function (m) { return histRow(m, true); }).join("") + '</div>' : '<div class="muted small">Nenhuma.</div>'), { wide: true });
    on(el, "click", "[data-sig]", function (b) { var m = S.movimentacoes.find(function (x) { return x.id === b.dataset.sig; }); if (m) A.showSignature(m); });
  }

  /* ---------- importação de planilha */
  var HEADER_ALIASES = {
    matricula: ["matricula", "mat", "matr", "registro", "re", "chapa", "codigo", "cod", "id funcionario", "n matricula", "no matricula", "numero matricula"],
    nome: ["nome", "nome completo", "funcionario", "colaborador", "empregado", "nome do funcionario", "nome funcionario"],
    funcao: ["funcao", "cargo", "ocupacao", "profissao"],
    setor: ["setor", "departamento", "depto", "obra", "centro de custo", "lotacao", "equipe", "local"],
    telefone: ["telefone", "celular", "fone", "whatsapp", "contato", "tel"]
  };
  function headerKey(h) {
    var n = A.norm(h).replace(/[º°.:#_\-\/]/g, " ").replace(/\s+/g, " ").trim();
    for (var k in HEADER_ALIASES) if (HEADER_ALIASES[k].indexOf(n) >= 0) return k;
    for (var k2 in HEADER_ALIASES) if (HEADER_ALIASES[k2].some(function (a) { return a.length > 3 && n.indexOf(a) === 0; })) return k2;
    return null;
  }
  function cleanMat(v) { var s = String(v == null ? "" : v).trim(); if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, ""); return s; }
  function titleCase(s) {
    s = String(s || "").trim().replace(/\s+/g, " ");
    if (s !== s.toUpperCase()) return s;
    return s.toLowerCase().replace(/(^|\s)(\S)/g, function (m, a, b) { return a + b.toUpperCase(); }).replace(/\s(Da|De|Do|Das|Dos|E)\s/g, function (m) { return m.toLowerCase(); });
  }

  function drawImport() {
    var box = $("funImportBox");
    if (!importState) { box.innerHTML = ""; return; }
    if (importState.step === "pick") {
      box.innerHTML = '<div class="card" style="margin-bottom:16px;">' +
        '<div class="row" style="margin-bottom:10px;"><strong style="font-size:14px;">Importar planilha de funcionários</strong><span class="spacer"></span>' +
          '<button class="btn btn-outline btn-sm" id="impTpl">⬇ Baixar modelo</button><button class="btn btn-ghost btn-sm" id="impClose">Fechar</button></div>' +
        '<label class="dropzone" id="impDrop"><input type="file" id="impFile" accept=".xlsx,.csv" hidden>' +
          '<strong>Clique ou arraste a planilha aqui</strong><span class="small muted">Excel (.xlsx) ou CSV. Arquivos .xls/.ods antigos: salve como .xlsx antes. Colunas reconhecidas: Matrícula, Nome, Função/Cargo, Setor/Obra, Telefone.</span></label>' +
        '<p class="small muted" style="margin:10px 0 0;">Funcionários são identificados pela <strong>matrícula</strong>: se já existir, os dados são atualizados; se não existir, é cadastrado.</p></div>';
      $("impClose").addEventListener("click", function () { importState = null; drawImport(); });
      $("impTpl").addEventListener("click", downloadTemplate);
      var drop = $("impDrop");
      $("impFile").addEventListener("change", function (e) { if (e.target.files[0]) readFile(e.target.files[0]); });
      ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("drag"); }); });
      ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("drag"); }); });
      drop.addEventListener("drop", function (e) { var f = e.dataTransfer.files[0]; if (f) readFile(f); });
      return;
    }
    // preview
    var st = importState;
    var deact = st.deactivate ? st.missing.length : 0;
    box.innerHTML = '<div class="card" style="margin-bottom:16px;">' +
      '<div class="row" style="margin-bottom:10px;"><strong style="font-size:14px;">' + esc(st.fileName) + '</strong><span class="spacer"></span><button class="btn btn-ghost btn-sm" id="impBack">Escolher outro arquivo</button></div>' +
      '<div class="stat-grid" style="margin-bottom:12px;">' +
        '<div class="stat-card good"><div class="num mono">' + st.novos + '</div><div class="lbl">Novos</div></div>' +
        '<div class="stat-card warn"><div class="num mono">' + st.alterados + '</div><div class="lbl">Atualizados</div></div>' +
        '<div class="stat-card"><div class="num mono">' + st.iguais + '</div><div class="lbl">Sem alteração</div></div>' +
        '<div class="stat-card danger"><div class="num mono">' + st.erros + '</div><div class="lbl">Linhas ignoradas</div></div></div>' +
      '<p class="small muted" style="margin:0 0 8px;">Colunas detectadas: ' + st.cols.map(function (c) { return '<span class="tag">' + esc(c.from) + ' → ' + esc(c.to) + '</span>'; }).join(" ") + '</p>' +
      '<div class="table-wrap"><table class="tbl"><thead><tr><th>Linha</th><th>Situação</th><th>Matrícula</th><th>Nome</th><th>Função</th><th>Setor</th><th>Telefone</th></tr></thead><tbody>' +
        st.preview.slice(0, 300).map(function (r) {
          return '<tr class="' + (r._err ? "err" : "") + '"><td class="mono">' + r._line + '</td><td>' + esc(r._err || r._st) + '</td><td class="mono">' + esc(r.matricula) + '</td><td>' + esc(r.nome) + '</td><td>' + esc(r.funcao) + '</td><td>' + esc(r.setor) + '</td><td>' + esc(r.telefone) + '</td></tr>';
        }).join("") + '</tbody></table></div>' +
      (st.preview.length > 300 ? '<p class="small muted">Mostrando 300 de ' + st.preview.length + ' linhas.</p>' : "") +
      '<label class="chk" style="margin-top:12px;"><input type="checkbox" id="impDeact"' + (st.deactivate ? " checked" : "") + '> Desativar funcionários que não estão nesta planilha (' + st.missing.length + ')</label>' +
      '<div class="form-error" id="impErr"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="impCancel">Cancelar</button>' +
        '<button class="btn btn-primary" id="impGo"' + (st.toSave.length + deact ? "" : " disabled") + '>Importar ' + st.toSave.length + ' funcionário(s)' + (deact ? " e desativar " + deact : "") + '</button></div></div>';
    $("impBack").addEventListener("click", function () { importState = { step: "pick" }; drawImport(); });
    $("impCancel").addEventListener("click", function () { importState = null; drawImport(); });
    $("impDeact").addEventListener("change", function (e) { st.deactivate = e.target.checked; drawImport(); });
    $("impGo").addEventListener("click", async function () {
      var b = $("impGo"); b.disabled = true; b.textContent = "Importando…";
      try {
        var withPosse = {}; S.ferramentas.forEach(function (t) { if (t.funcionario_id) withPosse[t.funcionario_id] = 1; });
        var ids = st.deactivate ? st.missing.filter(function (f) { return !withPosse[f.id]; }).map(function (f) { return f.id; }) : [];
        await A.API.upsertFuncionarios(st.toSave, ids, function (d, t) { b.textContent = "Importando… " + d + "/" + t; });
        // Resumo da importação (sem nomes nem nome do arquivo). Cada alteração individual já foi auditada pelo banco.
        var resumoOk = await A.auditarSilencioso("importacao_funcionarios", null, {
          formato: st.formato || "", linhas_validas: st.novos + st.alterados + st.iguais, novos: st.novos, atualizados: st.alterados,
          sem_alteracao: st.iguais, ignorados: st.erros, desativados: ids.length });
        A.toast("Importação concluída: " + st.toSave.length + " salvos" + (ids.length ? ", " + ids.length + " desativados" : "") +
          (resumoOk ? "" : " (atenção: resumo não registrado na auditoria; as alterações individuais foram registradas)"), 5000);
        importState = null; drawImport();
      } catch (e) { $("impErr").textContent = A.errMsg(e); b.disabled = false; b.textContent = "Tentar de novo"; }
    });
  }

  var IMPORT_MAX_BYTES = 5 * 1024 * 1024, IMPORT_MAX_LINHAS = 20000;
  async function readFile(file) {
    try {
      if (file.size > IMPORT_MAX_BYTES) throw new Error("arquivo maior que 5 MB");
      var ext = (file.name.split(".").pop() || "").toLowerCase();
      var rows;
      if (ext === "csv") rows = lerCsv(await file.text());
      else if (ext === "xlsx") rows = await lerXlsx(file);
      else throw new Error("formato ." + ext + " não suportado (use .xlsx ou .csv)");
      if (rows.length > IMPORT_MAX_LINHAS) throw new Error("mais de " + IMPORT_MAX_LINHAS + " linhas");
      parseRows(rows, file.name, ext);
    } catch (e) { A.toast("Não consegui ler a planilha: " + e.message, 5000); }
  }

  function parseRows(rows, fileName, formato) {
    var hIdx = -1, map = null;
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var m = {}; rows[i].forEach(function (h, c) { var k = headerKey(h); if (k && m[k] == null) m[k] = c; });
      if (m.matricula != null && m.nome != null) { hIdx = i; map = m; break; }
    }
    if (hIdx < 0) { A.toast("Não encontrei as colunas Matrícula e Nome nas primeiras linhas da planilha.", 6000); return; }
    var cols = Object.keys(map).map(function (k) { return { from: String(rows[hIdx][map[k]]).trim(), to: k }; });
    var seen = {}, preview = [], toSave = [], novos = 0, alterados = 0, iguais = 0, erros = 0;
    for (var r = hIdx + 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || row.every(function (v) { return String(v).trim() === ""; })) continue;
      var get = function (k) { return map[k] != null ? String(row[map[k]] == null ? "" : row[map[k]]).trim() : ""; };
      var o = { matricula: cleanMat(get("matricula")), nome: titleCase(get("nome")), funcao: get("funcao"), setor: get("setor"), telefone: get("telefone"), _line: r + 1 };
      if (!o.matricula || !o.nome) { o._err = !o.matricula ? "Sem matrícula" : "Sem nome"; erros++; preview.push(o); continue; }
      if (seen[A.norm(o.matricula)]) { o._err = "Matrícula repetida na planilha (linha " + seen[A.norm(o.matricula)] + ")"; erros++; preview.push(o); continue; }
      seen[A.norm(o.matricula)] = o._line;
      var cur = A.funcByMatricula(o.matricula);
      var data = { matricula: o.matricula, nome: o.nome, funcao: o.funcao || null, setor: o.setor || null, telefone: o.telefone || null, ativo: true };
      if (!cur) { o._st = "Novo"; novos++; toSave.push(data); }
      else {
        // campos ausentes na planilha não apagam o que já existe
        ["funcao", "setor", "telefone"].forEach(function (k) { if (map[k] == null) data[k] = cur[k] || null; });
        var changed = ["nome", "funcao", "setor", "telefone"].some(function (k) { return (cur[k] || "") !== (data[k] || ""); }) || cur.ativo === false;
        if (changed) { o._st = cur.ativo === false ? "Reativar / atualizar" : "Atualizar"; alterados++; toSave.push(data); } else { o._st = "Sem alteração"; iguais++; }
      }
      preview.push(o);
    }
    var missing = S.funcionarios.filter(function (f) { return f.ativo !== false && !seen[A.norm(f.matricula)]; });
    importState = { step: "preview", fileName: fileName, formato: formato, cols: cols, preview: preview, toSave: toSave, novos: novos, alterados: alterados, iguais: iguais, erros: erros, missing: missing, deactivate: false };
    drawImport();
  }

  function downloadTemplate() {
    salvarXlsx([["Matrícula", "Nome", "Função", "Setor", "Telefone"], ["1001", "Fulano de Tal", "Pedreiro", "Obra Centro", "81999999999"],
      ["1002", "Beltrano da Silva", "Eletricista", "Obra Centro", ""]], "modelo_funcionarios.xlsx").catch(function (e) { A.toast(A.errMsg(e)); });
  }

  /* ================================================================ ETIQUETAS 70x25 */
  var Etq = { mode: "ferramentas", q: "", sel: {}, layout: "termica", showPat: true, showSite: true };
  try { var savedEtq = JSON.parse(localStorage.getItem("almox_etq") || "null"); if (savedEtq) { Etq.layout = savedEtq.layout || Etq.layout; Etq.showPat = savedEtq.showPat !== false; Etq.showSite = savedEtq.showSite !== false; } } catch (e) { }
  function saveEtqPrefs() { try { localStorage.setItem("almox_etq", JSON.stringify({ layout: Etq.layout, showPat: Etq.showPat, showSite: Etq.showSite })); } catch (e) { } }

  function labelHtml(item) {
    if (Etq.mode === "funcionarios") {
      return '<div class="lbl70"><div class="q">' + A.qrSvg(A.FUNC_PREFIX + item.matricula) + '</div><div class="t">' +
        '<div class="k">Crachá · ferramentas</div><div class="n">' + esc(item.nome) + '</div>' +
        '<div class="c">MAT ' + esc(item.matricula) + '</div>' +
        (item.funcao || item.setor ? '<div class="s">' + esc([item.funcao, item.setor].filter(Boolean).join(" · ")) + '</div>' : "") + '</div></div>';
    }
    var sub = [Etq.showPat && item.patrimonio, Etq.showSite && item.site].filter(Boolean).join(" · ");
    return '<div class="lbl70"><div class="q">' + A.qrSvg(item.codigo) + '</div><div class="t">' +
      '<div class="n">' + esc(item.nome) + '</div><div class="c">' + esc(item.codigo) + '</div>' +
      (sub ? '<div class="s">' + esc(sub) + '</div>' : "") + '</div></div>';
  }
  function etqSource() { return Etq.mode === "funcionarios" ? S.funcionarios.filter(function (f) { return f.ativo !== false; }) : siteTools(); }
  function etqItems() {
    var out = [];
    etqSource().forEach(function (it) { var n = Etq.sel[it.id] || 0; for (var i = 0; i < n; i++) out.push(it); });
    return out;
  }

  var Etiquetas = {
    build: function (el) {
      el.innerHTML = '<div class="labels-layout">' +
        '<div class="card">' +
          '<div class="row" style="margin-bottom:12px;"><div class="seg" id="etqMode"><button data-m="ferramentas">Ferramentas</button><button data-m="funcionarios">Crachás de funcionários</button></div></div>' +
          '<div class="toolbar" style="margin-bottom:10px;"><input class="search-input" id="etqSearch" placeholder="Filtrar"><button class="btn btn-outline btn-sm" id="etqAll">Selecionar visíveis</button><button class="btn btn-outline btn-sm" id="etqNone">Limpar</button></div>' +
          '<div class="pick-list" id="etqList"></div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="section-title" style="margin-top:0">Impressão — etiqueta 70 × 25 mm</div>' +
          '<div class="form-grid">' +
            '<label class="field full">Tipo de impressora<select id="etqLayout">' +
              '<option value="termica">Impressora térmica de etiquetas (rolo 70×25, 1 por página)</option>' +
              '<option value="a4">Folha A4 de etiquetas 70×25 (3 colunas × 11 linhas)</option></select></label>' +
          '</div>' +
          '<div class="row" style="margin:10px 0 4px;" id="etqOpts"><label class="chk"><input type="checkbox" id="etqPat"> Patrimônio</label><label class="chk"><input type="checkbox" id="etqSite"> Almoxarifado</label></div>' +
          '<div class="row" style="margin:12px 0;"><span id="etqCount" class="small muted"></span><span class="spacer"></span><button class="btn btn-primary op-only" id="etqPrint">🖨️ Imprimir</button></div>' +
          '<div class="label-preview" id="etqPreview"></div>' +
          '<p class="small muted" style="margin:10px 0 0;">Dica: na janela de impressão use escala <strong>100%</strong> (ou “Tamanho real”), margens <strong>Nenhuma</strong> e desative cabeçalhos/rodapés. Na térmica, configure o papel do driver para 70 × 25 mm.</p>' +
        '</div></div>';
      on($("etqMode"), "click", "[data-m]", function (b) { Etq.mode = b.dataset.m; Etq.sel = {}; Etiquetas.update(); });
      $("etqSearch").addEventListener("input", function (e) { Etq.q = e.target.value; Etiquetas.update(); });
      $("etqAll").addEventListener("click", function () { visibleEtq().forEach(function (i) { if (!Etq.sel[i.id]) Etq.sel[i.id] = 1; }); Etiquetas.update(); });
      $("etqNone").addEventListener("click", function () { Etq.sel = {}; Etiquetas.update(); });
      $("etqLayout").addEventListener("change", function (e) { Etq.layout = e.target.value; saveEtqPrefs(); Etiquetas.update(); });
      $("etqPat").addEventListener("change", function (e) { Etq.showPat = e.target.checked; saveEtqPrefs(); Etiquetas.update(); });
      $("etqSite").addEventListener("change", function (e) { Etq.showSite = e.target.checked; saveEtqPrefs(); Etiquetas.update(); });
      var list = $("etqList");
      list.addEventListener("click", function (e) {
        if (e.target.matches("input[type=number]")) return;
        var row = e.target.closest("[data-id]"); if (!row) return;
        if (Etq.sel[row.dataset.id]) delete Etq.sel[row.dataset.id]; else Etq.sel[row.dataset.id] = 1;
        Etiquetas.update();
      });
      list.addEventListener("change", function (e) {
        if (!e.target.matches("input[type=number]")) return;
        var id = e.target.closest("[data-id]").dataset.id, n = Math.max(0, Math.min(99, parseInt(e.target.value, 10) || 0));
        if (n) Etq.sel[id] = n; else delete Etq.sel[id];
        Etiquetas.update();
      });
      $("etqPrint").addEventListener("click", printLabels);
    },
    update: function () {
      document.querySelectorAll("#etqMode [data-m]").forEach(function (b) { b.classList.toggle("on", b.dataset.m === Etq.mode); });
      $("etqLayout").value = Etq.layout; $("etqPat").checked = Etq.showPat; $("etqSite").checked = Etq.showSite;
      $("etqOpts").hidden = Etq.mode !== "ferramentas";
      $("etqSearch").placeholder = Etq.mode === "ferramentas" ? "Filtrar por nome, código ou patrimônio" : "Filtrar por nome, matrícula ou setor";
      var vis = visibleEtq();
      $("etqList").innerHTML = !vis.length ? '<div class="empty">Nada para listar.</div>' : vis.slice(0, 400).map(function (it) {
        var n = Etq.sel[it.id] || 0, isF = Etq.mode === "funcionarios";
        return '<div class="pick-row' + (n ? " on" : "") + '" data-id="' + it.id + '"><input type="checkbox" tabindex="-1"' + (n ? " checked" : "") + ' style="pointer-events:none;width:17px;height:17px;accent-color:var(--accent)">' +
          '<div class="info"><div class="name">' + esc(it.nome) + '</div><div class="meta mono">' + esc(isF ? "mat. " + it.matricula : it.codigo + (it.patrimonio ? " · " + it.patrimonio : "")) + '</div></div>' +
          (n ? '<input type="number" min="0" max="99" value="' + n + '" title="Cópias">' : "") + '</div>';
      }).join("");
      var items = etqItems();
      var pages = Etq.layout === "a4" ? Math.ceil(items.length / 33) : items.length;
      $("etqCount").textContent = items.length ? items.length + " etiqueta(s)" + (Etq.layout === "a4" ? " · " + pages + " folha(s) A4" : "") : "Selecione itens à esquerda";
      $("etqPrint").disabled = !items.length;
      $("etqPreview").innerHTML = items.length ? items.slice(0, 40).map(labelHtml).join("") + (items.length > 40 ? '<div class="small muted" style="align-self:center">+' + (items.length - 40) + ' …</div>' : "") :
        '<div class="small muted">A prévia aparece aqui em tamanho real (70 × 25 mm).</div>';
    }
  };
  function visibleEtq() {
    var q = A.norm(Etq.q);
    return etqSource().filter(function (it) {
      return !q || [it.nome, it.codigo, it.patrimonio, it.matricula, it.setor].some(function (v) { return A.norm(v).indexOf(q) >= 0; });
    }).sort(function (a, b) { return Etq.mode === "funcionarios" ? a.nome.localeCompare(b.nome) : (a.codigo || "").localeCompare(b.codigo || ""); });
  }
  function printLabels() {
    var items = etqItems(); if (!items.length) return;
    A.auditarSilencioso("impressao_etiquetas", null, { tipo: Etq.mode, layout: Etq.layout, quantidade: items.length });
    var area = $("printArea");
    area.className = Etq.layout === "a4" ? "sheet" : "";
    area.innerHTML = items.map(labelHtml).join("");
    var st = document.getElementById("pageStyle") || document.head.appendChild(Object.assign(document.createElement("style"), { id: "pageStyle" }));
    st.textContent = Etq.layout === "a4"
      ? "@page{size:A4 portrait;margin:11mm 0 0 0}@media print{html,body{margin:0!important;padding:0!important}}"
      : "@page{size:70mm 25mm;margin:0}@media print{html,body{margin:0!important;padding:0!important;width:70mm}}";
    document.body.classList.add("printing");
    var done = function () { document.body.classList.remove("printing"); area.innerHTML = ""; st.textContent = ""; window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    setTimeout(function () { window.print(); setTimeout(function () { if (!matchMedia("print").matches) done(); }, 500); }, 60);
  }

  /* ================================================================ HISTÓRICO */
  var hisF = { q: "", acao: "todas", dias: "30" };
  var Historico = {
    build: function (el) {
      el.innerHTML = '<div class="toolbar"><input class="search-input" id="hisSearch" placeholder="Buscar por ferramenta, funcionário ou matrícula">' +
        '<select class="select-input" id="hisAcao"><option value="todas">Todas as ações</option><option value="retirada">Retiradas</option><option value="devolucao">Devoluções</option><option value="manutencao_inicio">Manutenção (início)</option><option value="manutencao_fim">Manutenção (fim)</option></select>' +
        '<select class="select-input" id="hisDias"><option value="1">Hoje</option><option value="7">7 dias</option><option value="30" selected>30 dias</option><option value="0">Tudo</option></select>' +
        '<button class="btn btn-ghost" id="hisExport">⬇ Excel</button></div><div id="hisList"></div>';
      $("hisSearch").addEventListener("input", function (e) { hisF.q = e.target.value; Historico.update(); });
      $("hisAcao").addEventListener("change", function (e) { hisF.acao = e.target.value; Historico.update(); });
      $("hisDias").addEventListener("change", function (e) { hisF.dias = e.target.value; Historico.update(); });
      $("hisExport").addEventListener("click", async function () {
        var lista = hisFiltered();
        if (!lista.length) return A.toast("Nada para exportar");
        try {
          await A.auditarObrigatorio("exportacao_historico", null, { linhas: lista.length, periodo_dias: Number(hisF.dias), filtro_acao: hisF.acao,
            busca_aplicada: !!hisF.q, almoxarifado: currentSite === "all" ? "todos" : "filtrado" });
          var linhas = [["Data/hora", "Ação", "Código", "Ferramenta", "Funcionário", "Matrícula", "Almoxarifado", "Observação", "Assinado", "Registrado por"]]
            .concat(lista.map(function (h) {
              return [A.fmtDateTime(h.created_at), A.ACTION_LABEL[h.acao] || h.acao, h.ferramenta_codigo || "", h.ferramenta_nome || "",
                h.funcionario_nome || "", h.matricula || "", h.site || "", h.observacao || "", h.tem_assinatura ? "Sim" : "Não", h.usuario_email || ""];
            }));
          await salvarXlsx(linhas, "historico_almoxarifado_" + new Date().toISOString().slice(0, 10) + ".xlsx");
          A.toast("Exportado. O arquivo contém dados pessoais: guarde em local restrito.", 4500);
        } catch (e) { A.toast(A.errMsg(e), 5000); }
      });
      on($("hisList"), "click", "[data-sig]", function (b) { var m = S.movimentacoes.find(function (x) { return x.id === b.dataset.sig; }); if (m) A.showSignature(m); });
    },
    update: function () {
      var list = hisFiltered();
      $("hisList").innerHTML = !list.length ? '<div class="card empty"><span class="ic">🕓</span>Nenhum registro encontrado.</div>' :
        '<div class="small muted" style="margin:0 0 8px;">' + list.length + ' registro(s)' + (list.length > 400 ? " — mostrando 400" : "") + '</div>' +
        '<div class="card"><div class="list">' + list.slice(0, 400).map(function (h) { return histRow(h, true); }).join("") + '</div></div>';
    }
  };
  function hisFiltered() {
    var q = A.norm(hisF.q), lim = hisF.dias === "0" ? 0 : Date.now() - Number(hisF.dias) * 86400000;
    if (hisF.dias === "1") { var d = new Date(); d.setHours(0, 0, 0, 0); lim = d.getTime(); }
    return siteMovs().filter(function (h) {
      if (hisF.acao !== "todas" && h.acao !== hisF.acao) return false;
      if (lim && new Date(h.created_at).getTime() < lim) return false;
      return !q || [h.ferramenta_nome, h.ferramenta_codigo, h.funcionario_nome, h.matricula].some(function (v) { return A.norm(v).indexOf(q) >= 0; });
    });
  }

  /* ================================================================ FORNECEDORES */
  var Fornecedores = {
    build: function (el) {
      el.innerHTML = '<div class="toolbar"><div style="flex:1;"></div><button class="btn btn-primary op-only" id="fornNew">+ Novo fornecedor</button></div><div id="fornList"></div>';
      $("fornNew").addEventListener("click", function () {
        var m = A.openModal(A.modalHead("Novo fornecedor") + '<form id="fornForm"><div class="form-grid">' +
          '<label class="field full">Nome<input required id="sf_nome" placeholder="Ex.: Vonder Ferramentas"></label>' +
          '<label class="field full">Contato<input id="sf_contato" placeholder="Telefone ou e-mail"></label></div>' +
          '<div class="form-error" id="sfErr"></div><div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button type="submit" class="btn btn-primary">Adicionar</button></div></form>');
        m.querySelector("#fornForm").addEventListener("submit", async function (e) {
          e.preventDefault();
          try { await A.API.saveFornecedor({ nome: $("sf_nome").value.trim(), contato: $("sf_contato").value.trim() }); A.closeModal(); A.toast("Fornecedor adicionado"); }
          catch (err) { $("sfErr").textContent = A.errMsg(err); }
        });
      });
      on($("fornList"), "click", "[data-del]", function (b) { A.askConfirm("Excluir este fornecedor?", function () { run(A.API.deleteFornecedor(b.dataset.del), "Fornecedor excluído"); }, "Excluir"); });
    },
    update: function () {
      $("fornList").innerHTML = !S.fornecedores.length ? '<div class="card empty"><span class="ic">🚚</span>Nenhum fornecedor cadastrado.</div>' :
        '<div class="list">' + S.fornecedores.map(function (s) {
          var n = S.ferramentas.filter(function (t) { return t.fornecedor === s.nome; }).length;
          return '<div class="tool-row"><div class="info"><div class="name">' + esc(s.nome) + '</div><div class="meta">' + esc(s.contato || "Sem contato informado") + ' · ' + n + ' ferramenta(s)</div></div>' +
            '<button class="btn btn-danger btn-sm gestor-only" data-del="' + s.id + '">Excluir</button></div>';
        }).join("") + '</div>';
    }
  };

  /* ================================================================ INCIDENTES (Res. CD/ANPD 15/2024) */
  var INC_STATUS = { suspeita: "Suspeita", em_analise: "Em análise", contido: "Contido", encerrado: "Encerrado" };
  var INC_STATUS_BADGE = { suspeita: "badge-warn", em_analise: "badge-warn", contido: "badge-good", encerrado: "badge-good" };
  var INC_AVAL = { pendente: "Avaliação pendente", sem_risco_relevante: "Sem risco relevante", risco_relevante: "Risco ou dano relevante" };
  var INC_DEST = { anpd: "ANPD", titulares: "Titulares", complementar_anpd: "ANPD (complementar)", outro: "Outro" };
  var CAT_DADOS = [["nenhum", "Nenhum dado pessoal afetado"], ["cadastrais", "Cadastrais (nome, matrícula, função)"], ["contato", "Contato (telefone, e-mail)"], ["assinatura", "Imagem de assinatura"],
    ["autenticacao", "Credenciais / senhas"], ["financeiros", "Financeiros"], ["saude", "Saúde / sensíveis"], ["localizacao", "Localização"], ["outros", "Outros"]];
  var CAT_TIT = [["empregados", "Empregados"], ["terceiros", "Terceiros / prestadores"], ["usuarios_sistema", "Usuários do sistema"], ["outros", "Outros"]];
  var ART5 = [["sensiveis", "Dados pessoais sensíveis"], ["criancas_adolescentes_idosos", "Dados de crianças, adolescentes ou idosos"], ["financeiros", "Dados financeiros"],
    ["autenticacao", "Dados de autenticação em sistemas"], ["sigilo", "Dados protegidos por sigilo legal, judicial ou profissional"], ["larga_escala", "Dados em larga escala"]];
  var incF = { status: "abertos" };
  function fmtData(d) { if (!d) return "—"; var s = String(d).slice(0, 10).split("-"); return s.length === 3 ? s[2] + "/" + s[1] + "/" + s[0] : esc(d); }
  function prazoHtml(i) {
    if (i.status === "encerrado") return '<span class="badge badge-good">Encerrado</span>';
    if (!i.ciencia_em) return '<span class="small muted">sem data de ciência</span>';
    if (i.avaliacao_risco === "sem_risco_relevante") return '<span class="small muted">sem comunicação obrigatória</span>';
    if (i.dias_uteis_para_prazo == null) return '<span class="badge badge-good">Comunicado</span>' +
      (i.dias_uteis_complementacao != null && i.dias_uteis_complementacao >= 0 ? ' <span class="tag">complementação até ' + fmtData(i.prazo_complementacao) + '</span>' : '');
    var n = i.dias_uteis_para_prazo;
    return n < 0 ? '<span class="badge badge-late">VENCIDO há ' + (-n) + ' dia(s) útil(eis)</span>'
         : '<span class="badge ' + (n <= 1 ? "badge-late" : "badge-warn") + '">' + (n === 0 ? "vence HOJE" : "vence em " + n + " dia(s) útil(eis)") + ' · ' + fmtData(i.prazo_anpd) + '</span>';
  }
  function incidentesAlertaHtml() {
    if (!A.tem(["gestor", "encarregado"]) || !S.incidentesAtivos) return "";
    var abertos = S.incidentes.filter(function (i) { return i.status !== "encerrado"; });
    if (!abertos.length) return "";
    var prazo = abertos.filter(function (i) { return i.dias_uteis_para_prazo != null; });
    var semAval = abertos.filter(function (i) { return !i.ciencia_em || i.avaliacao_risco === "pendente"; });
    return '<div class="alert-card" style="margin:0 0 16px"><h3>🛡️ ' + abertos.length + ' incidente(s) de segurança em aberto</h3>' +
      '<p>' + (prazo.length ? prazo.length + ' com prazo de comunicação correndo (3 dias úteis da ciência — Res. CD/ANPD 15/2024). ' : '') +
      (semAval.length ? semAval.length + ' aguardando avaliação/data de ciência.' : '') + '</p>' +
      abertos.slice(0, 5).map(function (i) {
        return '<div class="alert-row"><div class="info"><div class="name">Nº ' + i.numero + ' · ' + esc(i.titulo) + '</div>' +
          '<div class="meta">' + INC_STATUS[i.status] + ' · ' + INC_AVAL[i.avaliacao_risco] + '</div></div>' + prazoHtml(i) +
          '<button class="btn btn-outline btn-sm" data-inc="' + i.id + '">Abrir</button></div>';
      }).join("") + '</div>';
  }
  var Incidentes = {
    build: function (el) {
      el.innerHTML = '<div class="toolbar">' +
        '<select class="select-input" id="incSt"><option value="abertos">Em aberto</option><option value="encerrado">Encerrados</option><option value="todos">Todos</option></select>' +
        '<span class="spacer"></span><span class="small muted" id="incPP"></span>' +
        '<button class="btn btn-ghost enc-only" id="incPPBtn">Enquadramento</button>' +
        '<button class="btn btn-danger" id="incNovo">+ Registrar incidente</button></div>' +
        '<div class="small muted" style="margin:-4px 0 12px">Registro exigido pela Res. CD/ANPD nº 15/2024 (art. 10): todos os incidentes, comunicados ou não, guardados por no mínimo 5 anos. ' +
        'Prazos em dias úteis contam do conhecimento de que o incidente afetou dados pessoais; feriados locais e pontos facultativos não são descontados (cálculo conservador).</div>' +
        '<div id="incList"></div>';
      $("incSt").addEventListener("change", function (e) { incF.status = e.target.value; Incidentes.update(); });
      $("incNovo").addEventListener("click", function () { A.openReportIncident(function (r) { abrirIncidente(r.id); }); });
      $("incPPBtn").addEventListener("click", enquadramento);
      on($("incList"), "click", "[data-inc]", function (b) { abrirIncidente(b.dataset.inc); });
    },
    update: function () {
      if (!S.incidentesAtivos) { $("incList").innerHTML = '<div class="card empty">O registro de incidentes ainda não foi ativado no banco (rode a migração 003).</div>'; return; }
      var pp = S.incidentes.length ? S.incidentes[0].agente_pequeno_porte : null;
      $("incPP").textContent = pp ? "Agente de pequeno porte: prazos em dobro" : "";
      var l = S.incidentes.filter(function (i) { return incF.status === "todos" || (incF.status === "abertos" ? i.status !== "encerrado" : i.status === "encerrado"); });
      $("incList").innerHTML = !l.length ? '<div class="card empty"><span class="ic">🛡️</span>Nenhum incidente ' + (incF.status === "abertos" ? "em aberto" : "") + '.</div>' :
        '<div class="list">' + l.map(function (i) {
          return '<div class="tool-row tool-row-wrap" data-inc="' + i.id + '" style="cursor:pointer' + (i.dias_uteis_para_prazo != null && i.dias_uteis_para_prazo <= 1 ? ";border-color:var(--danger)" : "") + '">' +
            '<div class="info"><div class="name">Nº ' + i.numero + ' · ' + esc(i.titulo) + '</div>' +
            '<div class="meta">Detectado ' + esc(A.fmtDateTime(i.detectado_em)) + (i.ciencia_em ? ' · ciência ' + esc(A.fmtDateTime(i.ciencia_em)) : '') +
            (i.origem !== "manual" ? ' · <strong>aberto automaticamente</strong>' : '') + '</div>' +
            '<div class="tag-row"><span class="badge ' + INC_STATUS_BADGE[i.status] + '">' + INC_STATUS[i.status] + '</span><span class="tag">' + INC_AVAL[i.avaliacao_risco] + '</span>' +
            (i.indicio_art5 && i.avaliacao_risco === "pendente" ? '<span class="badge badge-late">indício do art. 5º</span>' : '') + prazoHtml(i) + '</div></div>' +
            '<div class="tool-actions"><button class="btn btn-outline btn-sm">Abrir</button></div></div>';
        }).join("") + '</div>';
    }
  };
  function chk(nome, lista, sel, ro) {
    return '<div class="row" style="gap:6px 14px">' + lista.map(function (o) {
      return '<label class="chk"><input type="checkbox" name="' + nome + '" value="' + o[0] + '"' + ((sel || []).indexOf(o[0]) >= 0 ? " checked" : "") + (ro ? " disabled" : "") + '> ' + esc(o[1]) + '</label>';
    }).join("") + '</div>';
  }
  function marcados(el, nome) { return Array.prototype.map.call(el.querySelectorAll('input[name="' + nome + '"]:checked'), function (x) { return x.value; }); }
  async function abrirIncidente(id) {
    var d;
    try { d = await A.API.detalheIncidente(id); } catch (e) { return A.toast(A.errMsg(e), 5000); }
    var i = d.incidente; if (!i) return A.toast("Incidente não encontrado ou sem permissão.");
    var pode = A.tem(["gestor", "encarregado"]), ro = !pode || i.status === "encerrado", dis = ro ? " disabled" : "";
    var ta = function (id, v, rows, ph) { return '<textarea id="' + id + '" rows="' + (rows || 3) + '" maxlength="4000"' + dis + (ph ? ' placeholder="' + esc(ph) + '"' : "") + '>' + esc(v || "") + '</textarea>'; };
    var sec = function (t) { return '<div class="section-title">' + t + '</div>'; };
    var el = A.openModal(A.modalHead("Incidente nº " + i.numero) +
      '<div class="tag-row" style="margin:-6px 0 10px"><span class="badge ' + INC_STATUS_BADGE[i.status] + '">' + INC_STATUS[i.status] + '</span><span class="tag">' + INC_AVAL[i.avaliacao_risco] + '</span>' + prazoHtml(i) +
        (i.origem !== "manual" ? '<span class="tag">aberto automaticamente (' + esc(i.origem) + ')</span>' : '') + '</div>' +
      '<div class="card" style="background:var(--surface-2);box-shadow:none"><div class="small"><strong>Prazos (Res. CD/ANPD 15/2024' + (i.agente_pequeno_porte ? ', em dobro — pequeno porte' : '') + '):</strong> ' +
        'comunicação à ANPD (art. 6º) e aos titulares (art. 9º) até <strong>' + fmtData(i.prazo_anpd) + '</strong>' +
        (i.prazo_complementacao ? ' · complementação à ANPD até <strong>' + fmtData(i.prazo_complementacao) + '</strong>' : '') +
        (i.ciencia_em ? '' : ' — <em>preencha a data de ciência para iniciar a contagem</em>') + '</div>' +
        '<div class="small muted" style="margin-top:4px">Âncora da trilha de auditoria no registro: evento #' + esc(i.ancora_evento_id) + ' · ' + esc(String(i.ancora_hash || "").slice(0, 16)) + '…</div></div>' +
      '<div class="form-grid" style="margin-top:6px">' +
        '<label class="field full">Título<input id="in_tit" maxlength="200" value="' + esc(i.titulo) + '"' + dis + '></label>' +
        '<label class="field">Situação<select id="in_st"' + dis + '>' + ["suspeita", "em_analise", "contido"].map(function (k) { return '<option value="' + k + '"' + (i.status === k ? " selected" : "") + '>' + INC_STATUS[k] + '</option>'; }).join("") +
          (i.status === "encerrado" ? '<option selected>Encerrado</option>' : '') + '</select></label>' +
        '<label class="field">I · Ciência de que afetou dados pessoais<input type="datetime-local" id="in_ci" value="' + A.isoParaLocal(i.ciencia_em) + '"' + dis + '></label>' +
        '<label class="field">Detectado em<input type="datetime-local" value="' + A.isoParaLocal(i.detectado_em) + '" disabled></label>' +
        '<label class="field">Ocorrido em (se souber)<input type="datetime-local" id="in_oc" value="' + A.isoParaLocal(i.ocorrido_em) + '"' + dis + '></label>' +
      '</div>' +
      sec("II · Circunstâncias") + ta("in_desc", i.descricao, 4, "Descrição geral de como o incidente ocorreu") + '<label class="field" style="margin-top:8px">Causa principal (se identificada)' + ta("in_causa", i.causa, 2) + '</label>' +
      sec("III · Natureza e categoria dos dados") + chk("cd", CAT_DADOS, i.categorias_dados, ro) +
        '<div class="small muted" style="margin:8px 0 4px">Titulares afetados</div>' + chk("ct", CAT_TIT, i.categorias_titulares, ro) +
        '<label class="field" style="margin-top:8px">Sistemas afetados (separe por vírgula)<input id="in_sis" maxlength="300" value="' + esc((i.sistemas_afetados || []).join(", ")) + '"' + dis + '></label>' +
      sec("IV · Número de titulares") + '<div class="form-grid">' +
        '<label class="field">Afetados<input type="number" min="0" id="in_q" value="' + esc(i.qtd_titulares == null ? "" : i.qtd_titulares) + '"' + dis + '></label>' +
        '<label class="field">Dos quais crianças/adolescentes/idosos<input type="number" min="0" id="in_qv" value="' + esc(i.qtd_vulneraveis == null ? "" : i.qtd_vulneraveis) + '"' + dis + '></label>' +
        '<label class="field full">Total de titulares tratados na atividade afetada<input type="number" min="0" id="in_qt" value="' + esc(i.qtd_titulares_tratados == null ? "" : i.qtd_titulares_tratados) + '"' + dis + '></label></div>' +
      sec("V · Avaliação de risco e possíveis danos") +
        '<label class="chk"><input type="checkbox" id="in_sig"' + (i.afeta_significativamente ? " checked" : "") + dis + '> Pode afetar significativamente interesses e direitos fundamentais dos titulares</label>' +
        '<div class="small muted" style="margin:8px 0 4px">Envolve (art. 5º — basta um, junto com o item acima):</div>' + chk("a5", ART5, i.criterios_art5, ro) +
        '<div class="late-box" id="in_ind" style="margin-top:10px' + (i.indicio_art5 ? "" : ";display:none") + '">Indício de risco ou dano relevante (art. 5º): a comunicação à ANPD e aos titulares tende a ser obrigatória. A decisão é do controlador/encarregado.</div>' +
        '<div class="form-grid" style="margin-top:10px"><label class="field full">Conclusão da avaliação<select id="in_av"' + dis + '>' +
          Object.keys(INC_AVAL).map(function (k) { return '<option value="' + k + '"' + (i.avaliacao_risco === k ? " selected" : "") + '>' + INC_AVAL[k] + '</option>'; }).join("") + '</select></label>' +
        '<label class="field full">Justificativa da avaliação / motivos da ausência de comunicação (VIII)' + ta("in_jr", i.justificativa_risco, 3) + '</label>' +
        '<label class="field full">Possíveis danos aos titulares' + ta("in_dano", i.danos_possiveis, 2) + '</label></div>' +
      sec("VI · Medidas") + '<div class="form-grid">' +
        '<label class="field full">Contenção (imediatas)' + ta("in_mc", i.medidas_contencao, 2) + '</label>' +
        '<label class="field full">Correção e mitigação dos efeitos' + ta("in_mm", i.medidas_mitigacao, 2) + '</label>' +
        '<label class="field full">Medidas de segurança que já existiam' + ta("in_ms", i.medidas_seguranca_previas, 2) + '</label>' +
        '<label class="field full">Evidências preservadas (onde estão, quem guarda)' + ta("in_ev", i.evidencias, 2) + '</label></div>' +
      (ro ? "" : '<label class="field" style="margin-top:12px">Justificativa desta alteração (obrigatória ao mudar a ciência já registrada ou a avaliação)<input id="in_com" maxlength="2000"></label>' +
        '<div class="form-error" id="in_err"></div><div class="row" style="margin-top:10px"><button class="btn btn-primary" id="in_salvar">Salvar alterações</button></div>') +
      sec("VII · Comunicações realizadas") + '<div id="in_coms">' + (d.comunicacoes.length ? '<div class="list">' + d.comunicacoes.map(function (c) {
          return '<div class="hist-row"><div class="hist-ic" style="background:var(--surface-2)">✉</div><div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px">' + esc(INC_DEST[c.destinatario]) + ' · ' + esc(A.fmtDateTime(c.realizada_em)) + ' · ' + esc(c.meio) + (c.protocolo ? ' · protocolo ' + esc(c.protocolo) : '') + '</div>' +
            '<div class="small muted">registrada no sistema em ' + esc(A.fmtDateTime(c.registrado_em)) + '</div>' +
            '<div class="small muted" style="white-space:pre-wrap">' + esc(c.resumo) + '</div></div></div>';
        }).join("") + '</div>' : '<div class="small muted">Nenhuma comunicação registrada.</div>') + '</div>' +
      (pode ? '<details style="margin-top:8px"><summary class="small" style="cursor:pointer;font-weight:700">+ Registrar comunicação feita</summary><div class="form-grid" style="margin-top:8px">' +
        '<label class="field">Destinatário<select id="cm_dest">' + Object.keys(INC_DEST).map(function (k) { return '<option value="' + k + '">' + INC_DEST[k] + '</option>'; }).join("") + '</select></label>' +
        '<label class="field">Quando foi feita<input type="datetime-local" id="cm_q" value="' + A.isoParaLocal(new Date().toISOString()) + '"></label>' +
        '<label class="field">Meio (forma)<input id="cm_m" maxlength="200" placeholder="Ex.: peticionamento eletrônico ANPD; e-mail individual"></label>' +
        '<label class="field">Protocolo<input id="cm_p" maxlength="200"></label>' +
        '<label class="field full">Conteúdo comunicado (resumo)<textarea id="cm_r" rows="3" maxlength="4000"></textarea></label></div>' +
        '<div class="form-error" id="cm_err"></div><button class="btn btn-ghost" id="cm_ok" style="margin-top:8px">Registrar comunicação</button></details>' : '') +
      sec("Histórico do registro") + '<div class="list">' + d.historico.map(function (h) {
        return '<div class="small" style="border-bottom:1px solid var(--line);padding:6px 0"><span class="mono">' + esc(A.fmtDateTime(h.em)) + '</span> · <strong>' + esc(h.acao) + '</strong> · ' + esc(h.ator_email || "sistema") +
          (h.comentario ? ' — “' + esc(h.comentario) + '”' : '') + (Object.keys(h.alteracoes || {}).length ? '<div class="muted mono" style="word-break:break-word">' + esc(Object.keys(h.alteracoes).join(", ")) + '</div>' : '') + '</div>';
      }).join("") + '</div>' +
      '<div class="modal-actions">' + '<button class="btn btn-ghost" id="in_print">🖨️ Imprimir registro</button>' +
        (pode && i.status !== "encerrado" ? '<button class="btn btn-good" id="in_enc">Encerrar incidente</button>' : '') +
        (pode && i.status === "encerrado" ? '<button class="btn btn-outline" id="in_reab">Reabrir</button>' : '') + '</div>', { wide: true, sticky: true });

    var atualizaIndicio = function () {
      var ind = el.querySelector("#in_sig").checked && marcados(el, "a5").length > 0;
      el.querySelector("#in_ind").style.display = ind ? "" : "none";
    };
    el.addEventListener("change", function (e) { if (e.target.id === "in_sig" || e.target.name === "a5") atualizaIndicio(); });
    var num = function (id) { var v = el.querySelector(id).value; return v === "" ? null : Math.max(0, parseInt(v, 10) || 0); };
    if (el.querySelector("#in_salvar")) el.querySelector("#in_salvar").addEventListener("click", async function () {
      var b = this; b.disabled = true; el.querySelector("#in_err").textContent = "";
      var dados = {
        titulo: el.querySelector("#in_tit").value.trim(), status: el.querySelector("#in_st").value,
        ciencia_em: A.localParaIso(el.querySelector("#in_ci").value), ocorrido_em: A.localParaIso(el.querySelector("#in_oc").value),
        descricao: el.querySelector("#in_desc").value.trim() || null, causa: el.querySelector("#in_causa").value.trim() || null,
        categorias_dados: marcados(el, "cd"), categorias_titulares: marcados(el, "ct"),
        sistemas_afetados: el.querySelector("#in_sis").value.split(",").map(function (x) { return x.trim(); }).filter(Boolean),
        qtd_titulares: num("#in_q"), qtd_vulneraveis: num("#in_qv"), qtd_titulares_tratados: num("#in_qt"),
        afeta_significativamente: el.querySelector("#in_sig").checked, criterios_art5: marcados(el, "a5"),
        avaliacao_risco: el.querySelector("#in_av").value, justificativa_risco: el.querySelector("#in_jr").value.trim() || null,
        danos_possiveis: el.querySelector("#in_dano").value.trim() || null, medidas_contencao: el.querySelector("#in_mc").value.trim() || null,
        medidas_mitigacao: el.querySelector("#in_mm").value.trim() || null, medidas_seguranca_previas: el.querySelector("#in_ms").value.trim() || null,
        evidencias: el.querySelector("#in_ev").value.trim() || null
      };
      try {
        var r = await A.API.atualizarIncidente(i.id, dados, el.querySelector("#in_com").value.trim());
        A.closeModal(); A.toast(r && r.sem_alteracao ? "Nada foi alterado" : "Incidente atualizado"); abrirIncidente(i.id);
      } catch (e) { el.querySelector("#in_err").textContent = A.errMsg(e); b.disabled = false; }
    });
    if (el.querySelector("#cm_ok")) el.querySelector("#cm_ok").addEventListener("click", async function () {
      var b = this; b.disabled = true;
      try {
        await A.API.registrarComunicacao(i.id, el.querySelector("#cm_dest").value, A.localParaIso(el.querySelector("#cm_q").value),
          el.querySelector("#cm_m").value.trim(), el.querySelector("#cm_r").value.trim(), el.querySelector("#cm_p").value.trim());
        A.closeModal(); A.toast("Comunicação registrada"); abrirIncidente(i.id);
      } catch (e) { el.querySelector("#cm_err").textContent = A.errMsg(e); b.disabled = false; }
    });
    var pedirMotivo = function (titulo, acao, okMsg) {
      var m = A.openModal(A.modalHead(titulo) + '<label class="field">Motivo (mín. 10 caracteres)<textarea id="mt_t" rows="3" maxlength="2000"></textarea></label>' +
        '<div class="form-error" id="mt_err"></div><div class="modal-actions"><button class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-primary" id="mt_ok">Confirmar</button></div>');
      m.querySelector("#mt_ok").addEventListener("click", async function () {
        try { await acao(m.querySelector("#mt_t").value.trim()); A.closeModal(); A.closeModal(); A.toast(okMsg); abrirIncidente(i.id); }
        catch (e) { m.querySelector("#mt_err").textContent = A.errMsg(e); }
      });
    };
    if (el.querySelector("#in_enc")) el.querySelector("#in_enc").addEventListener("click", function () {
      pedirMotivo("Encerrar incidente nº " + i.numero, function (mt) { return A.API.encerrarIncidente(i.id, mt); }, "Incidente encerrado");
    });
    if (el.querySelector("#in_reab")) el.querySelector("#in_reab").addEventListener("click", function () {
      pedirMotivo("Reabrir incidente nº " + i.numero, function (mt) { return A.API.reabrirIncidente(i.id, mt); }, "Incidente reaberto");
    });
    el.querySelector("#in_print").addEventListener("click", function () { imprimirIncidente(d); });
  }
  function imprimirIncidente(d) {
    var i = d.incidente, area = $("printArea"), lst = function (a, ref) { return (a || []).map(function (k) { var f = (ref || []).find(function (o) { return o[0] === k; }); return f ? f[1] : k; }).join("; ") || "—"; };
    var linha = function (t, v) { return '<tr><th style="text-align:left;vertical-align:top;width:34%;padding:4px 8px;border:1px solid #999">' + t + '</th><td style="padding:4px 8px;border:1px solid #999;white-space:pre-wrap">' + (v == null || v === "" ? "—" : v) + '</td></tr>'; };
    area.className = "";
    area.innerHTML = '<div style="font-family:Arial,sans-serif;font-size:10.5pt;color:#000;padding:0 4mm">' +
      '<h2 style="margin:0 0 4px">Registro de Incidente de Segurança nº ' + i.numero + '</h2>' +
      '<div style="font-size:9pt;margin-bottom:8px">Res. CD/ANPD nº 15/2024, art. 10 · gerado em ' + esc(A.fmtDateTime(new Date().toISOString())) + ' · guarda mínima de 5 anos</div>' +
      '<table style="border-collapse:collapse;width:100%">' +
      linha("Título", esc(i.titulo)) + linha("Situação", INC_STATUS[i.status] + (i.encerrado_em ? " em " + esc(A.fmtDateTime(i.encerrado_em)) : "")) +
      linha("I · Data de conhecimento (ciência)", esc(A.fmtDateTime(i.ciencia_em))) + linha("Detectado / ocorrido", esc(A.fmtDateTime(i.detectado_em)) + " / " + esc(A.fmtDateTime(i.ocorrido_em))) +
      linha("II · Circunstâncias", esc(i.descricao)) + linha("Causa", esc(i.causa)) +
      linha("III · Natureza e categoria dos dados", esc(lst(i.categorias_dados, CAT_DADOS))) + linha("Titulares", esc(lst(i.categorias_titulares, CAT_TIT))) +
      linha("Sistemas afetados", esc((i.sistemas_afetados || []).join(", "))) +
      linha("IV · Nº de titulares afetados", esc(i.qtd_titulares) + (i.qtd_vulneraveis != null ? " (vulneráveis: " + esc(i.qtd_vulneraveis) + ")" : "") + (i.qtd_titulares_tratados != null ? " de " + esc(i.qtd_titulares_tratados) + " tratados" : "")) +
      linha("V · Avaliação de risco", esc(INC_AVAL[i.avaliacao_risco]) + "\nCritérios do art. 5º: " + esc(lst(i.criterios_art5, ART5)) + "\n" + esc(i.justificativa_risco || "")) +
      linha("Possíveis danos", esc(i.danos_possiveis)) +
      linha("VI · Medidas de contenção / correção e mitigação", esc([i.medidas_contencao, i.medidas_mitigacao].filter(Boolean).join("\n\n"))) +
      linha("Medidas de segurança prévias", esc(i.medidas_seguranca_previas)) + linha("Evidências preservadas", esc(i.evidencias) + "\nÂncora da auditoria: evento #" + esc(i.ancora_evento_id) + " · " + esc(i.ancora_hash)) +
      linha("VII · Comunicações (forma e conteúdo)", d.comunicacoes.map(function (c) { return esc(INC_DEST[c.destinatario] + " — " + A.fmtDateTime(c.realizada_em) + " — " + c.meio + (c.protocolo ? " — protocolo " + c.protocolo : "") + "\n" + c.resumo); }).join("\n\n")) +
      linha("VIII · Motivos da ausência de comunicação", i.avaliacao_risco === "sem_risco_relevante" ? esc(i.justificativa_risco) : "—") +
      linha("Encerramento", esc(i.motivo_encerramento)) + '</table>' +
      '<h3 style="margin:10px 0 4px;font-size:11pt">Histórico</h3><div style="font-size:9pt">' + d.historico.map(function (h) {
        return esc(A.fmtDateTime(h.em) + " · " + h.acao + " · " + (h.ator_email || "sistema") + (h.comentario ? " — " + h.comentario : "") + (Object.keys(h.alteracoes || {}).length ? " [" + Object.keys(h.alteracoes).join(", ") + "]" : ""));
      }).join("<br>") + '</div></div>';
    var st = document.getElementById("pageStyle") || document.head.appendChild(Object.assign(document.createElement("style"), { id: "pageStyle" }));
    st.textContent = "@page{size:A4 portrait;margin:12mm}@media print{#printArea .lbl70{page-break-after:auto}}";
    document.body.classList.add("printing");
    var done = function () { document.body.classList.remove("printing"); area.innerHTML = ""; st.textContent = ""; window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    setTimeout(function () { window.print(); setTimeout(function () { if (!matchMedia("print").matches) done(); }, 500); }, 60);
  }
  async function enquadramento() {
    var cfg = {}; try { cfg = await A.API.lerConfigPrivacidade(); } catch (e) { }
    var m = A.openModal(A.modalHead("Enquadramento como agente de pequeno porte") +
      '<p class="small">Agentes de pequeno porte (Res. CD/ANPD nº 2/2022) têm os prazos de comunicação de incidentes <strong>contados em dobro</strong> (Res. 15/2024, art. 6º §8º e art. 9º §6º). ' +
      'Só marque após confirmar o enquadramento com o jurídico. A mudança fica registrada como evento crítico.</p>' +
      '<label class="chk"><input type="checkbox" id="pp_v"' + (cfg.agente_pequeno_porte ? " checked" : "") + '> A organização é agente de tratamento de pequeno porte</label>' +
      '<label class="field" style="margin-top:10px">Fundamento / justificativa<textarea id="pp_j" rows="3" maxlength="500">' + esc(cfg.justificativa || "") + '</textarea></label>' +
      '<div class="form-error" id="pp_err"></div><div class="modal-actions"><button class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-primary" id="pp_ok">Salvar</button></div>');
    m.querySelector("#pp_ok").addEventListener("click", async function () {
      try { await A.API.definirPequenoPorte(m.querySelector("#pp_v").checked, m.querySelector("#pp_j").value.trim()); A.closeModal(); A.toast("Enquadramento salvo"); }
      catch (e) { m.querySelector("#pp_err").textContent = A.errMsg(e); }
    });
  }

  /* ================================================================ AUDITORIA (perfil auditor) */
  function diaISO(offset) { var d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); }
  var audF = { de: diaISO(-7), ate: diaISO(0), categoria: "", acao: "", resultado: "", recurso: "", ator_email: "", correlacao: "" };
  var aud = { itens: [], prox: null, carregando: false, erro: "", feito: false };
  var CAT_AUD = ["", "movimentacao", "dados", "autenticacao", "autorizacao", "exportacao", "importacao", "privacidade", "auditoria", "seguranca", "aplicacao", "operacao", "compartilhamento"];
  function periodo() {
    return { de: new Date(audF.de + "T00:00:00").toISOString(), ate: new Date(audF.ate + "T23:59:59.999").toISOString() };
  }
  async function buscarAud(reset) {
    if (aud.carregando) return;
    aud.carregando = true; aud.erro = "";
    if (reset) { aud.itens = []; aud.prox = null; }
    drawAud();
    try {
      var p = periodo();
      var r = await A.API.consultarAuditoria(Object.assign({}, audF, { de: p.de, ate: p.ate, antes_de: reset ? null : aud.prox, limite: 50 }));
      aud.itens = aud.itens.concat(r.itens || []); aud.prox = r.proximo_antes_de || null; aud.feito = true;
    } catch (e) { aud.erro = A.errMsg(e); }
    aud.carregando = false; drawAud();
  }
  function badgeRes(r) { return '<span class="badge ' + (r === "sucesso" ? "badge-good" : r === "negado" ? "badge-late" : "badge-warn") + '">' + esc(r) + '</span>'; }
  function drawAud() {
    var info = $("audInfo"), list = $("audList"), more = $("audMore");
    if (!list) return;
    info.innerHTML = aud.erro ? '<div class="form-error">' + esc(aud.erro) + '</div>' :
      aud.carregando ? '<div class="small muted">Consultando…</div>' :
      aud.feito ? '<div class="small muted">' + aud.itens.length + ' evento(s) carregado(s). Toda consulta fica registrada na própria auditoria.</div>' : "";
    list.innerHTML = !aud.itens.length ? (aud.feito && !aud.carregando ? '<div class="card empty"><span class="ic">🔍</span>Nenhum evento no período/filtros.</div>' : "") :
      '<div class="table-wrap" style="max-height:none"><table class="tbl"><thead><tr><th>#</th><th>Quando (local)</th><th>Ator</th><th>Categoria</th><th>Ação</th><th>Recurso</th><th>Resultado</th><th>Motivo</th><th></th></tr></thead><tbody>' +
      aud.itens.map(function (e) {
        return '<tr' + (e.criticidade === "critica" ? ' style="background:var(--danger-bg)"' : "") + '><td class="mono">' + e.id + '</td><td class="mono">' + esc(A.fmtDateTime(e.ocorrido_em)) + '</td>' +
          '<td>' + esc(e.ator_email || e.ator_tipo) + '</td><td>' + esc(e.categoria) + '</td><td><strong>' + esc(e.acao) + '</strong></td>' +
          '<td class="mono">' + esc((e.recurso || "") + (e.recurso_id ? " · " + String(e.recurso_id).slice(0, 8) : "")) + '</td><td>' + badgeRes(e.resultado) + '</td>' +
          '<td>' + esc(e.motivo || "") + '</td><td><button class="btn btn-outline btn-sm" data-ev="' + e.id + '">Detalhes</button></td></tr>';
      }).join("") + '</tbody></table></div>';
    more.innerHTML = aud.prox && !aud.carregando ? '<button class="btn btn-ghost btn-block" id="audMoreBtn" style="margin-top:10px">Carregar mais 50</button>' : "";
    if ($("audMoreBtn")) $("audMoreBtn").addEventListener("click", function () { buscarAud(false); });
  }
  var Auditoria = {
    build: function (el) {
      el.innerHTML =
        '<div class="card" style="margin-bottom:14px"><form id="audForm"><div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">' +
          '<label class="field">De<input type="date" id="au_de" value="' + audF.de + '"></label>' +
          '<label class="field">Até<input type="date" id="au_ate" value="' + audF.ate + '"></label>' +
          '<label class="field">Categoria<select id="au_cat">' + CAT_AUD.map(function (c) { return '<option value="' + c + '">' + (c || "Todas") + '</option>'; }).join("") + '</select></label>' +
          '<label class="field">Resultado<select id="au_res"><option value="">Todos</option><option>sucesso</option><option>falha</option><option>negado</option><option>parcial</option></select></label>' +
          '<label class="field">Ação<input id="au_acao" placeholder="ex.: retirada, delete" maxlength="60"></label>' +
          '<label class="field">Recurso<input id="au_rec" placeholder="ex.: funcionarios" maxlength="60"></label>' +
          '<label class="field">E-mail do ator<input id="au_ator" placeholder="ex.: maria@empresa.com" maxlength="120"></label>' +
          '<label class="field">Correlação<input id="au_corr" class="mono" maxlength="64"></label>' +
        '</div><div class="row" style="margin-top:12px"><button class="btn btn-primary" type="submit">Buscar</button><span class="spacer"></span>' +
          '<button class="btn btn-ghost" type="button" id="audVerif">🔒 Verificar integridade</button>' +
          '<button class="btn btn-ghost" type="button" id="audExp">⬇ Exportar período</button></div></form></div>' +
        '<div id="audInfo"></div><div id="audList"></div><div id="audMore"></div>';
      $("audForm").addEventListener("submit", function (e) {
        e.preventDefault();
        audF = { de: $("au_de").value, ate: $("au_ate").value, categoria: $("au_cat").value, resultado: $("au_res").value, acao: $("au_acao").value.trim(),
          recurso: $("au_rec").value.trim(), ator_email: $("au_ator").value.trim(), correlacao: $("au_corr").value.trim() };
        buscarAud(true);
      });
      on($("audList"), "click", "[data-ev]", function (b) {
        var e = aud.itens.find(function (x) { return String(x.id) === b.dataset.ev; }); if (!e) return;
        A.openModal(A.modalHead("Evento #" + e.id) +
          '<dl class="kv">' + ["evento_uuid", "ocorrido_em", "ator_email", "ator_id", "ator_tipo", "categoria", "acao", "criticidade", "recurso", "recurso_id", "resultado", "motivo", "correlacao_id", "origem", "versao_esquema", "hash"]
            .map(function (k) { return '<dt>' + k + '</dt><dd class="mono" style="word-break:break-all;font-weight:500">' + esc(e[k] == null ? "—" : e[k]) + '</dd>'; }).join("") + '</dl>' +
          '<div class="section-title">Contexto</div><pre class="mono small" style="white-space:pre-wrap;word-break:break-all;background:var(--surface-2);padding:10px;border-radius:10px">' +
          esc(JSON.stringify(e.contexto, null, 2)) + '</pre>', { wide: true });
      });
      $("audVerif").addEventListener("click", async function () {
        var b = $("audVerif"); b.disabled = true; b.textContent = "Verificando…";
        try {
          var r = await A.API.verificarIntegridade(function (n) { b.textContent = "Verificando… " + n; });
          var m = A.openModal(A.modalHead("Verificação de integridade") +
            (r.ok ? '<p style="color:var(--good);font-weight:700">✓ Cadeia íntegra — ' + r.eventos_verificados + ' eventos verificados.</p>'
                  : r.erro ? '<p class="form-error">' + esc(r.erro) + '</p>'
                  : '<p style="color:var(--danger);font-weight:700">✗ Problema no evento #' + esc(r.primeiro_erro_id) + ' (' + esc(r.tipo_erro) + '). Preserve as evidências e abra um registro de incidente.</p>') +
            (r.ultimo_hash ? '<div class="section-title">Âncora de hoje (anote fora do sistema)</div>' +
              '<p class="mono small" style="word-break:break-all;background:var(--surface-2);padding:10px;border-radius:10px">Evento #' + esc(r.ultimo_id) + '<br>' + esc(r.ultimo_hash) + '</p>' +
              '<p class="small muted">Envie o número e o hash acima, com a data, para fora do sistema (ex.: e-mail para a área de segurança). ' +
              'A verificação acima <strong>não</strong> detecta sozinha uma cadeia inteira reescrita ou o corte do final por quem administra o banco — ' +
              'para isso, confira periodicamente as âncoras anotadas abaixo.</p>' : "") +
            '<div class="section-title">Conferir uma âncora anotada</div><div class="row" style="flex-wrap:nowrap">' +
            '<input class="search-input mono" id="anc_id" placeholder="nº do evento" style="max-width:120px;min-width:0" inputmode="numeric">' +
            '<input class="search-input mono" id="anc_h" placeholder="hash anotado" style="min-width:0">' +
            '<button class="btn btn-ghost" id="anc_ok">Conferir</button></div><div class="small" id="anc_res" style="margin-top:8px"></div>');
          m.querySelector("#anc_ok").addEventListener("click", async function () {
            var id = parseInt(m.querySelector("#anc_id").value, 10), h = m.querySelector("#anc_h").value.trim();
            if (!id || !/^[0-9a-fA-F]{64}$/.test(h)) { m.querySelector("#anc_res").textContent = "Informe o número do evento e o hash de 64 caracteres."; return; }
            try {
              var c = await A.API.confirmarAncora(id, h);
              var el = m.querySelector("#anc_res"); el.textContent = c.erro || c.mensagem; el.style.color = c.ok ? "var(--good)" : "var(--danger)"; el.style.fontWeight = "700";
            } catch (e) { m.querySelector("#anc_res").textContent = A.errMsg(e); }
          });
        } catch (e) { A.toast(A.errMsg(e), 5000); }
        b.disabled = false; b.textContent = "🔒 Verificar integridade";
      });
      $("audExp").addEventListener("click", function () {
        var p;
        try { p = periodo(); } catch (e) { return A.toast("Período inválido"); }
        var m = A.openModal(A.modalHead("Exportar auditoria") +
          '<p class="small">Período: <strong>' + esc(audF.de) + '</strong> a <strong>' + esc(audF.ate) + '</strong> (máx. 366 dias e 5.000 eventos).</p>' +
          '<p class="small muted">O arquivo contém e-mails de usuários e identificadores internos. Guarde em local de acesso restrito e apague quando a finalidade for cumprida. A exportação fica registrada.</p>' +
          '<label class="field">Finalidade (obrigatória)<textarea id="ex_fin" rows="2" maxlength="200" placeholder="Ex.: auditoria interna mensal de controles"></textarea></label>' +
          '<div class="form-error" id="ex_err"></div><div class="modal-actions"><button class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-primary" id="ex_ok">Exportar</button></div>');
        m.querySelector("#ex_ok").addEventListener("click", async function () {
          var fin = m.querySelector("#ex_fin").value.trim();
          if (fin.length < 10) { m.querySelector("#ex_err").textContent = "Descreva a finalidade (mínimo 10 caracteres)."; return; }
          this.disabled = true;
          try {
            var r = await A.API.exportarAuditoria(p.de, p.ate, fin);
            var cols = ["id", "evento_uuid", "ocorrido_em", "ator_email", "ator_id", "ator_tipo", "categoria", "acao", "criticidade", "recurso", "recurso_id", "resultado", "motivo", "correlacao_id", "origem", "versao_esquema", "hash_anterior", "hash"];
            var linhas = [cols.concat(["contexto"])].concat((r.itens || []).map(function (e) {
              return cols.map(function (c) { return e[c] == null ? "" : (c === "id" || c === "versao_esquema" ? Number(e[c]) : String(e[c])); }).concat([JSON.stringify(e.contexto || {})]);
            }));
            await salvarXlsx(linhas, "auditoria_" + audF.de + "_a_" + audF.ate + ".xlsx");
            A.closeModal(); A.toast((r.itens || []).length + " evento(s) exportado(s)");
          } catch (e) { m.querySelector("#ex_err").textContent = A.errMsg(e); this.disabled = false; }
        });
      });
      buscarAud(true);
    },
    update: function () { drawAud(); }   // não consulta sozinho: cada consulta gera um evento
  };

  /* ================================================================ navegação */
  var VIEWS = { painel: Painel, escanear: Escanear, ferramentas: Ferramentas, funcionarios: Funcionarios, etiquetas: Etiquetas, historico: Historico, fornecedores: Fornecedores, incidentes: Incidentes, auditoria: Auditoria };
  var built = {};

  function renderChrome() {
    var sel = $("siteSelect"), ss = sites();
    if (currentSite !== "all" && ss.indexOf(currentSite) < 0) currentSite = "all";
    sel.innerHTML = '<option value="all">Todos os almoxarifados</option>' + ss.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join("");
    sel.value = currentSite;
    document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === currentTab); });
    var late = A.lateTools().length, badge = $("alertCount");
    badge.hidden = !late; badge.textContent = late;
    $("demoBanner").hidden = !A.DEMO;
    $("userTag").textContent = (A.DEMO ? "modo demonstração" : (S.user && S.user.email) || "") + (S.papeis.length ? " · " + S.papeis.join(", ") : "");
    // Interface por perfil (a autorização real é feita no servidor; isto só evita botões inúteis)
    document.body.classList.toggle("pode-operar", A.tem(["almoxarife", "gestor"]));
    document.body.classList.toggle("e-gestor", A.tem("gestor"));
    document.body.classList.toggle("ve-assinatura", A.tem(["gestor", "auditor"]));
    $("tabAuditoria").hidden = !A.tem("auditor");
    $("tabIncidentes").hidden = !A.tem(["gestor", "encarregado", "auditor"]);
    document.body.classList.toggle("e-encarregado", A.tem("encarregado"));
    var incPrazo = S.incidentes.filter(function (i) { return i.dias_uteis_para_prazo != null && i.dias_uteis_para_prazo <= 1; }).length;
    var incAbertos = S.incidentes.filter(function (i) { return i.status !== "encerrado"; }).length;
    $("incCount").hidden = !incAbertos || $("tabIncidentes").hidden; $("incCount").textContent = incAbertos;
    $("incCount").style.background = incPrazo ? "var(--danger)" : "var(--warn)";
  }
  function render() {
    renderChrome();
    var v = VIEWS[currentTab], el = $("view-" + currentTab);
    if (!built[currentTab]) { v.build(el); built[currentTab] = true; }
    v.update();
  }
  function setTab(tab) {
    if (TABS.indexOf(tab) < 0 || (tab === "auditoria" && !A.tem("auditor")) || (tab === "incidentes" && !A.tem(["gestor", "encarregado", "auditor"]))) tab = "painel";
    if (currentTab === "escanear" && tab !== "escanear") stopScan();
    currentTab = tab;
    TABS.forEach(function (t) { $("view-" + t).hidden = t !== tab; });
    if (location.hash !== "#" + tab) history.replaceState(null, "", "#" + tab);
    render();
    window.scrollTo(0, 0);
  }

  $("tabbar").addEventListener("click", function (e) { var b = e.target.closest(".tab-btn"); if (b) setTab(b.dataset.tab); });
  $("siteSelect").addEventListener("change", function (e) { currentSite = e.target.value; try { localStorage.setItem("almox_site", currentSite); } catch (x) { } render(); });
  $("logoutBtn").addEventListener("click", function () { A.askConfirm("Sair do sistema?", A.logout, "Sair"); });
  // Abrir o WhatsApp com dados do funcionário é um compartilhamento: fica registrado
  document.addEventListener("click", function (e) { var a = e.target.closest("a[data-wa]"); if (a) A.auditarSilencioso("compartilhamento_whatsapp", a.dataset.wa); });

  A.onChange(function () { render(); notifyLate(); });
  setInterval(function () { render(); notifyLate(); }, 60000);

  $("reportIncBtn").addEventListener("click", function () { A.openReportIncident(); });
  A.boot(function () {
    var inicial = (location.hash || "#painel").slice(1);
    if (inicial === "painel" && A.tem("encarregado") && !A.tem(["almoxarife", "gestor", "auditor"])) inicial = "incidentes";
    setTab(inicial);
    notifyLate();
  });
})();
