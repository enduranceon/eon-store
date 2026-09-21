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

Validacao da primeira correcao, em 2026-09-21 (PR #62):

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

## Consistencia entre telas (revisao posterior a PR #62)

A consulta reduzida do componente `BusinessPulse` nao carregava
`manual_discount`. O calculo central estava correto, mas `/hoje` recebia
contratos sem desconto. A leitura de planos tambem omitia o prazo e o total
necessarios ao fallback de contratos legados.

As nove superficies de metricas agora compartilham a leitura completa e
paginada de contratos/planos em `assessment-metric-data.js`:

- Hoje (`BusinessPulse`).
- Painel da assessoria, incluindo modalidade e treinador.
- Central Financeira (MRR contratado; caixa e previsoes continuam separados).
- Analytics (carteira, segmentos, ticket contratado e base do LTV estimado).
- Indicadores anuais.
- Auditoria de contratos.
- Clientes (recorrencia mensal).
- Perfil do cliente e perfil do aluno.

O leitor usa o cliente autenticado existente e as mesmas politicas RLS;
nao introduz credenciais privilegiadas ou endpoints. Busca ate a pagina
vazia, inclusive quando o servidor limita paginas abaixo de 1000 linhas.
Falhas de leitura sao propagadas, sem entregar uma carteira parcial.

### Efetivacao e periodo

- Contrato efetivado nao significa necessariamente pagamento quitado.
  Contratos operacionalmente ativos com cobranca aberta ou em licenca
  continuam na carteira; nao transformar inadimplencia em churn.
- Rascunhos, vendas descartadas, cancelados/concluidos e contratos agendados
  ficam fora do MRR atual. Um registro legado com status ativo e inicio
  futuro tambem fica fora ate a data inicial, sem gravar novo status.
- Esse filtro de inicio tambem vale para a base ativa do ticket. Nao contar
  `customer_id` vazio como um aluno adicional.
- Mes atual nos graficos = carteira de hoje, igual ao KPI atual. Contratos
  com fim previsto antes do ultimo dia do mes nao somem antecipadamente.
- Meses encerrados usam a mesma vigencia historica nos dois graficos:
  inicio inclusivo e fim exclusivo; vendas canceladas sem evidencia de
  efetivacao ficam fora. Isso evita duplicar o contrato anterior e sua
  renovacao na data de troca. Nao altera regras de saida/churn do relatorio.
- Historicos ainda sao reconstrucoes, nao snapshots mensais imutaveis.
  A base historica de alunos usa vigencia; a carteira atual usa lifecycle.
- Filtros de Analytics podem mudar o recorte. Os KPIs de MRR mostram o
  valor completo; somente os eixos dos graficos abreviam a escala.
  Ticket recebido e LTV realizado continuam baseados no
  financeiro; nao sao o ticket contratado ou o LTV estimado.
- As estimativas de LTV preservam suas bases de churn: Hoje usa o mes e
  Analytics mensaliza o periodo selecionado. Ambas usam ticket contratado
  apos descontos, mas nao precisam ser numericamente iguais.

### Auditoria e testes

Consulta somente de leitura em producao encontrou cinco contratos com
status ativo e inicio em 2026-09-25, ainda futuro em 2026-09-21. Eles deixam
de antecipar MRR nesta revisao. Nenhum contrato foi atualizado no banco.

- Quatro testes novos reproduziram divergencias dos graficos e de inicio
  futuro antes da correcao.
- Testes do SDK Supabase com fetch simulado cobrem campos, fallback, escopo
  por cliente, falhas e carteiras de 0, 1000, 1001 e 2001 contratos.
- Comparacao dos modulos de KPI, auditoria, perfis, Analytics e historicos
  com a mesma carteira ficticia, preservando caixa e os dados de entrada.
- Conferencia no navegador: nove rotas desktop e tres mobile, contrato
  ficticio de 200 com desconto de 50 mostrando MRR de 150. Todas as chamadas
  externas interceptadas; zero requisicoes ao backend real e zero erros JS.
- Repeticao com valor ficticio de 28.750 para conferir legibilidade.
  Cards do Painel e Analytics ajustados para nao cortar o MRR no mobile;
  Analytics e Indicadores exibem o valor completo com centavos no KPI.
- Sem migrations, alteracoes de cobranca, ativacao Asaas ou deploy nesta
  revisao local. Testes de backend executados com rede bloqueada.
- Validacao local: 67 testes unitarios e 209 testes de backend aprovados;
  lint sem erros (12 avisos preexistentes) e build aprovado. Regressao das
  metricas verificada em UTC e America/Sao_Paulo.
