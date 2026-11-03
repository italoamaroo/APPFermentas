/* =====================================================================
   Almoxarifado — App do celular
   Fluxo: escanear ferramenta → escolher funcionário (busca ou crachá QR)
          → assinatura na tela → confirmar
   ===================================================================== */
(function () {
  "use strict";
  var A = window.Almox, S = A.S, esc = A.esc;
  function $(id) { return document.getElementById(id); }

  var st = { tab: "scan", step: "scan", toolId: null, func: null, done: null };
  var scanner = null, pad = null, camWanted = false;

  function tool() { return st.toolId ? A.toolById(st.toolId) : null; }
  function go(step) { st.step = step; drawScan(); window.scrollTo(0, 0); }
  function steps(n) { return '<div class="app-steps">' + [1, 2, 3, 4].map(function (i) { return '<span class="' + (i <= n ? "on" : "") + '"></span>'; }).join("") + '</div>'; }

  function toolSummary(t, compact) {
    var f = A.holder(t);
    return '<div class="card"><div class="tool-head"><div><div class="name">' + esc(t.nome) + '</div>' +
      '<div class="mono muted small">' + esc(t.codigo) + (t.patrimonio ? " · " + esc(t.patrimonio) : "") + '</div></div>' +
      '<span class="badge ' + A.STATUS_BADGE[t.status] + '">' + A.STATUS_LABEL[t.status] + '</span></div>' +
      (compact ? "" : '<dl class="kv"><dt>Almoxarifado</dt><dd>' + esc(t.site || "—") + '</dd><dt>Tipo</dt><dd>' + esc(t.tipo || "—") + '</dd>' +
        (t.status === "em_uso" ? '<dt>Com</dt><dd>' + esc(A.fmtWorker(f)) + '</dd><dt>Desde</dt><dd>' + A.fmtDateTime(t.retirada_em) + ' (' + A.fmtElapsed(t.retirada_em) + ')</dd>' : "") +
        (t.observacoes ? '<dt>Nota</dt><dd>' + esc(t.observacoes) + '</dd>' : "") + '</dl>') +
      (A.isLate(t) ? '<div class="late-box">⚠ Está há ' + A.daysLabel(t.retirada_em) + ' com o mesmo funcionário</div>' : "") +
      '</div>';
  }

  /* ------------------------------------------------------------ telas */
  function drawScan() {
    var el = $("view-scan");
    if (scanner) scanner.stop();
    var t = tool();
    if (st.step !== "scan" && st.step !== "done" && !t) st.step = "scan";

    if (st.step === "scan") {
      el.innerHTML = steps(1) +
        '<div class="card">' + A.scannerMarkup("camVideo") +
        '<div class="scan-status" id="camStatus">Aponte para o QR da etiqueta da ferramenta.</div>' +
        '<div class="scan-controls"><button class="btn btn-primary big-btn" id="camBtn">📷 Abrir câmera</button></div>' +
        '<div class="divider-or">ou digite o código</div>' +
        '<form id="codeForm" class="row" style="flex-wrap:nowrap"><input class="search-input mono" id="codeIn" placeholder="FRT-001" autocomplete="off" autocapitalize="characters" style="min-width:0">' +
        '<button class="btn btn-ghost" type="submit">Buscar</button></form></div>';
      scanner = A.Scanner($("camVideo"), function (text) {
        var found = A.toolByCode(text);
        if (!found) {
          if (text.indexOf(A.FUNC_PREFIX) === 0) { $("camStatus").textContent = "Esse é o crachá de um funcionário. Escaneie primeiro a ferramenta."; return false; }
          $("camStatus").textContent = "QR “" + text + "” não é de nenhuma ferramenta cadastrada."; return false;
        }
        A.beep(); openTool(found.id); return true;
      });
      $("camBtn").addEventListener("click", function () {
        if (scanner.active) { scanner.stop(); camWanted = false; $("camBtn").textContent = "📷 Abrir câmera"; return; }
        startCam();
      });
      $("codeForm").addEventListener("submit", function (e) {
        e.preventDefault();
        var v = $("codeIn").value.trim(); if (!v) return;
        var found = A.toolByCode(v);
        if (found) openTool(found.id); else A.toast("Código " + v + " não encontrado");
      });
      if (camWanted) startCam();
      return;
    }

    if (st.step === "tool") {
      var act = !A.tem(["almoxarife", "gestor"]) ? '<div class="late-box" style="background:var(--surface-2);color:var(--muted)">Seu perfil é somente consulta — retiradas e devoluções são feitas por almoxarife ou gestor.</div>' :
        t.status === "disponivel" ? '<button class="btn btn-primary big-btn" id="goOut">↗ Retirar ferramenta</button>' :
        t.status === "em_uso" ? '<button class="btn btn-good big-btn" id="goBack">↩ Registrar devolução</button>' :
        '<button class="btn btn-outline big-btn" id="goMaint">✓ Concluir manutenção</button>';
      el.innerHTML = steps(2) + toolSummary(t) + '<div style="margin-top:14px;display:grid;gap:8px;">' + act +
        '<button class="btn btn-ghost btn-block" id="goScan">Escanear outra</button></div>';
      if ($("goOut")) $("goOut").addEventListener("click", function () { st.func = null; go("func"); });
      if ($("goBack")) $("goBack").addEventListener("click", function () { go("return"); });
      if ($("goMaint")) $("goMaint").addEventListener("click", async function () {
        try { await A.API.manutencao(t.id, false); finish("Manutenção concluída", t.nome + " está disponível novamente."); } catch (e) { A.toast(A.errMsg(e), 4500); }
      });
      $("goScan").addEventListener("click", reset);
      return;
    }

    if (st.step === "func") {
      el.innerHTML = steps(2) + toolSummary(t, true) +
        '<div class="section-title">Quem está retirando?</div><div class="card" id="pickBox"></div>' +
        '<div style="margin-top:14px;display:grid;gap:8px;"><button class="btn btn-primary big-btn" id="toSign" disabled>Continuar para assinatura</button>' +
        '<button class="btn btn-ghost btn-block" id="back1">Voltar</button></div>';
      var picker = A.funcionarioPicker($("pickBox"), { onSelect: function (f) { st.func = f; $("toSign").disabled = !f; } });
      if (st.func) picker.set(st.func);
      $("toSign").addEventListener("click", function () { if (st.func) go("sign"); });
      $("back1").addEventListener("click", function () { go("tool"); });
      return;
    }

    if (st.step === "sign") {
      var f = st.func;
      el.innerHTML = steps(3) +
        '<div class="card"><div class="small muted">Ferramenta</div><div style="font-weight:700">' + esc(t.nome) + ' <span class="mono muted" style="font-weight:500">' + esc(t.codigo) + '</span></div>' +
        '<div class="small muted" style="margin-top:8px">Funcionário</div><div style="font-weight:700">' + esc(f.nome) + ' <span class="mono muted" style="font-weight:500">mat. ' + esc(f.matricula) + '</span></div></div>' +
        '<div class="section-title">Assinatura do funcionário</div>' +
        '<p class="small muted" style="margin:-4px 0 8px">Declaro que recebi a ferramenta acima em boas condições e me responsabilizo pela devolução.</p>' +
        A.signatureMarkup("sig", "Assine com o dedo") +
        '<details style="margin-top:10px"><summary class="small muted">Almoxarifado / observação</summary><div class="form-grid" style="margin-top:8px">' +
          '<label class="field">Almoxarifado / obra<input id="sSite" value="' + esc(t.site || "") + '"></label>' +
          '<label class="field">Observação<input id="sObs" placeholder="Opcional"></label></div></details>' +
        '<div class="form-error" id="sErr"></div>' +
        '<div style="margin-top:10px;display:grid;gap:8px;"><button class="btn btn-primary big-btn" id="confirmOut" disabled>Confirmar retirada</button>' +
        '<button class="btn btn-ghost btn-block" id="back2">Voltar</button></div>';
      pad = A.mountSignature(el, "sig");
      pad.setOnChange(function () { $("confirmOut").disabled = pad.isEmpty(); });
      $("back2").addEventListener("click", function () { go("func"); });
      $("confirmOut").addEventListener("click", async function () {
        var b = $("confirmOut"); b.disabled = true; b.textContent = "Salvando…";
        try {
          await A.API.retirar(t.id, f.id, $("sSite").value.trim(), await pad.toBlob(), $("sObs").value.trim());
          finish("Retirada registrada", t.nome + " entregue a " + f.nome + ".");
        } catch (e) { $("sErr").textContent = A.errMsg(e); b.disabled = false; b.textContent = "Confirmar retirada"; }
      });
      return;
    }

    if (st.step === "return") {
      el.innerHTML = steps(3) + toolSummary(t) +
        '<div class="section-title">Assinatura de quem devolve <span style="text-transform:none;letter-spacing:0;font-weight:500">(opcional)</span></div>' +
        A.signatureMarkup("sigR", "Assine com o dedo") +
        '<label class="field" style="margin-top:10px">Estado da ferramenta / observação<input id="rObs" placeholder="Ex.: ok, sem avarias"></label>' +
        '<div class="form-error" id="rErr"></div>' +
        '<div style="margin-top:10px;display:grid;gap:8px;"><button class="btn btn-good big-btn" id="confirmBack">Confirmar devolução</button>' +
        '<button class="btn btn-ghost btn-block" id="back3">Voltar</button></div>';
      pad = A.mountSignature(el, "sigR");
      $("back3").addEventListener("click", function () { go("tool"); });
      $("confirmBack").addEventListener("click", async function () {
        var b = $("confirmBack"); b.disabled = true; b.textContent = "Salvando…";
        var who = A.holder(t);
        try {
          await A.API.devolver(t.id, await pad.toBlob(), $("rObs").value.trim());
          finish("Devolução registrada", t.nome + (who ? " devolvida por " + who.nome : " devolvida") + ".");
        } catch (e) { $("rErr").textContent = A.errMsg(e); b.disabled = false; b.textContent = "Confirmar devolução"; }
      });
      return;
    }

    if (st.step === "done") {
      el.innerHTML = steps(4) + '<div class="card success"><div class="ok">✓</div><h2>' + esc(st.done.title) + '</h2>' +
        '<p class="muted" style="margin:0 0 18px">' + esc(st.done.text) + '</p>' +
        '<button class="btn btn-primary big-btn" id="nextScan">📷 Escanear próxima</button></div>';
      $("nextScan").addEventListener("click", function () { camWanted = true; reset(); });
    }
  }

  function startCam() {
    var s = $("camStatus"), b = $("camBtn");
    s.textContent = "Abrindo câmera…";
    scanner.start().then(function () { camWanted = true; b.textContent = "Fechar câmera"; s.textContent = "Procurando QR…"; })
      .catch(function (e) { camWanted = false; s.textContent = (e && e.message) || "Não foi possível abrir a câmera. Verifique a permissão do navegador."; });
  }
  function openTool(id) { st.toolId = id; st.func = null; setTab("scan"); go("tool"); }
  function reset() { st.toolId = null; st.func = null; st.done = null; go("scan"); }
  function finish(title, text) { if (navigator.vibrate) try { navigator.vibrate([60, 40, 60]); } catch (e) { } st.done = { title: title, text: text }; st.toolId = null; go("done"); }

  function drawUso() {
    var list = S.ferramentas.filter(function (t) { return t.status === "em_uso"; }).sort(function (a, b) { return new Date(a.retirada_em) - new Date(b.retirada_em); });
    var late = list.filter(A.isLate).length;
    $("view-uso").innerHTML =
      (late ? '<div class="alert-card" style="margin-top:0;margin-bottom:12px"><h3>⚠ ' + late + ' ferramenta(s) há mais de ' + (A.ALERTA_HORAS / 24) + ' dias com o mesmo funcionário</h3></div>' : "") +
      (!list.length ? '<div class="card empty"><span class="ic">✅</span>Nenhuma ferramenta em uso.</div>' :
      '<div class="list">' + list.map(function (t) {
        var f = A.holder(t), lt = A.isLate(t), wa = lt && A.waLink(f, t);
        return '<div class="tool-row" data-open="' + t.id + '"' + (lt ? ' style="border-color:var(--danger)"' : "") + '><div class="info">' +
          '<div class="name">' + esc(t.nome) + '</div><div class="meta">' + esc(A.fmtWorker(f)) + ' · ' + A.fmtElapsed(t.retirada_em) + ' · <span class="mono">' + esc(t.codigo) + '</span></div>' +
          (lt ? '<div class="tag-row"><span class="badge badge-late">' + A.daysLabel(t.retirada_em) + '</span>' + (wa ? '<a class="tag op-only" data-wa="' + t.id + '" href="' + esc(wa) + '" target="_blank" rel="noopener">WhatsApp</a>' : "") + '</div>' : "") +
          '</div><span class="muted">›</span></div>';
      }).join("") + '</div>');
  }

  function setTab(tab) {
    if (st.tab === "scan" && tab !== "scan" && scanner) { scanner.stop(); }
    st.tab = tab;
    $("view-scan").hidden = tab !== "scan"; $("view-uso").hidden = tab !== "uso";
    document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === tab); });
    if (tab === "uso") drawUso(); else drawScan();
  }
  function chrome() {
    var late = A.lateTools().length;
    $("alertCount").hidden = !late; $("alertCount").textContent = late;
    $("demoBanner").hidden = !A.DEMO;
    document.body.classList.toggle("pode-operar", A.tem(["almoxarife", "gestor"]));
    $("userTag").textContent = (A.DEMO ? "modo demonstração" : (S.user && S.user.email) || "") + (S.papeis.length ? " · " + S.papeis.join(", ") : "");
  }

  $("tabbar").addEventListener("click", function (e) { var b = e.target.closest(".tab-btn"); if (b) setTab(b.dataset.tab); });
  $("view-uso").addEventListener("click", function (e) { if (e.target.closest("a")) return; var r = e.target.closest("[data-open]"); if (r) openTool(r.dataset.open); });
  $("logoutBtn").addEventListener("click", function () { A.askConfirm("Sair do app?", A.logout, "Sair"); });
  document.addEventListener("click", function (e) { var a = e.target.closest("a[data-wa]"); if (a) A.auditarSilencioso("compartilhamento_whatsapp", a.dataset.wa); });
  document.addEventListener("visibilitychange", function () { if (document.hidden && scanner) scanner.stop(); else if (!document.hidden && st.tab === "scan" && st.step === "scan" && camWanted) startCam(); });

  // Atualiza só o que não interrompe o usuário (não redesenha a assinatura em andamento)
  A.onChange(function () { chrome(); if (st.tab === "uso") drawUso(); else if (st.step === "tool") drawScan(); });

  A.boot(function () {
    chrome();
    var m = /[?&]f=([^&]+)/.exec(location.search);
    if (m) { var t = A.toolByCode(decodeURIComponent(m[1])); if (t) return openTool(t.id); }
    setTab("scan");
  });
})();
