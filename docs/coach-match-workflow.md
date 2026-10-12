# Match com treinador

O administrador abre **Assessoria → Coaches → Match com treinador**, gera um
link individual e o envia manualmente ao coach. O mesmo link continua válido
após a adoção do formulário v2. O coach responde sem ganhar
acesso à área administrativa ou aos dados financeiros. O administrador revisa
as respostas e aprova a versão que, futuramente, alimentará o match calculado no
servidor.

O formulário não é enviado por e-mail automaticamente. O link vale por 30 dias;
gerar outro revoga o anterior. O token completo aparece somente ao gerar o link,
fica no fragmento da URL (`#token=...`) e é enviado no corpo da requisição ao
formulário. O banco guarda apenas seu hash. Tratar o link como confidencial.

## Revisão e publicação das respostas

- Cada envio gera uma nova revisão. Apenas a revisão v2 mais recente, ainda pendente,
  pode ser aprovada ou rejeitada. Pendências anteriores são substituídas.
- Um novo envio não tira do ar a última versão aprovada. Rejeitar uma atualização
  também preserva a versão aprovada anteriormente.
- O painel recebe `latest` e `published` explicitamente; não tenta descobrir a
  versão publicada dentro de uma janela limitada de histórico.
- **Atualizar respostas** consulta o estado atual. Falhas de consulta são exibidas
  como erro, nunca como “nenhuma resposta”. Conflitos de revisão atualizam a tela
  e exigem que o administrador confira a versão mais recente.
- A validade do convite considera o relógio do servidor, o tempo decorrido desde
  a consulta e a revogação. O backend revalida o link em cada acesso/envio.
- Só perfis de coaches ativos e visíveis entram na entrada interna do futuro
  cálculo. O match deve cruzar o perfil aprovado com modalidades e ofertas do
  catálogo existente antes de recomendar um coach; aprovação de respostas não
  cria planos nem ofertas.

## Formulário v2 e lógica prevista

O formulário v2 não contém texto livre. O coach informa em quais formatos atende
(`Florianópolis`, `Online` ou ambos) e escolhe uma afinidade **Principal** e,
opcionalmente, **Também me identifico** em cinco critérios:

- objetivo do atleta;
- momento técnico;
- estilo de acompanhamento;
- faixa etária;
- gênero do atleta.

Em faixa etária e gênero, `Sem preferência` só pode ser a escolha principal e
desabilita a escolha secundária. Nos demais critérios, sempre há uma escolha
principal. Principal e secundária nunca podem ser iguais. A modalidade não é
perguntada: o formulário a mostra como contexto somente leitura, vindo do perfil
canônico do coach na EON Store. Os formatos também são informação factual, não
recebem pontuação nem ordem de preferência.

Na futura pontuação do match, a afinidade principal vale 100% do peso do critério
e a secundária, quando presente, 60%. A distribuição acordada é objetivo 35,
momento técnico 25, acompanhamento 20, faixa etária 10 e gênero 10. Modalidade e
formato de atendimento são filtros eliminatórios antes da pontuação. Esses pesos
não são gravados na resposta do coach e ainda não constituem um endpoint público
de recomendação.

O rollout é reversível: v1 e v2 têm ponteiros independentes para a última revisão
e a última aprovação. Uma resposta v2 não substitui nem apaga a versão v1. O
índice de pendência permite uma pendência de cada versão por coach durante a
transição.

## Isolamento técnico

O módulo usa funções separadas:

| Função | Acesso | Responsabilidade |
| --- | --- | --- |
| `coach-match-admin` | Sessão administrativa verificada no servidor | Consultar, gerar/revogar convite e revisar |
| `coach-match-form` | Token individual válido | Carregar e enviar respostas |
| `public-coach-match` | Leitura pública legada | Entregar somente perfis v1 aprovados durante a transição |

As funções existentes `api-v1` e `public-assessment-prospect` permanecem sem
alterações do módulo. Preços, catálogo, checkout, contratos e pagamentos não
dependem das novas tabelas nem do novo endpoint público.

As tabelas `assessment_coach_match_state`,
`assessment_coach_match_submissions` e `assessment_coach_match_invites` têm RLS e
não são acessíveis diretamente por `anon` ou `authenticated`. As funções de
banco são `SECURITY INVOKER`, acessíveis somente ao papel de serviço usado no
backend após as verificações de acesso. Nenhuma chave de serviço vai ao frontend.

RPCs transacionais serializam emissão, revogação, envio e revisão na linha de
estado exclusiva do match de cada coach. A revisão confere novamente qual é a
última resposta antes de publicar; a validade e os limites de envio são
revalidados dentro da transação. Isso impede que operações simultâneas aprovem
uma resposta antiga ou aceitem um link já revogado. Não há atualização das
tabelas financeiras nem bloqueio explícito de suas linhas.

