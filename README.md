# Rastro

Rastreio próprio de leads e vendas: **anúncio → site/WhatsApp → CRM → de volta para a Meta**.
Roda na Vercel (plano gratuito) com um Postgres gratuito da Neon. Sem mensalidade de ferramenta.

## O que ele faz

| Caminho do lead | Como a origem é descoberta |
|---|---|
| Clicou no **anúncio de WhatsApp** (CTWA) | O Stevo envia os dados do anúncio (`ctwa_clid`, `source_id`) junto da primeira mensagem. O Rastro guarda e busca o nome da campanha/conjunto/anúncio na Meta. |
| Foi ao **site / página** e clicou no botão de WhatsApp | O `t.js` guarda UTMs, `ad_id` e `fbclid`, e acrescenta um código `(ref:ABC123)` ao texto da mensagem. O webhook lê o código e liga a conversa à visita. |
| Veio de **bio, YouTube, stories** | Links curtos `seudominio/l/nome` registram o clique e levam ao WhatsApp (ou página) com o código. |
| Preencheu **formulário** no site | O `t.js` (com `data-forms`) envia telefone/e-mail com a origem da visita. |

Depois que o lead existe:

- o contato é criado/atualizado no **GoHighLevel** com a origem (tags e, se configurado, campos personalizados);
- um evento **Lead** é enviado à Meta;
- os workflows do GHL avisam o Rastro de **etapa, agendamento e compra**; a compra volta à Meta como **Purchase** com o valor.

O painel mostra: visão geral (da origem à receita), leads com ficha e jornada, links rastreados, anúncios (gasto × leads × vendas × retorno) e as integrações.

## Instalar em ~20 minutos

### 1. Código no GitHub
Crie um repositório e suba estes arquivos (sem `node_modules`).

### 2. Projeto na Vercel
1. Vercel → **Add New → Project** → importe o repositório. Não precisa mudar nenhuma configuração (framework "Other").
2. Antes do primeiro deploy (ou depois, com redeploy), vá em **Storage → Create → Neon (Postgres)** e conecte ao projeto. Isso preenche `DATABASE_URL` sozinho.
   Qualquer outro Postgres (Supabase etc.) também serve: coloque a URL em `DATABASE_URL`.

### 3. Variáveis de ambiente
Em **Settings → Environment Variables**, preencha conforme o `.env.example`. As obrigatórias:

| Variável | Para quê |
|---|---|
| `ADMIN_PASSWORD` | senha do painel |
| `SESSION_SECRET` | texto longo e aleatório (assina a sessão) |
| `WEBHOOK_SECRET` | texto longo, sem espaços (protege os webhooks) |

O resto é opcional e liga cada integração: `META_PIXEL_ID` + `META_CAPI_TOKEN`, `META_ADS_TOKEN` + `META_AD_ACCOUNT_ID`, `GHL_TOKEN` + `GHL_LOCATION_ID`.
Depois de mexer nas variáveis, faça **Redeploy**.

### 4. Abrir o painel
Acesse `https://SEU-PROJETO.vercel.app`, entre com a senha. As tabelas são criadas automaticamente na primeira vez.
Em **Settings → Domains** você pode usar `rastreio.suaempresa.com.br`.

A aba **Integrações** do painel já mostra as URLs prontas com o seu domínio. Resumo:

### 5. Site
Cole no `<head>` de cada site/página de vendas:
```html
<script async src="https://SEU-DOMINIO/t.js" data-forms></script>
```
Todo link `wa.me/...`, `api.whatsapp.com/send...` ou `whatsapp://send...` passa a levar o código de rastreio.
Se o site usa um botão que abre o WhatsApp por JavaScript, use um `<a href="https://wa.me/...">` de verdade, ou chame `window.RP.scan()` depois de mudar o link.
Para formulário próprio: `window.RP.lead({ name, phone, email })`.
(Formulários dentro de iframe, como os embutidos do GHL, não podem ser lidos pelo script.)

### 6. Anúncios que levam ao site
No Gerenciador de Anúncios → **Parâmetros de URL**:
```
utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}&ad_id={{ad.id}}&adset_id={{adset.id}}&campaign_id={{campaign.id}}
```
Anúncios de clique para WhatsApp não precisam disso.

### 7. WhatsApp (Stevo)
No Stevo, cadastre como webhook de **mensagens recebidas**:
```
https://SEU-DOMINIO/api/webhook-stevo?key=SEU_WEBHOOK_SECRET
```
Mande uma mensagem de teste e confira em **Integrações → Últimos webhooks recebidos**.

### 8. GoHighLevel
- **Origem do lead para o GHL:** gere um *Private Integration Token* (escopo de contatos) e preencha `GHL_TOKEN` e `GHL_LOCATION_ID`. Para gravar origem/campanha/anúncio em campos personalizados, crie os campos no GHL e informe os IDs em `GHL_CUSTOM_FIELDS`, por exemplo `{"origem":"ID1","campanha":"ID2","anuncio":"ID3"}` (chaves aceitas: `origem, canal, campanha, conjunto, anuncio, ad_id, ctwa_clid, pagina`). Sem isso, a origem vai em tags (`origem:ctwa`, `canal:meta`…).
- **Etapa, agendamento e compra para o Rastro:** em cada workflow, ação **Webhook (POST)**:

