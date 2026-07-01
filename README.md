# DRSOSystem

Sistema operacional pessoal portátil para organização da vida, finanças, projetos, documentos, apostas e conhecimento.

## Como rodar

1. Abra a pasta do projeto no pendrive.
2. Execute `start.bat` no Windows. Ele usa o Node portátil em `runtime/node` e abre o navegador automaticamente quando a porta fica pronta.
3. Se quiser rodar manualmente com o Node portátil, use:

```powershell
runtime\node\node.exe --no-warnings server/index.mjs
```

Se aparecer "localhost recusou conexao", o servidor nao chegou a abrir a porta. Abra o `start.bat` novamente e veja a mensagem na janela preta. Logs tambem ficam em `server.log` e `server.err.log`.

## Estrutura

- `server/`: servidor local, API e criação do banco SQLite.
- `public/`: interface web.
- `data/`: banco SQLite local, criado automaticamente.
- `backups/`: cópias do banco geradas pelo sistema.

## Portabilidade

Os dados ficam dentro de `data/drsosystem.sqlite`. Para mover o sistema para um pendrive, copie a pasta inteira do projeto. Os backups são salvos em `backups/`.

## DRSO AI Core

O modulo **DRSO AI Core** funciona em modo local mesmo sem chave externa: ele usa resumos seguros dos modulos, insights automaticos e acoes com confirmacao.

Para ativar respostas com a API da OpenAI, crie ou edite o arquivo `.env` na raiz do projeto:

```env
OPENAI_API_KEY=sua_chave_aqui
OPENAI_MODEL=gpt-5.5
```

A chave fica somente no backend. O frontend nunca recebe `OPENAI_API_KEY`. O sistema remove campos sensiveis do contexto antes de chamar a API e nao envia o banco inteiro para a IA.

## Primeira versão

Esta versão inclui dashboard, financeiro, trader esportivo, documentos, projetos, anotações/ideias, timeline, configurações e uma base inicial para módulos personalizados.
