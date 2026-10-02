# Reestruturação operacional — 02/10/2026

## Base conferida

Base: `009088d` (main, após PRs 79, 82, 83 e 84). A implementação mantém o
Kanban publicado pelo Claude. As antigas PRs 80 e 81 não fazem parte desta entrega.
Referência funcional: Plano de Reestruturação, 35 páginas, revisão de 02/10/2026.

## Decisões confirmadas nesta tarefa

- Claude encerrou seu trabalho; esta branch é a única frente de implementação.
- Cobranças: D+3, D+5, D+7 e, a partir de D+8, retorno diário enquanto houver saldo.
- Aviso pré-vencimento opcional em D−1 ou D0 para trimestral/semestral; começa
  desativado e não se aplica à renovação automática mensal.
- Combinado com data, contestação e revisão de pagamento prevalecem sobre cadência.
- A fila sugere ações para a equipe. Abrir/copiar WhatsApp não comprova envio.
- Renovação continua no contrato-filho, com as transições e resoluções existentes.
- Cobrança e pagamento permanecem externos/manuais. Não ativar o provedor Asaas.
- Perfis futuros de atendimento/financeiro não foram aprovados; o servidor mantém
  a autorização administrativa atual, inclusive nos novos endpoints.
- Fórmulas, fechamentos aprovados e IDs financeiros não serão recalculados.

## Organização de implementação

1. Casos persistentes por obrigação/finalidade, eventos imutáveis, ações
   atômicas com versão, fingerprint da fonte e chave de idempotência.
2. Prévia de backfill somente leitura; execução explícita, sem enviar mensagens.
3. Navegação em nove áreas e Pessoas com IDs existentes e rotas legadas preservadas.
4. Central por estado e painel compartilhado em todos os pontos de entrada.
5. Hoje consulta a mesma fila de contatos; entrega/devolução/estorno são outras ações.
6. Modelos em rascunho, simulação e publicação versionada; edição não publica.
7. Validação de regressão, revisão independente, teste visual com dados fictícios e
   PR de revisão. Publicação e migração de produção dependem de aprovação explícita.

## Portas de validação

- SQL: migrações novas em banco isolado + suíte pgTAP existente e novos cenários.
- API: testes sem rede de validação, autorização, concorrência e erros.
- Interface: lint/build e teste com fixtures locais, desktop/mobile/teclado.
- A01–A15 do PDF: matriz preenchida com evidência antes de ampliar uso; não
  confundir teste unitário com homologação operacional feita pelo usuário.
- Revisar discrepâncias de saldo, caso/substituição e contagens antes de ativar.
- Reversão preserva vínculos/eventos. Não manter dois escritores de comunicação.
