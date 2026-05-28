# EON Store — Documentação Completa

> Sistema de gestão de pré-vendas + loja online com integração de pagamento Asaas, gestão de estoque, cupons de desconto e central de devoluções.

---

## 📑 Índice

1. [Visão Geral](#1-visão-geral)
2. [Stack Técnica](#2-stack-técnica)
3. [Estrutura de Telas](#3-estrutura-de-telas)
4. [Fluxos Principais](#4-fluxos-principais)
5. [Sistema de Cupons](#5-sistema-de-cupons)
6. [Sistema de Devoluções](#6-sistema-de-devoluções)
7. [Integração Asaas](#7-integração-asaas)
8. [Banco de Dados](#8-banco-de-dados)
9. [Edge Functions](#9-edge-functions)
10. [Segurança e Produção](#10-segurança-e-produção)

---

## 1. Visão Geral

EON Store é uma plataforma de vendas online que combina **dois modelos de venda**:

### 📦 Pré-venda (Campanhas)
- Você cria uma campanha com produtos específicos
- Cliente faz pedido sem precisar ter pagamento no momento
- Você cobra depois via WhatsApp
- Adequado pra: lançamentos, produção sob demanda, encomendas em grupo

### 🛍️ Loja Online (Estoque)
- Produtos disponíveis com estoque controlado
- Cliente compra direto no site (`/loja`)
- Estoque é decrementado automaticamente
- Adequado pra: vendas regulares de produtos prontos

### 🎯 Conceito Central
O sistema **NÃO automatiza o envio de mensagens** ao cliente. Ele **prepara a mensagem pronta** (com PIX, link, etc.) e abre o WhatsApp pra você copiar/enviar. Você mantém controle total da comunicação.

---

## 2. Stack Técnica

| Camada | Tecnologia |
|---|---|
| **Frontend** | React 18 + Vite + TailwindCSS v3 + shadcn/ui (Radix) |
| **Roteamento** | React Router v6 |
| **Backend** | Supabase (Postgres + Auth + Storage + Edge Functions) |
| **Pagamento** | Asaas (API REST + Webhooks) |
| **Hospedagem** | Netlify |
| **Notificações** | Sonner (toasts) |

**URL produção:** https://eon-store.netlify.app

---

## 3. Estrutura de Telas

### 🔓 Páginas Públicas (sem login)

| URL | O que faz |
|---|---|
| `/` | Home pública |
| `/checkout/:campaignId` | Checkout de campanha de pré-venda |
| `/confirmacao/:orderId` | Confirmação pós-checkout (presale) |
| `/loja` | Loja online (produtos em estoque) |
| `/loja/confirmacao/:orderId` | Confirmação pós-checkout (loja) |
| `/p/:orderId` | **Página de acompanhamento do pedido** (cliente vê status, PIX, timeline) |

### 🔐 Painel Administrativo

Sidebar organizada em 4 seções:

#### 📥 Hoje
**`/hoje`** — Caixa de entrada do dia. Mostra apenas itens que precisam de ação:
- Cobranças em atraso
- Pedidos novos para cobrar
- Mensagens aguardando resposta
- Cobranças sem retorno (2+ dias)
- Pagos pendentes de entrega
- Devoluções aguardando recebimento
- Devoluções recebidas para repor estoque

#### Pré-venda
- **Dashboard** (`/admin`) — Métricas gerais
- **Campanhas** (`/campanhas`) — Criar/gerenciar campanhas
- **Pedidos** (`/pedidos`) — Lista de pedidos pré-venda
- **Clientes** (`/clientes`) — Base de clientes

#### Loja
- **Estoque** (`/estoque`) — Gerenciar produtos físicos
- **Pedidos Loja** (`/estoque/pedidos`) — Pedidos vindos da loja online
- **Devoluções** (`/devolucoes`) — Central de devoluções de peças canceladas

#### Análises
- **Fluxo de Caixa** (`/financeiro`) — Previsibilidade de pagamentos (entrada/saída)
- **Relatórios** (`/relatorios`) — Análises de vendas

#### Cadastros (colapsável)
- **Produtos** (`/produtos`) — Biblioteca de produtos da pré-venda
- **Categorias** (`/categorias`)
- **Treinadores** (`/treinadores`) — Lista de treinadores que indicam vendas
- **Fornecedores** (`/fornecedores`)
- **Cupons** (`/cupons`) — Cupons de desconto

---

## 4. Fluxos Principais

### 🚀 Fluxo Pré-venda (do início ao fim)

```
┌─────────────────────────────────────────────────────────┐
│ 1. ADMIN cria Campanha com produtos                     │
│    /campanhas/novo → escolhe produtos, define datas     │
└──────────────────┬──────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────┐
│ 2. ADMIN compartilha link da campanha                   │
│    Ex: eon-store.com.br/checkout/black-friday-2026      │
└──────────────────┬──────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────┐
│ 3. CLIENTE entra no link, monta carrinho                │
│    Pode aplicar cupom de desconto                       │
│    Preenche dados (nome, WhatsApp, email, treinador)    │
└──────────────────┬──────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────┐
│ 4. CLIENTE finaliza pedido                              │
│    Status: "Aguardando contato"                         │
│    Cliente é redirecionado para /confirmacao            │
└──────────────────┬──────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────┐
│ 5. PEDIDO aparece na Tela "Hoje" do admin               │
│    Seção "Pedidos novos para cobrar"                    │
└──────────────────┬──────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────┐
│ 6. ADMIN abre o pedido → "Cobrar via WhatsApp"          │
│    Sistema monta a mensagem com itens + total +         │
│    link de acompanhamento /p/{id}                       │
│    Admin envia, marca como "Mensagem enviada"           │
└──────────────────┬──────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────┐
│ 7. CLIENTE responde forma de pagamento (PIX/cartão)     │
│    ADMIN atualiza método e clica "Gerar cobrança"       │
│    → Edge function chama Asaas API                      │
│    → Asaas cria cobrança e retorna PIX/boleto/link      │
│    → Sistema salva tudo no pedido                       │
│    Status: "Cobrança enviada"                           │
└──────────────────┬──────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────┐
│ 8. ADMIN envia PIX/link via WhatsApp                    │
│    (botão "Enviar cobrança via WhatsApp" já preparado)  │
└──────────────────┬──────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────┐
│ 9. CLIENTE paga → Asaas dispara webhook automático      │
│    → Edge function asaas-webhook recebe                 │
│    → Status muda automaticamente para "Pago"            │
│    → payment_date é registrada                          │
│    (Tudo sem intervenção do admin!)                     │
└──────────────────┬──────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────┐
│ 10. ADMIN trabalha a logística                          │
│     Atualiza delivery_status:                           │
│     "Aguardando fornecedor" → "Pedido ao fornecedor"    │
│     → "Produto recebido" → "Separado p/ entrega"        │
│     → "Entregue"                                        │
└─────────────────────────────────────────────────────────┘
```

### 🛍️ Fluxo Loja Online

```
┌─────────────────────────────────────────────────────────┐
│ 1. ADMIN cadastra produto em /estoque/novo              │
│    Define preço, quantidade, imagens                    │
└──────────────────┬──────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────┐
│ 2. CLIENTE acessa /loja, adiciona ao carrinho           │
│    Aplica cupom se quiser                               │
│    Finaliza checkout                                    │
└──────────────────┬──────────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────────┐
│ 3. SISTEMA valida estoque, decrementa automático       │
│    (trigger handle_stock_order_insert)                  │
│    Cria pedido com status "Aguardando contato"          │
└──────────────────┬──────────────────────────────────────┘
                   ↓
   (Daqui o fluxo é IGUAL ao da pré-venda — passos 5-10)
```

### ❌ Fluxos de Cancelamento

Existem **5 caminhos** para cancelar/estornar:

| Caminho | Quando usar | Efeitos |
|---|---|---|
| **Cancelar Cobrança** (botão Asaas) | Cliente desistiu antes de pagar | Cancela no Asaas + status → cancelado + devolve cupom |
| **Estornar Pagamento** (botão Asaas) | Pedido pago, devolver tudo | Refund Asaas total + status → estornado + devolve cupom |
| **Cancelar peça** (botão na linha do item) | Cliente quer só uma peça menos | Refund parcial Asaas + remove peça + estoque restaurado (se loja+não entregue) |
| **Status manual** (dropdown → Cancelado/Estornado) | Casos especiais | Atualiza DB + devolve cupom |
| **Webhook Asaas** | Cliente pediu estorno via chargeback | Status atualiza + devolve cupom automaticamente |

**Detalhe do "Cancelar peça":**

1. Você abre o pedido e clica "Cancelar peça" na linha do item
2. Modal pergunta: "Já foi entregue?"
   - **Não entregue + Loja:** estoque incrementa automaticamente
   - **Já entregue:** vai pra Central de Devoluções aguardando retorno físico
3. Se pedido estava **pago**, sistema:
   - Calcula valor proporcional (respeita cupom se houver)
   - Chama refund parcial no Asaas
   - Atualiza `total_value` e `discount_value`
4. Se foi a última peça → status → "Estornado" (se era pago) ou "Cancelado" + devolve cupom
5. Cria registro em `order_returns` pra auditoria

---

## 5. Sistema de Cupons

### Tipos
- **Porcentagem:** ex. 10% off
- **Valor fixo:** ex. R$ 50 off

### Regras opcionais
- Valor mínimo do pedido (ex: válido a partir de R$ 200)
- Desconto máximo (cap quando é %)
- Validade (data inicial e/ou final)
- Limite total de usos (esgota após N pedidos)
- Limite por cliente (geralmente 1× por WhatsApp)
- Ativo/desativado (liga/desliga sem deletar)

### Aplicação no checkout
1. Cliente digita código → sistema valida via edge function `validate-coupon`
2. Validações no servidor:
   - Cupom existe e está ativo
   - Dentro da validade
   - Atende valor mínimo
   - Não esgotou (`uses_count < usage_limit_total`)
   - Cliente não usou antes (verifica em `coupon_uses`)
3. Se OK → desconto é calculado e aplicado no resumo
4. Recálculo automático quando carrinho muda
5. Auto-remoção se subtotal cair abaixo do mínimo
6. **Re-validação no submit** (caso tenha expirado entre apply e finalizar)

### Contador automático
- Trigger `sync_coupon_uses_count` incrementa `uses_count` quando insere em `coupon_uses`
- Decrementa quando `cancelled` muda de `false` → `true`
- Garantia atômica via trigger PG

### Devolução do cupom
Acontece em **5 caminhos** (mesma lista dos cancelamentos acima). Sistema sempre marca `coupon_uses.cancelled = true` → trigger decrementa contador → cupom volta a estar disponível.

---

## 6. Sistema de Devoluções

### Fluxo
Quando você cancela uma peça que **já foi entregue**, ela vira "devolução pendente":

```
[Cancelar peça entregue] 
        ↓
[Devolução criada em order_returns]
        ↓ status: 'pending_return'
        ↓
[Central de Devoluções (/devolucoes)]
        ↓ "Marcar como recebido"
        ↓ status: 'received'
        ↓
["Repor estoque" (se for produto da loja)]
        ↓ status: 'completed'
        ↓ stock_products.quantity incrementado
```

### Estados
- **`pending_return`** — Aguardando cliente devolver fisicamente
- **`received`** — Recebido, aguardando reposição no estoque
- **`completed`** — Processo concluído (estoque reposto OU sem ação adicional)

### Auto-completar
Se a peça **não foi entregue** quando cancelada:
- **Loja:** estoque já é reposto automático → registro vai direto para `completed`
- **Pré-venda:** não tem estoque para repor → vai direto para `completed`

---

## 7. Integração Asaas

### Edge Functions envolvidas

1. **`create-asaas-charge`** (v6) — Faz todas as operações com Asaas:
   - `create` — Cria cobrança PIX/boleto/cartão
   - `status` — Verifica status manualmente
   - `cancel` — Cancela cobrança não paga
   - `refund` — Estorna (total ou parcial via `value`)

2. **`asaas-webhook`** (v3) — Recebe eventos do Asaas em tempo real:
   - `PAYMENT_RECEIVED` / `PAYMENT_CONFIRMED` → marca como **Pago**
   - `PAYMENT_DELETED` → marca como **Cancelado**
   - `PAYMENT_REFUNDED` → marca como **Estornado** + devolve cupom
   - Validação de token via Supabase Secret `ASAAS_WEBHOOK_TOKEN` (opcional)

### Configuração no Asaas (já feita)
- URL webhook: `https://bsiljrrodgtmtdilnuxr.supabase.co/functions/v1/asaas-webhook`
- Eventos marcados: `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_DELETED`, `PAYMENT_REFUNDED`
- Token configurável (recomendado validar no Secret)

### Ambiente atual
- **Sandbox** (`sandbox.asaas.com`)
- Chave hardcoded como fallback na edge function
- Para produção: mudar `ASAAS_BASE` para `www.asaas.com` + setar Secret `ASAAS_API_KEY`

---

## 8. Banco de Dados

### Tabelas principais

#### `presale_orders` / `stock_orders`
Estrutura quase idêntica entre os dois:
- `id`, `order_number` (gerado automático: PED-XXXXXX)
- `payment_status`, `delivery_status`
- `payment_date`, `delivery_date`, `due_date`
- `total_value`, `total_cost` (só presale), `discount_value`
- `coupon_code`
- `items` (JSONB) — array de itens com `cancelled` flag opcional
- `asaas_charge_id`, `asaas_payment_link`, `asaas_pix_copy`, `asaas_pix_qrcode`
- `cancellation_reason`
- `status_changed_at` — atualizado por trigger só quando status muda de verdade
- `created_date`, `updated_date`

#### `coupons`
- `id`, `code` (uppercase, único case-insensitive)
- `discount_type` (`percentage` | `fixed`), `discount_value`
- `max_discount`, `min_purchase`
- `valid_from`, `valid_until`
- `usage_limit_total`, `usage_limit_per_customer`
- `active`, `uses_count`

#### `coupon_uses`
Audit trail de cada uso. Inclui `customer_identifier` (WhatsApp) para checagem de limite por cliente.

#### `order_returns`
Registro de cada peça cancelada/devolvida. Vincula a `presale_orders` ou `stock_orders` via `order_id` + `order_type`.

#### `stock_products`
Produtos da loja com `quantity` (estoque).

#### `presale_customers`
Base de clientes da pré-venda (nome, WhatsApp, email, CPF).

### Triggers automáticos importantes

| Trigger | Quando dispara | O que faz |
|---|---|---|
| `trg_order_number` (presale) | INSERT em presale_orders | Gera `PED-XXXXXX` |
| `set_stock_order_number` | INSERT em stock_orders | Gera `LOJ-XXXXXX` |
| `handle_stock_order_insert` | INSERT em stock_orders | **Decrementa estoque** |
| `handle_stock_order_cancel` | UPDATE em stock_orders | **Restaura estoque** se status → cancelado (respeita flag `cancelled` dos items) |
| `coupon_uses_sync_counter` | INSERT/UPDATE em coupon_uses | Mantém `coupons.uses_count` sincronizado |
| `presale_orders_status_changed` | UPDATE em presale_orders | Atualiza `status_changed_at` SÓ se status mudou |
| `stock_orders_status_changed` | UPDATE em stock_orders | Idem |

---

## 9. Edge Functions

Localizadas em Supabase → Edge Functions.

| Nome | JWT | O que faz |
|---|---|---|
| `create-asaas-charge` | ✅ Sim | Operações Asaas (create/status/cancel/refund) |
| `asaas-webhook` | ❌ Não | Recebe eventos do Asaas, atualiza status |
| `get-public-order` | ❌ Não | Retorna dados sanitizados do pedido para `/p/:id` |
| `validate-coupon` | ❌ Não | Valida cupom no checkout sem expor a tabela toda |

**Service role** é usado nas funções para acessar o banco bypassing RLS, garantindo segurança e controle.

---

## 10. Segurança e Produção

### ✅ O que já está protegido
- Cupons não podem ser enumerados (validação só via edge function)
- Página pública `/p/:id` retorna dados sanitizados (sem CPF, custo, notas internas)
- UUIDs em vez de IDs sequenciais previnem enumeração
- Trigger atômico no contador de cupons (sem race condition no incremento)
- RLS habilitada em todas as tabelas
- Webhook Asaas sempre retorna 200 (não fica reenviando em loop)
- Estorno proporcional ao cancelar peça (respeita cupom aplicado)
- Devolução de cupom em **5 caminhos** (cobertura completa)

### ⚠️ Pendências de segurança (importantes para produção)

#### 🔴 ALTO — Privacidade de clientes
`presale_customers` permite anon SELECT/INSERT/UPDATE com `qual=true`. Isso significa que qualquer pessoa pode listar/editar todos os clientes (nome, WhatsApp, CPF).

**Solução:** Mover `findOrCreateCustomer` para uma edge function `create-public-order` que usa service role.

#### 🟠 MÉDIO — Token do webhook
Validação implementada mas Secret `ASAAS_WEBHOOK_TOKEN` ainda não está setado. Sem isso, qualquer pessoa que descubra a URL do webhook pode disparar eventos falsos.

**Solução:** Setar Secret `ASAAS_WEBHOOK_TOKEN` no Supabase com o mesmo valor configurado no Asaas.

#### 🟠 MÉDIO — Chave Asaas hardcoded
A chave de sandbox está como fallback na edge function. Para produção, gerar chave de produção e setar como Secret `ASAAS_API_KEY`.

#### 🟡 BAIXO — Sem rate limiting
Edge functions são públicas sem rate limiting. Para produção, considerar Cloudflare na frente.

### Checklist antes de ir para produção

- [ ] Gerar chave API de produção no Asaas
- [ ] Setar `ASAAS_API_KEY` como Supabase Secret
- [ ] Setar `ASAAS_WEBHOOK_TOKEN` como Supabase Secret (mesmo valor do Asaas)
- [ ] Trocar `ASAAS_BASE` de `sandbox.asaas.com` para `www.asaas.com` nas edge functions
- [ ] Reconfigurar webhook no Asaas produção apontando para mesma URL
- [ ] Mover `findOrCreateCustomer` para edge function (bug de privacidade)
- [ ] Configurar backup automático no Supabase
- [ ] Testar restauração em projeto separado
- [ ] Implementar rate limiting (Cloudflare ou similar)

---

## 📊 Resumo dos diferenciais

- ✅ **Caixa de entrada operacional** — você abre o sistema e sabe exatamente o que fazer hoje
- ✅ **Cliente se serve sozinho** — link público `/p/:id` reduz "ô recebeu meu pagamento?" no zap
- ✅ **Webhook automático** — pagamento entra → status muda sem cliques
- ✅ **Estorno parcial inteligente** — cancela uma peça e só essa peça é estornada (respeita cupom)
- ✅ **Cupons completos** — validade, mínimos, limites, devolução automática em cancelamentos
- ✅ **Central de devoluções** — separa "devolução pendente" de "estoque a repor"
- ✅ **Lucro bruto rastreado** — custo total em cada pedido permite análise de margem real
- ✅ **Fluxo de caixa preditivo** — vê o que vai entrar nos próximos dias

---

**Última atualização:** maio/2026
