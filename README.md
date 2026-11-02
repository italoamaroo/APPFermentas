# Almoxarifado — Controle de Ferramentas (Supabase + Render)

Painel web + app de celular para controlar a retirada e a devolução de ferramentas. Na retirada o funcionário assina na tela.

| Página | Para quê |
|---|---|
| `index.html` (painel) | Painel, Escanear, Ferramentas, **Funcionários (importar planilha)**, **Etiquetas 70×25**, Histórico (com assinaturas e exportação para Excel), Fornecedores |
| `app.html` (celular) | Escaneia o QR da ferramenta → escolhe o funcionário (busca ou QR do crachá) → **assinatura na tela** → confirma. Pode ser instalado na tela inicial |

**Alerta de 2 dias:** quando uma ferramenta passa de 48h com o mesmo funcionário, ela fica vermelha. Aparece um alerta no painel, um contador na aba e um botão de WhatsApp para cobrar o funcionário. Se você ativar as notificações, o navegador também avisa. O prazo muda pela variável `ALERTA_HORAS`.

---

## 1. Supabase (banco de dados)

1. Crie um projeto em <https://supabase.com>.
2. Abra **SQL Editor → New query**, cole todo o conteúdo de `supabase/schema.sql` e clique em **Run**.
   Esse script cria as tabelas, as regras de segurança, o bucket privado `assinaturas` e o realtime.
   - Se quiser dados de exemplo, rode também `supabase/seed.sql` (é opcional).
3. Em **Authentication → Users → Add user**, crie o usuário de cada almoxarife (e-mail e senha) e marque *Auto Confirm User*.
4. Em **Authentication → Sign In / Providers**, **desligue "Allow new users to sign up"**. Assim só entra quem você cadastrou.
5. Em **Project Settings → API**, copie a **Project URL** e a chave **anon public**.
   ⚠️ Nunca use a chave `service_role`. O build bloqueia essa chave se ela for colocada por engano.

## 2. Render (hospedagem)

1. Suba esta pasta para um repositório no GitHub.
2. No Render, vá em **New + → Blueprint** e escolha o repositório. O arquivo `render.yaml` já configura um *Static Site*.
3. Quando o Render pedir, preencha `SUPABASE_URL` e `SUPABASE_ANON_KEY`.
4. Depois do deploy:
   - Painel: `https://SEU-APP.onrender.com/`
   - Celular: `https://SEU-APP.onrender.com/app.html`

A câmera precisa de HTTPS, e o Render já fornece.

> Se preferir criar manualmente: **New + → Static Site**, com Build Command `node build.js`, Publish Directory `public` e as mesmas variáveis de ambiente.

## 3. Primeiro uso

1. **Funcionários → Importar planilha.** Aceita `.xlsx`, `.xls`, `.csv` e `.ods`. O sistema reconhece colunas com nomes como *Matrícula, Nome, Função/Cargo, Setor/Obra e Telefone/Celular*, mesmo que o cabeçalho não esteja na primeira linha. Antes de importar, mostra uma prévia com os novos, os atualizados e as linhas com erro. A **matrícula** identifica cada funcionário: se ela já existir, os dados são atualizados. Há também uma opção para desativar quem não estiver na planilha. Em caso de dúvida, use o botão *Baixar modelo*.
2. **Ferramentas → + Nova** para cadastrar as ferramentas. O código (ex.: `FRT-001`) é o conteúdo do QR.
3. **Etiquetas:** selecione os itens, defina o número de cópias e clique em Imprimir.
   - *Térmica (rolo 70×25):* sai uma etiqueta por página. No driver da impressora (Zebra, Elgin, Argox…), configure o papel para 70 × 25 mm.
   - *Folha A4 70×25:* 3 colunas × 11 linhas.
   - Na janela de impressão, deixe a escala em **100%**, as margens em **Nenhuma** e desmarque cabeçalhos e rodapés.
   - Em *Crachás de funcionários*, o sistema imprime etiquetas com o QR da matrícula. No celular, o funcionário pode ser escolhido lendo esse crachá.
4. **No celular:** abra `app.html`, faça login e use *Adicionar à tela inicial*. A partir daí ele funciona como um aplicativo.

## Rodar no computador (teste)

```bash
cp .env.example .env   # preencha (ou deixe vazio para o modo demonstração)
npm start              # http://localhost:3000
```

Sem as variáveis, o sistema abre em **modo demonstração**, com dados fictícios salvos só no navegador. Serve para conhecer as telas antes de configurar o banco.

## Estrutura

```
public/
  index.html, app.html     telas
  css/style.css            visual (mesmo do painel original)
  js/core.js               dados (Supabase/demonstração), leitor de QR, assinatura, modais
  js/painel.js, js/app.js  telas do painel e do celular
  vendor/                  bibliotecas (supabase-js, jsQR, qrcode, SheetJS) — sem depender de CDN
  manifest.webmanifest, sw.js, icons/   app instalável
supabase/schema.sql        banco + segurança + storage + realtime
build.js                   gera public/js/config.js a partir das variáveis do Render
render.yaml                blueprint do Render
```

## Segurança e auditoria
- Só usuários logados acessam (RLS). O histórico **não pode ser editado nem apagado** pelo app.
- Retirada e devolução são feitas por funções no banco (`retirar_ferramenta`, `devolver_ferramenta`). Isso impede que dois celulares retirem a mesma ferramenta ao mesmo tempo.
- Cada movimentação registra o e-mail do almoxarife que a fez e o caminho da assinatura (PNG no bucket privado `assinaturas`, acessado só por link temporário).
- A view `v_alertas_posse` lista as ferramentas com mais de 2 dias com o mesmo funcionário. Pode ser usada em relatórios ou num aviso automático por e-mail (pg_cron).
