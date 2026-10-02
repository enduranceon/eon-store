# Publicação e validação da reestruturação

## Estado de entrega

PR #85, em revisão. As migrações são aditivas; o recurso `cases_rollout` começa
desativado. Nenhuma migração envia mensagem, cria cobrança no provedor ou confirma
pagamento. O merge em `main` aciona o workflow de produção, portanto depende do
OK explícito do responsável depois da revisão.

## Preparação do ambiente

1. Conferir commit, CI verde, projeto Supabase e site Netlify conforme `AGENTS.md`.
2. Aplicar as migrações em Supabase isolado e executar `supabase test db --local`.
   Usar apenas pessoas, contratos, pedidos e pagamentos fictícios na homologação.
3. Publicar a API no mesmo ambiente isolado antes do frontend. Conferir
   `VITE_SUPABASE_URL`: uma prévia Netlify pode apontar para produção e não é,
   sozinha, um ambiente isolado. Não testar escrita de homologação nessa prévia.
4. Autenticar com usuário administrativo desse ambiente. Todos os endpoints
   abaixo passam pela mesma autorização de `api-v1`; não expor service role no
   navegador nem em scripts compartilhados.

## Popular a fila e ativar

Todos os caminhos abaixo são relativos a `/functions/v1/api-v1`.

1. `GET /communications/cases/sync/preview`: consulta somente leitura com
   `eligible`, `missing`, amostra e data de corte. Guardar o resultado antes.
2. `POST /communications/cases/sync` com
   `{ "source_type": "contract", "limit": 100 }`.
   Repetir usando `after: next_cursor` até `next_cursor` ser nulo. Repetir para
   `presale`, `stock` e `event`. O lote cria/atualiza casos e vínculos; não envia
   mensagens nem altera valores financeiros.
3. Repetir a prévia e conferir `missing = 0`. Comparar fontes, pessoas e saldos
   da amostra com os registros originais. Caso sem saldo confiável fica em revisão;
   não marcar como quitado para limpar a fila.
4. `POST /communications/cases/rollout` com `{ "enabled": true }`. A API rejeita
   ativação se faltar sincronização. `GET` no mesmo caminho confirma o estado.
5. Recarregar as sessões dos operadores. Enquanto ativo, escritores antigos de
   comunicação retornam conflito e orientam recarregar; isso evita dois fluxos
   concorrentes de registro de contato.

## Roteiro da equipe

- Em **Pessoas**, buscar uma pessoa de cada origem e abrir seus contatos e vínculos.
- Em **Hoje**, abrir um contato e conferir que o mesmo caso aparece em
  **Comunicação**, no contrato/pedido e no Financeiro.
- Conferir as três filas abertas: A fazer, Em acompanhamento e Agendados. Usar
  Histórico para buscar mensagens de casos abertos ou encerrados por pessoa e data.
- Revisar mensagem e destinatário; abrir/copiar WhatsApp não registra envio.
  Confirmar envio apenas após realizar o contato manualmente.
- Registrar uma data combinada e verificar que ela vale em todos os acessos.
- Informar “já paguei”: exige conferência. Registrar o pagamento na operação
  financeira encerra a cobrança. “Concluir revisão” exige nota e não quita dívida.
- Conferir D+3, D+5, D+7 e retorno diário a partir de D+8. O aviso D−1/D0 inicia
  desligado e pode ser publicado em Modelos e regras; só se aplica aos planos
  trimestrais/semestrais elegíveis, sem renovação automática.
- Salvar um modelo: somente rascunho. Simular: cenários fictícios com o mesmo
  resolvedor. Publicar: nova versão; os envios antigos preservam texto e versão.

## Recuperação

`POST /communications/cases/rollout` com `{ "enabled": false }` desativa as
ações novas. A interface nova passa a exibir preparação. Para operar pelo fluxo
anterior, restaurar também o frontend compatível e recarregar as sessões.

Preservar casos, eventos, comandos e versões; não apagar o histórico para reverter.
Restaurar o frontend não desfaz migrações nem a API. Corrigir banco/API em uma nova
migração/PR. Registrar motivo, horário e commit da reversão. Ao reativar, repetir
a sincronização e reconciliação antes de liberar o trabalho.

## Evidências e limites

- Testes de API executam sem rede e sem chamadas ao provedor.
- pgTAP executa em banco efêmero do CI, incluindo funções sob `service_role`.
- A interface foi exercitada com componentes reais e transporte simulado, em
  desktop e celular: envio manual, retorno, revisão, pagamento concorrente com
  conflito, histórico paginado e publicação de modelo.
- A homologação integrada da equipe e a reconciliação dos dados reais ocorrem em
  etapa separada, após autorização de publicação. Testes fictícios não provam a
  integridade de todos os registros históricos de produção.

## Matriz de aceite

| ID do plano | Evidência técnica / checagem de liberação |
| --- | --- |
| A01 | Caso não expira por idade; pgTAP de cadência e revisão de saldo. Conferir amostra de 60/90 dias na prévia. |
| A02 | Painel de caso compartilhado por Central, Hoje, Pessoas, contrato, pedidos, evento e Financeiro. |
| A03 | Agendamento e revisão persistidos, resolvidos no servidor e revalidados em toda ação. |
| A04 | Fingerprint, versão da fonte e locks antes do registro; fixture visual de conflito após pagamento. |
| A05 | Idempotência e versão otimista testadas no SQL/API. Homologar duas sessões simultâneas no ambiente isolado. |
| A06 | Saldo parcial desconhecido bloqueia para revisão; substituição da obrigação e retorno A→B→A cobertos no SQL. |
| A07 | Regra automática mensal preservada; aviso pré-vencimento exclui automática. |
| A08 | Contrato-filho e transições do Kanban preservados; sincronização com resposta e follow-up. Suíte anterior mantida. |
| A09 | Eventos e versões imutáveis, encerramento preserva histórico. |
| A10 | Histórico global novo + legado, pessoa/texto/período SP, cursores; pgTAP com mais de 200 eventos. |
| A11 | Telefone, link, Pix e falhas de API tratados; mensagem só registrada com confirmação de envio. |
| A12 | Gate administrativo, RPCs de servidor, RLS e escrita direta revogada. |
| A13 | Rotas antigas preservadas, IDs e parâmetros de Pessoas; testes de seleção única da navegação. |
| A14 | Fixture desktop/mobile, foco e Escape no painel; completar homologação com teclado e zoom da equipe. |
| A15 | Filas abertas mutuamente exclusivas, contagens do servidor; fórmulas financeiras preservadas e definições visíveis. Reconciliar amostra real antes da ativação. |