| Quando | URL |
|---|---|
| contato criado/qualificado | `/api/webhook-ghl?key=...&event=lead` |
| mudou de etapa | `/api/webhook-ghl?key=...&event=stage` (envie o nome da etapa no campo `stage`) |
| agendou | `/api/webhook-ghl?key=...&event=schedule` |
| comprou / oportunidade ganha | `/api/webhook-ghl?key=...&event=purchase` (valor em `value` no corpo, ou `&value=1500` na URL) |

O corpo padrão do GHL já leva telefone, e-mail e nome. O valor aceita `1500`, `1500.50` ou `R$ 1.500,50`. Se o workflow enviar o ID da oportunidade (`opportunity_id`), compras repetidas da mesma oportunidade são ignoradas.
Qualquer outro `event=` (ex.: `event=checkout`) vira evento da Meta com esse nome.

### 9. Meta
- `META_PIXEL_ID` é o ID do **conjunto de dados/pixel**; `META_CAPI_TOKEN` é o token da API de Conversões (Gerenciador de Eventos → Configurações).
- Enquanto testa, defina `META_TEST_EVENT_CODE` (aba *Testar eventos*) e use o botão **Enviar evento de teste** em Integrações. Remova a variável quando for valer.
- `META_WABA_ID` (ID da conta do WhatsApp Business) só se aplica a quem usa a API oficial.

## Pontos que precisam ser validados no seu ambiente

O código foi testado de ponta a ponta com Postgres real e respostas simuladas de Meta e GHL, mas **não** contra o Stevo, o GHL e a Meta de verdade. Três pontos dependem do que essas plataformas realmente enviam/aceitam:

1. **Formato do webhook do Stevo.** A leitura é tolerante (procura telefone, nome, texto e dados do anúncio em qualquer nível do JSON e aceita os formatos mais comuns). Se o Stevo usar nomes diferentes, o lead entra como "Sem origem" ou é ignorado. O payload cru de cada webhook fica salvo em **Integrações → Últimos webhooks**; é só comparar com o que o `lib/stevo.js` procura e ajustar as listas de chaves no topo do arquivo. Contatos que chegam só com `@lid` (sem telefone) são ignorados.
2. **Anúncio de WhatsApp com número não oficial.** Se o Stevo não repassar o bloco do anúncio (`referral`/`ctwa_clid`), não há como saber o anúncio. Conversas que passam pelo site ou por link rastreado continuam funcionando.
3. **Conversões de WhatsApp na Meta.** Com `META_WABA_ID` e `ctwa_clid`, o evento sai como `business_messaging` (ligado ao clique no anúncio). Sem eles, sai como `chat` com telefone/e-mail em hash, o que a Meta usa para casar, com qualidade menor. Confirme no *Testar eventos* e em **Qualidade da correspondência** que os eventos estão chegando como esperado.

Também confirme no GHL, na primeira compra de teste, que o contato foi atualizado e não duplicado.

## Como a atribuição é decidida

- O primeiro contato manda: um lead já existente **não muda de origem**, exceto se estava "Sem origem" e chega uma origem depois.
- Código `(ref:…)` na mensagem tem prioridade; depois, dados de anúncio de WhatsApp; depois, formulário.
- O código vale por visita à página. Se a pessoa apagar o código da mensagem antes de enviar, a origem não é identificada.
- Receita por origem/campanha é calculada pelos **leads do período** (cohort) e o total do topo pela **data da compra**.

## Privacidade (LGPD)

O Rastro guarda telefone, e-mail, nome, IP e user-agent dos leads, e envia à Meta apenas valores com hash SHA-256 (mais IP/user-agent/cookies `_fbc`/`_fbp`, como a API exige). Informe isso na política de privacidade e use aviso de cookies conforme a sua base legal. O botão **Apagar lead** na ficha remove o lead e o histórico.

## Estrutura

```
api/
  track.js          recebe visitas, cliques e formulários do t.js
  r.js              /l/:slug  → links rastreados
  webhook-stevo.js  mensagens do WhatsApp
  webhook-ghl.js    etapa, agendamento e compra (GHL)
  auth.js           login/logout do painel
  admin.js          API do painel
lib/                banco, atribuição, Meta, GHL, leitura do Stevo
public/
  index.html        painel
  t.js              script de rastreio dos sites
```

## Rodar localmente

```bash
npm install
cp .env.example .env.local   # preencha; DATABASE_URL pode ser um Postgres local
npx vercel dev
```

## Problemas comuns

- **Lead entra como "Sem origem":** abra o webhook em Integrações e veja se o texto tem `(ref:XXXXXX)` ou o bloco do anúncio. Se não tem, o site não tem o `t.js`, o link do botão não é de WhatsApp, ou o Stevo não repassou o anúncio.
- **Webhook responde 401:** a `key` da URL é diferente de `WEBHOOK_SECRET`, ou a variável não foi definida/redeploy não foi feito.
- **Falha ao enviar à Meta/GHL:** a mensagem do erro aparece na jornada do lead (ficha).
- **Painel diz "Defina ADMIN_PASSWORD":** falta a variável; faça redeploy depois de criá-la.