O contrato v1 e seus RPCs permanecem disponíveis apenas para rollback. O GET
público legado continua validando exclusivamente v1. As respostas v2 incluem
afinidades demográficas de idade e gênero e, por isso, **não são retornadas por
esse GET**. `list_approved_coach_match_profiles_v2` é acessível somente ao papel
de serviço e deve ser usada apenas por um futuro matcher executado no servidor.
Esse futuro endpoint deve receber respostas do visitante por POST, calcular sem
persisti-las e devolver apenas os coaches recomendados e as razões apropriadas,
nunca o perfil bruto de preferências de outros coaches.

## Portão de segurança antes de publicar

- Não executar migração, deploy de função, push para a branch principal ou teste de
  escrita contra o Supabase de produção sem aprovação explícita do responsável.
- Validar a migração e o fluxo completo em um ambiente isolado, sem credenciais
  de cobrança reais nem acesso ao banco financeiro. Testar links expirados,
  convites concorrentes, reenvios e aprovação de versões antigas.
- Rodar testes unitários, testes das Edge Functions, lint e build; revisar o diff
  para confirmar que contratos, pagamentos, Asaas e preços existentes não mudam.
- Conferir no ambiente isolado que o catálogo público, o cadastro e o checkout
  mantêm as respostas atuais mesmo se os dados de match estiverem indisponíveis.
- A implantação de produção segue `docs/deploy-production.md`: PR revisada,
  testes e artefato do CI da branch principal. Não usar deploy manual ou publicar
  um frontend de homologação na Store canônica.
- Mesmo um Deploy Preview pode apontar para o banco de produção. Conferir a URL
  de Supabase compilada, as variáveis, a política CSP e o project ref antes de
  abrir telas administrativas ou executar testes de escrita.
- Se houver regressão, desabilitar o acesso ao módulo e corrigir adiante pelo
  mesmo fluxo de PR/CI. Não apagar tabelas com respostas nem reverter uma
  migração no banco financeiro como tentativa de recuperação.

Este documento descreve o comportamento implementado, não comprova um deploy.
Registrar os resultados dos testes de banco, concorrência, Edge e interface e a
identificação do ambiente isolado antes da liberação. Dados de teste devem ser
fictícios, sem clientes reais, credenciais Asaas ou envio de mensagens.

## Smoke de interface, sem backend real

`scripts/coach-match-ui-smoke.mjs` testa formulário e painel em 1440×1000 e
390×844, usando Chrome/Chromium existente e Playwright. Todas as chamadas de API
são simuladas; qualquer origem fora do Vite local e do Supabase fictício local
é bloqueada. O teste verifica ausência de texto livre, escolha principal e
secundária, exclusividade de `Sem preferência`, modalidades canônicas, prefill, links
expirados, gerar/revogar convites, revisão, conflito e recuperação de erro.

Inicie o Vite com substituições explícitas, nunca com a configuração de produção:

```sh
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=fixture-key npm run dev -- --host 127.0.0.1 --port 5197 --strictPort
```

