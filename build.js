/* Gera public/js/config.js a partir das variáveis de ambiente (Render ou .env local).
   Sem as variáveis, o app abre em "modo demonstração" (dados só no navegador). */
const fs = require("fs");
const path = require("path");

try { // .env opcional para rodar localmente
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach((l) => {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  });
} catch (e) {}

// Aceita a URL colada com sobras (ex.: .../rest/v1/, barra no fim, espaços) e mantém só https://xxxx.supabase.co
let url = (process.env.SUPABASE_URL || "").trim();
if (url) {
  try { url = new URL(url).origin; } catch (e) { console.error("ERRO: SUPABASE_URL inválida:", url); process.exit(1); }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(url)) console.warn("AVISO: SUPABASE_URL não parece do Supabase:", url);
}
// Falha fechada: no Render (variável RENDER=true) sem configuração o site mostra erro em vez de
// abrir em "modo demonstração" e gravar registros só no navegador.
const configurado = !!(url && (process.env.SUPABASE_ANON_KEY || "").trim());
const emProducao = process.env.RENDER === "true" || process.env.NODE_ENV === "production";
const MODO = configurado ? "producao" : (emProducao && process.env.PERMITIR_DEMO !== "1" ? "erro" : "demonstracao");
const cfg = {
  MODO,
  SUPABASE_URL: url,
  SUPABASE_ANON_KEY: (process.env.SUPABASE_ANON_KEY || "").trim(),
  ALERTA_HORAS: Number(process.env.ALERTA_HORAS || 48),
  ENVIAR_CORRELACAO: process.env.ENVIAR_CORRELACAO !== "0"
};
if (/service_role/.test(Buffer.from((cfg.SUPABASE_ANON_KEY.split(".")[1] || ""), "base64").toString())) {
  console.error("ERRO: você colocou a chave service_role. Use a chave anon/public.");
  process.exit(1);
}
const out = path.join(__dirname, "public", "js", "config.js");
fs.writeFileSync(out, "window.APP_CONFIG = " + JSON.stringify(cfg, null, 2) + ";\n");
console.log("config.js gerado — modo:", MODO.toUpperCase(), cfg.SUPABASE_URL ? "| Supabase: " + cfg.SUPABASE_URL : "", "| alerta:", cfg.ALERTA_HORAS + "h");
if (MODO === "erro") console.warn("ATENÇÃO: SUPABASE_URL/SUPABASE_ANON_KEY ausentes em produção — o site exibirá 'Sistema não configurado'.");
