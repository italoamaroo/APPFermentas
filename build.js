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

const cfg = {
  SUPABASE_URL: process.env.SUPABASE_URL || "",
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "",
  ALERTA_HORAS: Number(process.env.ALERTA_HORAS || 48)
};
if (/service_role/.test(Buffer.from((cfg.SUPABASE_ANON_KEY.split(".")[1] || ""), "base64").toString())) {
  console.error("ERRO: você colocou a chave service_role. Use a chave anon/public.");
  process.exit(1);
}
const out = path.join(__dirname, "public", "js", "config.js");
fs.writeFileSync(out, "window.APP_CONFIG = " + JSON.stringify(cfg, null, 2) + ";\n");
console.log("config.js gerado —", cfg.SUPABASE_URL ? "Supabase: " + cfg.SUPABASE_URL : "MODO DEMONSTRAÇÃO (sem Supabase)", "| alerta:", cfg.ALERTA_HORAS + "h");
