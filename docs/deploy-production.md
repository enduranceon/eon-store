# Publicação em produção

## Regra operacional

- Toda alteração entra por pull request.
- A automação publica uma prévia da pull request na Netlify.
- Produção só é publicada a partir da branch `main`, por integração ou execução manual do workflow nessa branch. Executar o workflow em outra branch apenas valida o código.
- O deploy de produção deve usar o artefato da automação, contendo `dist/` e `netlify.toml` do mesmo commit. A configuração acompanha o site para aplicar redirecionamentos e cabeçalhos; não publicar `dist` de uma cópia local.
- O uso atual registra cobranças externas e pagamentos externos. A integração Asaas continua preparada para uso futuro; esta etapa não a ativa nem publica suas funções auxiliares.

## Ordem da automação e limites

1. Validar as migrações em um banco local descartável e executar lint, testes e build.
2. Somente se as duas validações passarem e a origem for `main`, conferir as credenciais, vincular o projeto Supabase canônico `bsiljrrodgtmtdilnuxr` e validar o plano remoto de migrações sem escrita.
3. Aplicar as migrações pendentes sem seed, roles ou Vault e confirmar no banco remoto o histórico, as RPCs, os triggers e suas permissões.
4. Publicar a `api-v1` somente depois que o readback do banco concluir com sucesso.
5. Publicar o frontend na Netlify (`9a9edc3b-04e4-431f-8927-f946900b0b27`) somente depois da API.

`NETLIFY_AUTH_TOKEN`, `SUPABASE_ACCESS_TOKEN` ou `SUPABASE_DB_PASSWORD` ausentes interrompem o release com erro. Não tratar uma etapa pulada por falta de credencial como publicação bem-sucedida. A Netlify CLI está fixada em `27.5.2`, a versão registrada no último deploy auditado (run `34629189530`, commit `2bbcfc4`); atualizar essa versão em alteração separada, com validação de build e prévia.

Pull requests publicam somente a prévia do frontend. Elas não publicam a API, outras Edge Functions nem migrações remotas. **A prévia usa a configuração de produção e pode acessar dados reais:** ela não é um ambiente de homologação isolado. Nesta etapa, validar a prévia pública sem submissões; usar fixtures locais para cenários de cobrança externa e pagamento externo. Não registrar operações fictícias em alunos reais.

Em pull requests, o workflow valida migrações somente no banco descartável e não escreve no Supabase remoto. Na `main`, ele faz o `dry-run` remoto e aplica todas as migrações pendentes que estiverem no Git antes de publicar a API. Por isso, o plano remoto precisa ser conferido antes da integração e não pode conter uma pendência alheia ao release. Funções Edge auxiliares, inclusive `generate-monthly-closing`, não são publicadas por este workflow; reconciliar seu código no Git não altera a versão em execução.

Banco, API e frontend são publicados em sequência, sem transação conjunta. Se o readback ou a publicação falhar depois da migração, a base já estará atualizada e a correção deve seguir por nova execução ou `forward-fix`. Se a Netlify falhar após o deploy da API, o frontend anterior continuará usando a API nova. Migrações e API devem permanecer compatíveis com a versão anterior do frontend durante todo esse intervalo.

## Validação antes da integração

1. Conferir a prévia publicada pela automação.
2. Testar o fluxo público que foi alterado, sem submissões, e verificar os cabeçalhos HTTP e o console da prévia. Nesta reconciliação, a configuração passa a acompanhar o artefato: conferir a busca de CEP sob a CSP existente e registrar os fluxos ainda não verificados.
3. Para mudanças administrativas, validar as regras com fixtures locais. Login, navegação administrativa, cobrança externa, pagamento externo e geração/impressão de PDFs devem ser verificados em navegador local com backend simulado: carregar uma tela administrativa pode disparar gravações, mesmo sem clicar em salvar. A integração Asaas não faz parte da validação atual.
4. Conferir branch, commit, projetos canônicos e o plano remoto de migrações antes da integração.
5. Integrar a pull request e acompanhar migração, readback, API e Netlify até a conclusão.
6. Conferir a URL oficial e repetir os readbacks do banco após a publicação.

## Recuperação

Se uma publicação regredir, identificar qual componente mudou, usar o deploy anterior da Netlify como referência e abrir uma pull request de correção. Uma restauração do frontend não restaura `api-v1`, funções auxiliares nem banco de dados; uma migração já aplicada exige correção adiante. Não reutilizar pastas temporárias ou builds antigos como fonte de uma nova produção.

## Exceções

Uma publicação manual só pode ocorrer para restaurar uma indisponibilidade e deve:

1. partir de um build concluído com `netlify build --context production`;
2. ser registrada em uma pull request imediatamente depois;
3. conter no título do deploy o motivo da exceção.
