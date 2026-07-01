# DRSOSystem

Sistema operacional pessoal portátil para organização da vida, finanças, projetos, documentos, apostas e conhecimento.

## Como rodar

1. Abra a pasta do projeto no pendrive.
2. Execute `start.bat` no Windows. Ele usa o Node portátil em `runtime/node` e abre o navegador automaticamente quando a porta fica pronta.
3. Se quiser rodar manualmente com o Node portátil, use:

```powershell
runtime\node\node.exe --no-warnings server/index.mjs
```

Se aparecer "localhost recusou conexao", o servidor nao chegou a abrir a porta. Abra o `start.bat` novamente e veja a mensagem na janela preta. Os logs persistentes ficam em `C:\DRSOStorage\logs`.

## Estrutura

- `server/`: servidor local e API.
- `public/`: interface web.
- `C:\DRSOSystem\DRSOSystem`: código da aplicação, atualizado pelo GitHub.
- `C:\DRSOStorage`: dados permanentes, fora do repositório.

## Armazenamento permanente

Por padrão, o sistema usa `C:\DRSOStorage`. A raiz pode ser alterada somente pela variável de ambiente `DRSO_DATA_DIR`. Ela nunca pode apontar para dentro da pasta do projeto.

```text
C:\DRSOStorage\data       banco SQLite, chaves e configurações
C:\DRSOStorage\uploads    documentos, anexos e músicas
C:\DRSOStorage\gallery    fotos, miniaturas e vídeos
C:\DRSOStorage\backups    backups do sistema e da migração
C:\DRSOStorage\logs       logs e PID do servidor
```

As pastas são criadas automaticamente na inicialização. O deploy atualiza somente `C:\DRSOSystem\DRSOSystem` e não executa limpeza em `C:\DRSOStorage`.

## Migrar dados antigos

Feche o DRSOSystem e execute, na pasta do projeto:

```powershell
$env:DRSO_DATA_DIR = "C:\DRSOStorage"
node --no-warnings scripts\migrate-storage.mjs
```

Antes de copiar qualquer arquivo, o script cria um backup completo em `C:\DRSOStorage\backups\migration-*`. Ele não sobrescreve bancos diferentes e não apaga os arquivos originais. A migração é idempotente; para apenas conferir o que seria encontrado, acrescente `--dry-run`.

## DRSO AI Core

O modulo **DRSO AI Core** funciona em modo local mesmo sem chave externa: ele usa resumos seguros dos modulos, insights automaticos e acoes com confirmacao.

Para ativar respostas com a API da OpenAI, crie ou edite `C:\DRSOStorage\data\.env`:

```env
OPENAI_API_KEY=sua_chave_aqui
OPENAI_MODEL=gpt-5.5
```

A chave fica somente no backend. O frontend nunca recebe `OPENAI_API_KEY`. O sistema remove campos sensiveis do contexto antes de chamar a API e nao envia o banco inteiro para a IA.

## Primeira versão

Esta versão inclui dashboard, financeiro, trader esportivo, documentos, projetos, anotações/ideias, timeline, configurações e uma base inicial para módulos personalizados.
