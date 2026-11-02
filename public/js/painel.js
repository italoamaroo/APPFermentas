/* =====================================================================
   Almoxarifado — Painel (desktop / tablet)
   ===================================================================== */
(function () {
  "use strict";
  var A = window.Almox, S = A.S, esc = A.esc;

  var TABS = ["painel", "escanear", "ferramentas", "funcionarios", "etiquetas", "historico", "fornecedores"];
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
  async function run(promise, okMsg) {
    try { await promise; if (okMsg) A.toast(okMsg); return true; }
    catch (e) { A.toast(A.errMsg(e), 4500); return false; }
  }

  /* ================================================================ PAINEL */
  var Painel = {
    build: function (el) {
      el.innerHTML = '<div id="pnStats"></div><div id="pnAlert"></div>' +
        '<div class="quick-row" style="margin-top:16px;">' +
          '<button class="btn btn-primary" data-go="escanear">🔎 Escanear ferramenta</button>' +
          '<button class="btn btn-ghost" id="pnNew">+ Cadastrar ferramenta</button>' +
          '<button class="btn btn-ghost" data-go="etiquetas">🏷️ Imprimir etiquetas</button>' +
        '</div>' +
        '<div class="section-title">Em uso agora</div><div id="pnUso"></div>' +
        '<div class="section-title">Atividade recente</div><div id="pnHist"></div>' +
        '<div id="pnTop"></div>';
      on(el, "click", "[data-go]", function (b) { setTab(b.dataset.go); });
      $("pnNew").addEventListener("click", function () { toolForm(null); });
      on(el, "click", "[data-ret]", function (b) { var t = A.toolById(b.dataset.ret); if (t) A.openReturn(t); });
      on(el, "click", "[data-notif]", function () {
        if (!("Notification" in window)) return A.toast("Este navegador não suporta notificações");
        Notification.requestPermission().then(function () { Painel.update(); notifyLate(true); });
      });
      on(el, "click", "[data-sig]", function (b) { var m = S.movimentacoes.find(function (x) { return x.id === b.dataset.sig; }); if (m) A.showSignature(m); });
    },
    update: function () {
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
              (wa ? '<a class="btn btn-outline btn-sm" target="_blank" rel="noopener" href="' + esc(wa) + '">WhatsApp</a>' : "") +
              '<button class="btn btn-good btn-sm" data-ret="' + t.id + '">Devolver</button></div>';
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
            '<button class="btn btn-good btn-sm" data-ret="' + t.id + '">Devolver</button></div>';
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
      (h.assinatura_path ? '<button class="btn btn-outline btn-sm" data-sig="' + h.id + '" title="Ver assinatura">✍️</button>' : "") +
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
    if (t.status === "disponivel") h += '<button class="btn btn-primary btn-block" style="margin-top:14px;" data-act="out">Retirar ferramenta</button>';
    else if (t.status === "em_uso") h += '<button class="btn btn-good btn-block" style="margin-top:14px;" data-act="back">Registrar devolução</button>';
    else h += '<button class="btn btn-outline btn-block" style="margin-top:14px;" data-act="maint">Concluir manutenção</button>';
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
        '<button class="btn btn-primary" id="ferNew">+ Nova</button></div><div id="ferList"></div>';
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
              (t.status === "disponivel" ? '<button class="btn btn-primary btn-sm" data-a="out" data-id="' + t.id + '">Retirar</button>' : "") +
              (t.status === "em_uso" ? '<button class="btn btn-good btn-sm" data-a="back" data-id="' + t.id + '">Devolver</button>' : "") +
              '<button class="btn btn-outline btn-sm" data-a="qr" data-id="' + t.id + '">QR</button>' +
              '<button class="btn btn-outline btn-sm" data-a="label" data-id="' + t.id + '">Etiqueta</button>' +
              '<button class="btn btn-outline btn-sm" data-a="edit" data-id="' + t.id + '">Editar</button>' +
              '<button class="btn btn-outline btn-sm" data-a="maint" data-id="' + t.id + '">' + (t.status === "manutencao" ? "Concluir" : "Manutenção") + '</button>' +
              '<button class="btn btn-danger btn-sm" data-a="del" data-id="' + t.id + '">Excluir</button>' +
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
        '<button class="btn btn-ghost" id="funImport">⬆ Importar planilha</button>' +
        '<button class="btn btn-primary" id="funNew">+ Novo</button></div>' +
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
              '<button class="btn btn-outline btn-sm" data-a="edit" data-id="' + f.id + '">Editar</button>' +
              '<button class="btn btn-danger btn-sm" data-a="del" data-id="' + f.id + '">Excluir</button></div></div>';
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
        '<label class="dropzone" id="impDrop"><input type="file" id="impFile" accept=".xlsx,.xls,.csv,.ods" hidden>' +
          '<strong>Clique ou arraste a planilha aqui</strong><span class="small muted">Excel (.xlsx, .xls), CSV ou ODS. Colunas reconhecidas: Matrícula, Nome, Função/Cargo, Setor/Obra, Telefone.</span></label>' +
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
        A.toast("Importação concluída: " + st.toSave.length + " salvos" + (ids.length ? ", " + ids.length + " desativados" : ""), 4000);
        importState = null; drawImport();
      } catch (e) { $("impErr").textContent = A.errMsg(e); b.disabled = false; b.textContent = "Tentar de novo"; }
    });
  }

  function readFile(file) {
    if (!window.XLSX) return A.toast("Leitor de planilhas ainda carregando, tente de novo");
    var r = new FileReader();
    r.onload = function () {
      try {
        var wb = XLSX.read(new Uint8Array(r.result), { type: "array" });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
        parseRows(rows, file.name);
      } catch (e) { A.toast("Não consegui ler a planilha: " + e.message, 5000); }
    };
    r.readAsArrayBuffer(file);
  }

  function parseRows(rows, fileName) {
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
    importState = { step: "preview", fileName: fileName, cols: cols, preview: preview, toSave: toSave, novos: novos, alterados: alterados, iguais: iguais, erros: erros, missing: missing, deactivate: false };
    drawImport();
  }

  function downloadTemplate() {
    if (!window.XLSX) return;
    var ws = XLSX.utils.aoa_to_sheet([["Matrícula", "Nome", "Função", "Setor", "Telefone"], ["1001", "Fulano de Tal", "Pedreiro", "Obra Centro", "81999999999"], ["1002", "Beltrano da Silva", "Eletricista", "Obra Centro", ""]]);
    ws["!cols"] = [{ wch: 12 }, { wch: 32 }, { wch: 18 }, { wch: 20 }, { wch: 16 }];
    var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Funcionarios");
    XLSX.writeFile(wb, "modelo_funcionarios.xlsx");
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
          '<div class="row" style="margin:12px 0;"><span id="etqCount" class="small muted"></span><span class="spacer"></span><button class="btn btn-primary" id="etqPrint">🖨️ Imprimir</button></div>' +
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
      $("hisExport").addEventListener("click", function () {
        if (!window.XLSX) return;
        var rows = hisFiltered().map(function (h) {
          return { "Data/hora": A.fmtDateTime(h.created_at), "Ação": A.ACTION_LABEL[h.acao] || h.acao, "Código": h.ferramenta_codigo, "Ferramenta": h.ferramenta_nome,
            "Funcionário": h.funcionario_nome || "", "Matrícula": h.matricula || "", "Almoxarifado": h.site || "", "Observação": h.observacao || "",
            "Assinado": h.assinatura_path ? "Sim" : "Não", "Registrado por": h.usuario_email || "" };
        });
        var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Historico");
        XLSX.writeFile(wb, "historico_almoxarifado_" + new Date().toISOString().slice(0, 10) + ".xlsx");
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
      el.innerHTML = '<div class="toolbar"><div style="flex:1;"></div><button class="btn btn-primary" id="fornNew">+ Novo fornecedor</button></div><div id="fornList"></div>';
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
            '<button class="btn btn-danger btn-sm" data-del="' + s.id + '">Excluir</button></div>';
        }).join("") + '</div>';
    }
  };

  /* ================================================================ navegação */
  var VIEWS = { painel: Painel, escanear: Escanear, ferramentas: Ferramentas, funcionarios: Funcionarios, etiquetas: Etiquetas, historico: Historico, fornecedores: Fornecedores };
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
    $("userTag").textContent = A.DEMO ? "modo demonstração" : (S.user && S.user.email) || "";
  }
  function render() {
    renderChrome();
    var v = VIEWS[currentTab], el = $("view-" + currentTab);
    if (!built[currentTab]) { v.build(el); built[currentTab] = true; }
    v.update();
  }
  function setTab(tab) {
    if (TABS.indexOf(tab) < 0) tab = "painel";
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

  A.onChange(function () { render(); notifyLate(); });
  setInterval(function () { render(); notifyLate(); }, 60000);

  A.boot(function () {
    setTab((location.hash || "#painel").slice(1));
    notifyLate();
  });
})();
