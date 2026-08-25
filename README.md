# Console de Ingestão · InfoPrice

Aplicação web que coleta os arquivos de pesquisa de preços da InfoPrice num
diretório SFTP, grava em PostgreSQL e dá rastreabilidade de ponta a ponta:
de cada linha gravada é possível chegar ao arquivo, à linha do arquivo e à
execução que a trouxe.

Implementa o design exportado do Claude Design — as oito telas, em pt-BR, e as
seis ações previstas. O bundle de design não é versionado aqui: ele contém
credenciais do fornecedor em um print de referência.

## O que tem aqui

```
db/migrations/     schema PostgreSQL (tabelas de controle, staging e fato)
server/            coleta SFTP, pipeline de ingestão, agendador, alertas e API
web/               console React (Vite + TypeScript)
shared/            tipos de domínio e contratos da API, usados pelos dois lados
```

## Configuração e segredos

Todos os valores de conexão neste repositório são **placeholders**
(`sftp.exemplo.com.br`, `usuario-sftp`). Os valores reais vivem apenas no
`server/.env` de quem opera, que está no `.gitignore` — assim como `*.pem`.

A senha do SFTP nunca é lida pela aplicação nem exibida na tela: a tela de
configuração mostra a referência do cofre (`vault/infoprice/sftp`), e a
autenticação preferida é por chave privada.

## Como o processo funciona

A coleta roda em dez etapas, as mesmas que aparecem no painel:

| # | Etapa | O que faz |
|---|---|---|
| 1 | Conexão SFTP | autentica por chave `.pem` (senha só como alternativa) |
| 2 | Listagem do diretório | acha a pasta `run=AAAA-MM-DD` e compara o volume com a média de 7 dias |
| 3 | Download para área temporária | baixa em paralelo para `var/spool/infoprice` |
| 4 | Verificação de integridade | SHA-256 do arquivo e do conteúdo descompactado |
| 5 | Validação de schema | confere as colunas obrigatórias no cabeçalho |
| 6 | Carga em staging | `COPY` em `stg_isa_infopanel_preco`, tudo como texto |
| 7 | Regras de qualidade | seis regras; a linha reprovada vai para `ctl_rejeicao` com o payload original |
| 8 | Merge incremental | `UPSERT` em `fact_preco_coletado` pela chave de conflito |
| 9 | Auditoria e watermark | fecha `ctl_execucao` e avança `ctl_watermark` |
| 10 | Notificação | resumo no painel e por e-mail |

As etapas 6 a 9 rodam **numa transação só**. Qualquer falha reverte tudo e a
tabela final continua com o dado da execução anterior — o log do que aconteceu,
porém, é gravado fora da transação e sobrevive para explicar o motivo.

**Idempotência.** Reexecutar o mesmo run é seguro: o staging daquele run é
apagado e recarregado, e o `UPSERT` só conta como atualização a linha cujo preço
mudou de fato. Reprocessar um dia sem alteração na origem grava zero linhas.

### As seis regras de qualidade

Rodam em ordem sobre o staging; a primeira que pega a linha é a dona da
rejeição, então uma linha nunca aparece com dois motivos.

1. GTIN inválido no dígito verificador (módulo 10 GS1, em `infoprice.gtin_valido`)
2. Preço menor ou igual a zero
3. Loja ausente em `dim_loja`
4. Data de coleta fora da janela do run
5. Duplicidade na chave de conflito — mantém a última ocorrência
6. Caractere inválido na descrição (encoding quebrado)

### Rastreabilidade

`ctl_arquivo` responde "o que existe na origem" (identidade `pasta` + `nome`,
hash, tamanho, retenção). Quantas linhas aquele arquivo rendeu é propriedade da
execução, e mora em `ctl_execucao_arquivo`. Por isso reprocessar um arquivo não
apaga o histórico das execuções anteriores.

## Rodando

Requer Node 20+ e PostgreSQL 14+.

```bash
npm install
cp server/.env.example server/.env      # ajuste as credenciais
npm run migrate                         # cria o schema
npm run seed                            # popula dim_loja
npm run dev                             # API em :3001, console em :5173
```

### Sem o servidor do fornecedor