Em outro terminal, execute `node scripts/coach-match-ui-smoke.mjs`.
Se Playwright ou Chrome não estiverem no caminho padrão, informe
`PLAYWRIGHT_MODULE_PATH` (caminho absoluto do `index.mjs` do Playwright) e
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` (executável existente). O teste usa um perfil
temporário novo, sem o perfil pessoal do navegador.

`MATCH_UI_OUTPUT_DIR` escolhe onde salvar as capturas e `ui-smoke-results.json`.
O teste de interface com mocks não substitui a validação das transações e das
permissões no banco isolado.

## Validação preliminar local — 2026-10-12

- Base revisada: `origin/main` em `1de976793f36a0911e4f153be91381adcb13c3e5`.
- 249 testes unitários e 353 testes Edge (mais 30 steps) passaram. Os testes
  Edge foram executados com Deno 2.9.5 e rede negada, usando dependências simuladas.
- Lint sem erros; 12 avisos preexistentes fora do módulo. Build Vite concluído.
- Smoke de interface passou em desktop e celular: envio, preenchimento anterior,
  expiração, geração/revogação, aprovação/rejeição, conflito e recuperação de erro.
  Foram inspecionadas capturas dos dois tamanhos, sem erros de execução,
  tentativas de conexão externa ou rolagem horizontal.
- 103 verificações SQL passaram em PGlite 0.3.14 e em PostgreSQL 17.6 local,
  com esquema operacional mínimo e dados inteiramente fictícios.
- Sete disputas de transação passaram no PostgreSQL local com duas sessões e
  verificação efetiva de bloqueio: envio duplo, revogação/envio, rotação/envio,
  convites paralelos, novo envio/aprovação, aprovação/novo envio e revisão dupla.
  Foram usados `node-postgres` e o mesmo contrato do teste de concorrência do CI.
- O readback de liberação passou com permissões corretas e recusou sete cenários
  adulterados: migração ausente, RLS desligada, leitura `anon`, escrita
  `authenticated`, DELETE de serviço, EXECUTE de serviço ausente e EXECUTE público.
- Os hashes das nove tabelas operacionais fictícias usadas nos testes não mudaram.

O teste focado é reproduzível com `scripts/tests/coach-match-focused.mjs`; o teste
de concorrência do CI está em `scripts/tests/coach-match-concurrency.py`. A etapa
seguinte ampliou essa cobertura para o esquema completo e a API real local,
conforme registrado abaixo. Os resultados locais não substituem o CI nem
comprovam um deploy em Supabase ou Netlify.

A consulta de custo de um branch remoto na organização Endurance On ficou
indisponível no conector; o painel permitiu consultar o preço, sem criar um
branch. Foi possível prosseguir com um ambiente local, sem criar recursos pagos.

## Homologação local com serviços reais — 2026-10-12

Foi usada uma cópia descartável do código do commit
`f7bfac997610f6d1d730874ecc61f74ef9a24d8a`, com os ajustes de fixtures descritos
abaixo, Supabase CLI **2.120.0**, runtime **native** e PostgreSQL **17.11**.
Auth, PostgREST e Edge Functions foram executados localmente, sem mocks de API.
O runtime native é experimental: este resultado não substitui a execução do CI
no runtime Docker e na versão de CLI definidos pelo repositório.

### Proteções do ambiente

- Nenhum `.env`, chave de produção ou dado de cliente foi copiado. Usuários,
  coaches e demais registros usados nos testes são fictícios.
- Serviços e testes rodaram sob sandbox do sistema operacional, permitindo
  apenas loopback e sockets locais; a negação de saída externa foi conferida
  antes da execução. Telemetria foi desabilitada.
- **Desabilitar `cron.launch_active_jobs` antes de aplicar as migrações é
  obrigatório.** Uma migração histórica agenda uma chamada a um endereço de
  produção. O isolamento de rede e o cron desligado impedem esse efeito lateral.
  Não modificar a migração histórica para o teste nem usar `db reset` sem
  revalidar essa proteção no servidor recriado.
- O ambiente não tem vínculo com projeto hospedado. As 211 migrações originais
  foram aplicadas sem alteração; a configuração de proteção é exclusivamente
  local e não deve ser levada à produção.

### Resultados

- **211 migrações** aplicadas; **29 arquivos pgTAP, 1.101 verificações** aprovadas,
  incluindo 104 do novo módulo e 997 da suíte preexistente.
- **Nove grupos de integração HTTP real** aprovados: autenticação e separação
  administrador/usuário, recusa de acessos indevidos, convite, hash do token,
  envio pendente, aprovação, publicação restrita, reenvio, rejeição, conflito de
  revisão, revogação e visibilidade do coach. O limite de envio foi testado com
  espera real, sem alterar timestamps para contorná-lo.
- As três tabelas e as oito RPCs recusaram acesso direto pelas credenciais de
  navegador, inclusive para usuário administrador. Dados pendentes e rejeitados
  não substituíram a última resposta pública aprovada.
- **Sete testes de concorrência do match e dois da comunicação existente**
  passaram com sessões reais e disputa efetiva de bloqueios. O snapshot das
  tabelas operacionais fictícias foi preservado durante os testes de match.
- O readback retornou `coach_match_readback_ok`. Cron permaneceu desligado,
  com zero execuções registradas e zero chamadas na fila HTTP do banco.
- Após adequação das fixtures ao esquema atual, o teste focado PGlite também
  passou com **104 verificações**.
- O script HTTP definitivo foi reexecutado com sucesso; lint e verificação de
  sintaxe passaram. O stack temporário foi parado ao final, mantendo os
  relatórios locais, e as portas de API e banco ficaram sem listener.

O replay completo identificou dois problemas apenas nos testes: uma fixture
inativa estava marcada como pública, contrariando uma restrição existente; e
dois snapshots ainda citavam `assessment_students`, em vez de
`presale_customers`. As fixtures foram corrigidas e o teste focado passou a
reproduzir a restrição real. Nenhuma regra operacional foi afrouxada e nenhum
arquivo de aplicação, migração, preço, contrato ou pagamento foi alterado para
fazer a homologação passar.

### Reexecutar o teste HTTP

`scripts/tests/coach-match-http-smoke.mjs` exige um ambiente descartável já
migrado, cron desligado e sandbox de rede local aplicado **também aos serviços**.
O script recusa destinos diferentes de `127.0.0.1:54321` (API) e
`127.0.0.1:54322/postgres` (banco), redirecionamentos HTTP e um stack diferente do
ID explicitamente informado. Não executá-lo em portas encaminhadas para um
projeto remoto. As variáveis obrigatórias são:

- `EON_TEST_EPHEMERAL=1`;
- `EON_MATCH_STATUS_FILE`: caminho absoluto do JSON de `supabase status`
  gerado para esse stack nativo local (contém credenciais locais; não commitar);
- `EON_MATCH_STACK_ID`: ID exato de 64 caracteres hexadecimais do stack;
- `EON_MATCH_PG_MODULE`: URL `file:///.../pg/lib/index.js` do módulo `pg`
  já disponível localmente. O script não instala dependências.

