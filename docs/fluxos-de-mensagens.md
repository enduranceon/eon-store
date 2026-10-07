# Fluxos de mensagens

Conversas que o sistema puxa com o aluno pela Central de Comunicação. Cada
fluxo registra quem entra, os passos, o que trava e as decisões em aberto. As
mensagens são enviadas manualmente pelo WhatsApp; o sistema sugere o texto e
registra o envio quando o operador confirma.

Próximos fluxos a documentar: cobrança, renovação e proposta para prospect.

## 1. Onboarding

Regra de entrada: `eon_private.communication_onboarding_eligible` (migrações
`20261007170000_onboarding_first_membership_only.sql` e
`20261007190000_onboarding_returning_students.sql`). O caso de onboarding é
aberto pelo gatilho do contrato e reavaliado a cada mudança relevante; quando a
regra deixa de valer, o caso fecha como `source_resolved`.

```mermaid
flowchart TD
  A([Contrato da assessoria pago<br/>ativo, agendado ou em licença]) --> B{Renovação ligada<br/>ao contrato anterior?}
  B -- sim --> X[Sem onboarding]
  B -- não --> C{Marcado como aluno<br/>ativo no prospect?}
  C -- sim --> X
  C -- não --> D{Pago há mais de 30 dias?}
  D -- sim --> X
  D -- não --> E{Já teve algum contrato antes?<br/>pela data de início}
  E -- não, aluno novo --> F[Abre a boas-vindas na Central]
  E -- sim --> K{O último terminou há<br/>mais de 30 dias?}
  K -- não, renovação --> X
  K -- sim, retorno --> F
  F --> G[Passo 1: boas-vindas<br/>no dia do pagamento]
  G -- enviada --> H[Espera 5 dias]
  H --> I[Passo 2: check-in]
  I -- enviado --> J([Onboarding concluído])
```

- Entram no mesmo onboarding o **aluno novo** (nunca teve contrato real na
  assessoria) e o **ex-aluno que volta** depois de mais de 30 dias sem contrato.
  Contrato real é ativo, vencido, em licença, encerrado, ou cancelado/agendado
  com pagamento. Rascunhos, prospects e contratos anulados não contam.
- Renovação, inclusive atrasada até 30 dias, não entra. O fim do contrato é
  exclusivo (`end_date`); no cancelado, o dia do cancelamento ainda conta.
- A ordem entre contratos vem da data de início, não da data de cadastro.
  Histórico importado depois (Tecnofit) e contratos de alunos migrados contam
  como contrato anterior.
- A boas-vindas só vale para pagamento dos últimos 30 dias (data do pagamento
  ou, sem ela, data de início).
- Trava o envio: falta de WhatsApp válido, falta do link da comunidade
  (boas-vindas) ou pagamento reaberto.

### Decisões em aberto

Decidido em 07/10/2026: ex-aluno que volta recebe o mesmo onboarding do aluno
novo. O limite de 30 dias sem contrato para contar como retorno é o padrão
adotado e pode ser ajustado.

1. Mensagem apresentando o novo treinador quando a renovação troca de treinador.
2. Prazo da boas-vindas: hoje 30 dias depois do pagamento; sugestão inicial de 7.
3. Passos do onboarding: manter boas-vindas no dia e check-in em 5 dias, ou
   acrescentar outro (ex.: check-in de 30 dias).