Por padrão `SFTP_DRIVER=local`: a origem é um diretório do disco, com a mesma
interface do SFTP real. O pipeline inteiro roda — download, hash, `COPY`,
`UPSERT` —, só a leitura dos bytes muda.

```bash
npm run gerar-fixtures --workspace @infoprice/server -- --dias 6 --arquivos 4 --linhas 5000
npm run ingest --workspace @infoprice/server -- --run 2026-08-25
```

O gerador semeia defeitos de propósito (~0,29% das linhas, abaixo do limite de
0,5% que abre incidente), um por regra de qualidade, para a tela de rejeições
ter o que mostrar. `--semente 7` regera o mesmo dia com outros preços, o que
demonstra o caminho de atualização do merge.

### Contra o SFTP real

```env
SFTP_DRIVER=sftp
SFTP_HOST=sftp.exemplo.com.br
SFTP_USUARIO=usuario-sftp
SFTP_CHAVE_PRIVADA=/caminho/para/usuario-sftp.pem
SFTP_DIRETORIO_BASE=/home/usuario-sftp/output/ISA-InfoPanel
```

A chave `.pem` **não** é versionada (`.gitignore` cobre `*.pem`). A senha do FTP
nunca aparece na tela: a aplicação recebe apenas a referência do cofre, e é isso
que a tela de configuração mostra.

## Agendamento

| Rotina | Padrão | Configuração |
|---|---|---|
| Coleta diária | `30 5 * * *` America/Sao_Paulo | `CRON_COLETA` |
| Varredura de segurança | `0 12,18 * * *` | `CRON_VARREDURA` |
| Resumo diário | `0 6 * * *` | `CRON_RESUMO` |

Três tentativas com espera de 10, 20 e 40 minutos. Até as 09:00 a ausência da
pasta não abre incidente (`TOLERANCIA_ATE`); depois disso, abre. A varredura
também retoma pastas que apareceram atrasadas e ainda estão dentro da retenção.

Pausar o agendamento pela tela impede a coleta automática — inclusive entre uma
tentativa e outra —, e não afeta a coleta manual.

## Alertas

Seis regras em `ctl_regra_alerta`, editáveis no banco. O painel é sempre canal
obrigatório; o e-mail sai se houver SMTP configurado (`SMTP_HOST`) e, sem ele, o
alerta continua valendo pelo painel. Incidentes são deduplicados por condição +
run, então uma tentativa que falha três vezes abre um incidente, não três.

## API

| Método | Rota | Para quê |
|---|---|---|
| GET | `/api/painel` | KPIs, etapas e histórico da tela do dia |
| GET | `/api/execucoes/:id` | detalhe, log, idempotência, arquivos |
| GET | `/api/execucoes/:id/linhagem` | fluxo e contagem por arquivo |
| GET | `/api/linhagem/preco/:id` | caminho inverso de uma linha do fato |
| GET | `/api/inventario` | pastas monitoradas e retenção |
| GET | `/api/qualidade` | motivos e linhas rejeitadas |
| GET | `/api/incidentes` | incidentes e regras de notificação |
| GET | `/api/precos` | consulta do fato, com origem em cada linha |
| GET | `/api/config` | conexão, agendamento, destino e tabelas |
| POST | `/api/execucoes` | coleta manual |
| POST | `/api/execucoes/:id/reprocessar` | reprocessa o run |
| POST | `/api/arquivos/:id/reprocessar` | reprocessa um arquivo |
| POST | `/api/inventario/:pasta/reprocessar` | reprocessa a pasta |
| POST | `/api/agendamento/pausar` \| `/retomar` | pausa e retoma |
| POST | `/api/incidentes/:codigo/resolver` | marca incidente como resolvido |
| GET | `/api/arquivos/:id/download` | arquivo bruto (cópia local) |
| GET | `/api/inventario/:pasta/download` | pasta inteira em `.tar` |
| GET | `/api/execucoes/:id/auditoria.csv` \| `.pdf` | relatório de auditoria |
| GET | `/api/qualidade/rejeicoes.csv`, `/api/precos.csv` | exportações |

Só uma coleta roda por vez; uma segunda tentativa recebe `409` com a mensagem
que a tela mostra no toast.

## Verificação

```bash
npm run typecheck    # server + web
npm run build        # compila os dois
```
