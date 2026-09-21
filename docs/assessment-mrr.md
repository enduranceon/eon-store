# MRR pelo valor contratado

## Regra

Um unico MRR para assessoria: somar o valor mensal do servico vendido nos
contratos considerados ativos pela regra de lifecycle existente.

`MRR do contrato = max(0, preco total do servico - desconto manual) / meses do plano`

- O total do plano ja incorpora eventual promocao do pacote. Nao recalcular
  esse desconto a partir da mensalidade de vitrine.
- Usar primeiro o snapshot do contrato, preservando preco e prazo da venda.
- Nao adicionar matricula nem subtrair saldo de credito, taxas ou estornos.
- Nao usar o numero de parcelas, a data de recebimento ou a vigencia estendida
  por licenca como divisor.
- Aplicar o desconto registrado neste contrato, mesmo se nao for recorrente.
  A renovacao ja decide se deve copiar esse desconto para o contrato seguinte.
- Ticket mensal por aluno = MRR / alunos unicos da mesma carteira ativa.
- Manter precisao na divisao mensal; arredondar na exibicao, nao cada parcela
  mensal antes de somar os contratos.

## Compatibilidade

O calculo compartilhado esta em `src/lib/assessment-contract-mrr.js`.
Lifecycle, painel, Analytics, ticket e historicos usam a mesma funcao.

Duracao: `period_months` ou o campo legado `period` do snapshot; na ausencia,
usar a duracao do cadastro do plano. Nao misturar uma duracao nova do catalogo
com uma duracao conhecida no snapshot.

Preco: total do snapshot; se o snapshot antigo possui apenas mensalidade,
preservar essa mensalidade como base, sem aplicar um total novo do catalogo.
Sem preco no snapshot, usar total/mensalidade do cadastro do plano.

Para registros incompletos sem duracao em nenhuma fonte, preservar a base
mensal legada, abatendo o desconto registrado uma vez nessa base. Nunca
interpretar o total de um pacote sem prazo como receita de um unico mes.
Esses registros precisam de conferencia cadastral para mensalizacao exata.
Valores vazios ou invalidos nao devem gerar NaN; MRR nunca fica negativo.

## Exemplos

| Contrato | Antes | Depois |
| --- | ---: | ---: |
| Mensalidade 200, desconto individual 50 | 200 | 150 |
| Semestral: vitrine 200/mes, total vendido 1080 | 200 | 180 |
| Anual: vitrine 200/mes, total 2160 e desconto 120 | 200 | 170 |
| Mensalidade 200 sem desconto | 200 | 200 |

## Limites e seguranca

- Alteracao de leitura/calculo no frontend, sem migration ou escrita no banco.
- Nenhuma alteracao em cobrancas, pagamentos manuais, estornos, renovacoes ou
  integracao Asaas. Emissao Asaas deve permanecer desativada.
- Status, entrada/saida, churn e regras de quem pertence a base permanecem
  inalterados. Um desconto de 100% nao deve, sozinho, registrar saida do aluno.
- Historicos continuam reconstruidos pelos dados atuais de cada contrato;
  nao sao snapshots contabeis imutaveis. Mudancas posteriores de desconto no
  mesmo contrato podem alterar essa reconstrucao, como os demais dados dele.
- A mudanca nao corrige dados antigos, aloca desconto entre matricula/servico,
  nem cria uma agenda de descontos dentro de um mesmo contrato.
- Testes novos usam somente contratos ficticios, sem acessar producao.

## Verificacao

`npm run test:unit` inclui casos de desconto, pacote promocional, duracoes,
legado, precisao, renovacoes, estados operacionais, historico, Analytics e
preservacao de totais financeiros. Rodar tambem os testes de backend com rede
bloqueada, lint e build antes de publicar esta alteracao separadamente.

Validacao local em 2026-09-21:

- 50 testes unitarios aprovados, incluindo 33 novos testes de MRR.
- 209 testes de backend aprovados com `--deny-net`, incluindo os fluxos
  externos/manuais, renovacoes e protecoes do piloto Asaas.
- Lint sem erros; 12 avisos preexistentes em arquivos nao alterados.
- Build aprovado; aviso preexistente de bundle acima de 500 kB.
- Site e modulos alterados responderam HTTP 200 na previa local.
- Consulta agregada somente de leitura no projeto Supabase canonico nao
  encontrou contratos sem duracao identificavel; nenhum contrato com status
  ativo, vencido ou em licenca estava sem snapshot do plano.
- Nenhum deploy, alteracao de segredos, chamada ao Asaas ou escrita de dados
  financeiros foi realizada. Alteracao preparada em branch local separada.

A previa local continua usando o backend configurado no projeto. Nao criar
contratos ou pagamentos ficticios nela: frontend local nao isola producao.
