# Piloto de pessoas — EON Hub

Primeira etapa da unificação: um cadastro de pessoa reúne a identidade comercial da Store e os perfis esportivos do Hub, com origem e decisões rastreáveis. O piloto usa uma entrada Vite separada, uma API local de consulta e um PostgreSQL local. Não faz parte do build nem das rotas da aplicação atual.

## Regras do cadastro

- A pessoa pode ter perfil de atleta e papel de coach. Ter benefício da equipe não concede papel de coach nem permissão de acesso.
- O vínculo é comercial, benefício da equipe ou parceria. Equipe e parceiros treinam sem cobrança e ficam fora da métrica **Alunos ativos**.
- Situação esportiva e situação comercial são independentes. Licença comercial não define automaticamente a situação dos treinos. Alunos comerciais em licença continuam na métrica comercial conforme a regra da Store.
- Ligações entre identidades usam exclusivamente o mapa reconciliado. Não há deduplicação automática por nome, telefone ou contato compartilhado.
- Duplicatas confirmadas conservam os IDs antigos como aliases. Identidades históricas ainda sem confirmação permanecem separadas e identificadas para revisão.
- Saída confirmada encerra a participação projetada, preservando cadastro e referências. Não inventa data de saída nem transforma uma confirmação de saída em confirmação de identidade.

## Executar localmente

Requer Node 24, npm e Docker local. O script do banco cria um container identificado como `eon-unification-pilot`, publica somente `127.0.0.1:55432` e gera senhas aleatórias em `pilot/.local/` (ignorado pelo Git). Não usa variáveis de ambiente da Store/Supabase.

```sh
npm ci
npm run pilot:db
npm run pilot:import -- --snapshot /caminho/privado/mapeamento-revisado.json --manifest /caminho/privado/ensaio-migracao-manifesto.json
npm run pilot:build
npm run pilot:serve
```

Abra `http://127.0.0.1:8787`. Para desenvolver a interface, mantenha a API rodando e use `npm run pilot:dev` em outro terminal (`http://127.0.0.1:5174`).

O importador confere a integridade do snapshot contra o manifesto antes de gravar. A importação é transacional e repetível; vínculos conflitantes interrompem o processo. A API usa uma conta do PostgreSQL com acesso somente de leitura.

Para experimentar sem o levantamento privado, substitua a importação pelos arquivos fictícios incluídos no projeto:

```sh
npm run pilot:import -- --snapshot pilot/fixtures/synthetic-snapshot.json --manifest pilot/fixtures/synthetic-manifest.json
```

Cada importação guarda os hashes dos arquivos e da projeção produzida. Repetir a mesma importação não cria duplicatas; mudanças na projeção geram uma nova versão consultável, conservando as anteriores. O apontador da tela passa à última nova importação concluída.

Os dados privados devem ficar fora do repositório ou em `pilot/.local/`. Não publicar este piloto com os dados reais em um deploy público. As fixtures de testes são inventadas e não derivadas de clientes reais.

## Escopo da validação

A referência reconciliada de 12/11/2026 projeta 225 alunos comerciais (incluindo oito em licença), 13 benefícios (sete da equipe e seis parceiros), quatro novos perfis esportivos e 73 cadastros históricos da Store sem identidade conciliada. São contagens do levantamento e das decisões; não são métricas ao vivo.

O primeiro import preserva 974 identidades de origem em 709 cadastros provisórios: 339 clientes Store e 635 atletas Hub, com 262 ligações selecionadas e três aliases confirmados. Cadastros provisórios não equivalem a uma contagem definitiva de pessoas únicas: a revisão histórica continua pendente.

O banco de teste contém a projeção do cadastro, vínculos, referências de origem e decisões. **Atividades, voltas, testes, provas, arquivos, pagamentos e contas de acesso não foram migrados.** O histórico esportivo permanece no Hub; os IDs preservados permitem a próxima etapa. As propostas de status e novos perfis existem somente no piloto. Não há chamadas de escrita ao Supabase, Asaas, e-mail ou WhatsApp.

A correção pontual de contrato aplicada anteriormente em produção está identificada no manifesto como já executada e não é repetida. Nenhum efeito financeiro ou recálculo de repasses é executado pelo piloto.

## Verificação e evolução

```sh
npm run pilot:test
npm run pilot:build
npx playwright install chromium
npm run pilot:test:browser
npm run test:unit
npm run build
```

Os testes cobrem classificação de vínculos, contagens por pessoa, ambiguidades, preservação de aliases, proteção de destino, leitura da API e importação. A validação visual e de navegação deve ser feita com a API local e dados de teste.

Os testes de navegador usam respostas fictícias e iniciam o Vite na porta 5174; deixe-a livre. Se já houver um Chromium instalado, é possível definir `PILOT_CHROMIUM=/caminho/do/chromium` ao executar `npm run pilot:test:browser`.

O próximo avanço é validar esta tela e o modelo de pessoa/vínculo antes de transportar o histórico esportivo completo. Login único, políticas de acesso por coach, migração de arquivos e integrações, e corte definitivo de produção precisam de ensaios próprios. Este piloto não é uma migração pronta para produção.

Para interromper o banco sem apagar dados:

```sh
docker --host=unix:///var/run/docker.sock stop eon-unification-pilot
```

O volume `eon-unification-pilot-data` preserva o ensaio. Não removê-lo antes de encerrar a revisão dos dados.