Execute `node scripts/tests/coach-match-http-smoke.mjs` dentro do sandbox. O
relatório `coach-match-http-smoke-results.json` é salvo junto ao status, sem
credenciais; `EON_MATCH_REPORT_FILE` permite escolher outro caminho absoluto.
Registros fictícios permanecem somente no ambiente descartável para diagnóstico.
Ao terminar, parar esse stack exato e preservar os relatórios.

### O que ainda não foi liberado

Não houve push, PR, merge, deploy, migração remota, envio de mensagens ou criação
de recurso pago nesta homologação. `api-v1` e `public-assessment-prospect`
permanecem sem alterações do módulo.

Antes de produção, ainda são necessários autorização explícita para enviar o
código ao repositório **público**, revisão/CI na versão atual da branch principal
e conferência da configuração da implantação hospedada. O Deploy Preview atual
usa configuração de produção e **não serve para testes de escrita isolados**.
O pipeline de liberação não é atômico: seguir os portões de segurança e o fluxo
documentado de implantação, sem publicar manualmente ou testar o financeiro real.

## Proteção adicional do CI antes da PR

O job de migrações cria uma rede Docker `--internal` exclusiva da execução antes
do primeiro `supabase start`. Todas as chamadas da CLI usam essa mesma rede.
Um verificador somente leitura recusa rede externa, múltiplas redes, container
parado ou ausência do banco esperado, tanto após o bootstrap quanto após o
reset. Os agendamentos do banco descartável são desativados em ambas as etapas.
Assim, uma URL de produção presente numa migração histórica não ganha uma rota
externa durante o replay. A configuração do banco hospedado não é alterada.

Essa proteção só pertence ao job de testes, não aos jobs de release. Seu parser
é coberto por testes sintéticos; a execução Docker completa será conferida no
CI da PR. O teste HTTP local e os resultados de homologação acima continuam
independentes dessa validação adicional.

### Conexão local da CLI na rede interna

Na primeira execução da PR #112, o build passou, mas o bootstrap da CLI Docker
2.115.0 falhou ao conectar a `127.0.0.1:54322`. A rede interna não disponibiliza
o mapeamento de portas esperado pela CLI. Não foi removido o `--internal` nem
adicionada uma segunda rede com acesso externo para contornar a falha.

O job usa `ci-supabase-loopback.py` para executar o roteiro fixo
`ci-supabase-validation.sh`. Ele fornece somente as duas conexões locais
necessárias à CLI: `127.0.0.1:54322` para o PostgreSQL descartável e
`127.0.0.1:54321` para seu gateway. Os destinos são os IPs privados dos
containers esperados, verificados na rede exclusiva da execução. Não aceita
destinos, portas ou comandos arbitrários. Não encaminha chamadas para o
Supabase hospedado.

Os listeners só são criados depois de os containers existirem e estarem
conectados à rede interna; isso preserva a checagem de portas da CLI antes do
bootstrap. O destino é revalidado nas conexões, inclusive após o reset. Uma
falha de verificação interrompe o roteiro. Ao terminar, o wrapper fecha as
conexões e o workflow continua responsável por destruir o stack descartável e
sua rede, inclusive em falhas. Os jobs de release e produção não são alterados.

Referências da implementação:
- [Docker: acesso do host a uma bridge interna](https://docs.docker.com/engine/network/port-publishing/#gateway-modes).
- [Supabase CLI 2.115.0: bootstrap do banco](https://github.com/supabase/cli/blob/v2.115.0/apps/cli/src/legacy/shared/db-bootstrap/start-database.ts).
- [Supabase CLI 2.115.0: checagens de saúde](https://github.com/supabase/cli/blob/v2.115.0/apps/cli/src/legacy/shared/db-bootstrap/health-check.ts).

Essa correção continua sendo validação de CI, não liberação para produção.
O ambiente hospedado, os dados financeiros e as migrações históricas
permanecem fora do escopo de escrita desta etapa.
