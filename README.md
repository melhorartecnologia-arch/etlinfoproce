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
db/migrations/     schema PostgreSQL (controle, staging, fato e usuários)
server/            coleta SFTP, pipeline de ingestão, agendador, alertas e API
web/               console React (Vite + TypeScript)
shared/            tipos de domínio e contratos da API, usados pelos dois lados
```

## Acesso

O console exige login. Nenhuma rota de dados responde sem sessão — nem para
leitura.

**Primeiro acesso.** Uma instalação nova não tem ninguém cadastrado, e não
criamos um `admin/admin` padrão de propósito: uma senha conhecida em toda
instalação é uma porta aberta. Crie o primeiro administrador pela linha de
comando; a senha é sorteada e exibida uma única vez.

```bash
npm run usuario --workspace @infoprice/server -- \
    criar --login seu.login --nome "Seu Nome" --papel administrador
```

Outros comandos: `listar`, `senha` (redefine), `papel`, `desativar`, `ativar`.

**Papéis.**

| Papel | Pode |
|---|---|
| `leitor` | ver todas as telas e exportar relatórios |
| `operador` | o acima, mais coleta manual, reprocessamento, pausar o agendamento, resolver incidentes e baixar arquivos |
| `administrador` | o acima, mais a gestão de usuários e zerar a base |

A interface esconde o que o papel não alcança, mas quem garante é o servidor:
cada rota de ação exige o papel na entrada. O último administrador ativo não
pode ser rebaixado nem desativado.

**Sessão.** Fica do lado do servidor, num cookie `HttpOnly` + `SameSite=Strict`
(marque `COOKIE_SEGURO=true` em produção, sob HTTPS). Desativar um usuário ou
redefinir sua senha encerra as sessões dele na hora, sem esperar expirar.

**Senha.** Guardada com `scrypt` (N=16384), sal por usuário, comparação em tempo
constante. Mínimo de 10 caracteres misturando letras e números. Senha definida
por um administrador nasce provisória: o servidor recusa qualquer ação até que
a pessoa troque. Cinco falhas de login em 15 minutos travam o usuário — e o
limite por IP é quatro vezes maior, para não punir um escritório inteiro atrás
do mesmo NAT. Toda tentativa fica registrada em `ctl_tentativa_login`.

## Processar datas anteriores

**Coleta manual** abre a lista de datas que podem ser processadas: as pastas
`run=` que ainda estão na origem, as que têm cópia local na área temporária e,
para cada uma, a última execução. Marque uma ou várias — elas rodam uma por
vez, da mais antiga para a mais nova; uma falha numa data não segura as
seguintes, e **Parar coleta** encerra a fila. A natureza de cada carga é
registrada: *carga histórica* para uma data passada nunca processada,
*reprocessamento* para uma já processada (sem duplicar nada).

A origem guarda cada pasta por `RETENCAO_ORIGEM_DIAS` (5). Uma data que já saiu
dela continua podendo ser processada enquanto houver cópia local
(`RETENCAO_LOCAL_DIAS`, 30): o pipeline usa os arquivos da área temporária no
lugar do download e registra isso no log.

**Coleta do dia** abre na coleta em andamento — que pode ser de uma data
anterior — e tem um seletor para rever o painel de qualquer data já processada.

## Entender as rejeições

**Qualidade e rejeições** examina qualquer execução (seletor no topo; abre na
mais recente). Os motivos filtram a lista ao clique; dá para filtrar também por
arquivo e procurar um trecho na linha (GTIN, loja, descrição). Cada linha
rejeitada traz uma explicação com os valores dela, por exemplo:

- `GTIN "7896110000283": o dígito verificador deveria ser 2, mas veio 3.`
- `Data 2026-10-20 é posterior ao run 2026-10-17.`
- `A linha tem 45 colunas e o cabeçalho 44.` (aspa sem par ou delimitador a mais)

Ao clicar, aparece a linha original como veio e, ao lado, cada coluna com o
nome do cabeçalho do arquivo, com as colunas que dispararam a regra em
destaque. A exportação CSV respeita os filtros e leva a explicação e os campos
interpretados. A linha é guardada exatamente como veio, e o cabeçalho de cada
arquivo fica em `ctl_arquivo`, para que a tela refaça a interpretação da carga.

## Parar uma coleta

Durante uma coleta, o cabeçalho troca **Coleta manual** por **Parar coleta**
(operador); o detalhe da execução e a tela de zerar a base têm o mesmo botão.
A coleta para num ponto seguro — entre arquivos, a cada lote lido, e a consulta
SQL em curso é interrompida no próprio PostgreSQL. Os arquivos já gravados
ficam, o arquivo em curso é revertido, e a execução termina como `cancelada`,
sem abrir incidente nem disparar nova tentativa. A varredura das 12:00 e 18:00
retoma os arquivos que ficaram pendentes; pause o agendamento se não quiser isso.

O pedido de parada fica no banco, então alcança também uma coleta rodando no
terminal (`npm run ingest`). Ali, **Ctrl+C** faz a mesma parada segura; um
segundo Ctrl+C, depois de 2 s, encerra na hora. Desligar o servidor
(`pm2 stop`, SIGTERM) também para a coleta antes de sair.

**Coleta órfã.** A coleta grava um batimento a cada 30 s. Se o processo morrer
sem parar a coleta (queda de energia, terminal fechado à força), a execução
ficaria "em andamento" para sempre — e, como só uma pode estar em andamento,
bloquearia o reset e toda coleta nova. Uma execução sem batimento há mais de
2 minutos é tratada como órfã: é encerrada como cancelada na subida do
servidor, antes de uma coleta nova começar, antes de zerar a base, ou na hora,
pelo botão **Parar coleta**.

## Zerar a base

Apaga todo o histórico de dados e de metadados e deixa a aplicação como
recém-instalada. Numa transação só — ou apaga tudo, ou nada.

| Apaga | Mantém |
|---|---|
| execuções, etapas e log técnico | schema (as migrações continuam aplicadas) |
| inventário de arquivos e participações | regras de alerta e agendamento |
| staging, preços gravados e todas as partições mensais | o registro dos próprios resets (`ctl_reset`) |
| rejeições e incidentes (o código volta a #201) | usuários e sessões — salvo `--incluir-usuarios` |
| lojas (`dim_loja`), watermark e tentativas de login | cópias locais dos arquivos — salvo a opção de apagá-las |

**Pela tela** — *administração › Zerar base*, só administrador. Mostra o que
será apagado, exige digitar `ZERAR TUDO` e a sua senha, e pode apagar também as
cópias locais dos arquivos. Os usuários ficam: apagá-los pela tela trancaria o
próprio administrador do lado de fora. É recusado enquanto houver coleta em
andamento, e nenhuma coleta começa enquanto o reset roda.

**Pelo terminal** — pare o servidor antes (`pm2 stop console-ingestao`):

```bash
npm run zerar-base --workspace @infoprice/server
npm run zerar-base --workspace @infoprice/server -- --apagar-arquivos
npm run zerar-base --workspace @infoprice/server -- --incluir-usuarios --apagar-arquivos
```

`--incluir-usuarios` apaga também usuários e sessões — a aplicação volta ao
estado de instalação, e o administrador é criado de novo com `npm run usuario`.
Sem `--sim`, o comando pede a frase de confirmação.

Atenção às cópias locais: o fornecedor guarda os arquivos por 5 dias. O que for
mais antigo que isso e for apagado da área temporária não poderá ser baixado de
novo. Na dúvida, faça um backup do banco antes.

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
| 5 | Validação de schema | confere só o cabeçalho de cada arquivo, antes de carregar |
| 6 | Carga em staging | `COPY` em `stg_isa_infopanel_preco`, tudo como texto |
| 7 | Regras de qualidade | oito regras; a linha reprovada vai para `ctl_rejeicao` com o payload original |
| 8 | Merge incremental | `UPSERT` em `fact_preco_coletado` pela chave de conflito |
| 9 | Auditoria e watermark | fecha `ctl_execucao` e avança `ctl_watermark` |
| 10 | Notificação | resumo no painel e por e-mail |

As etapas 6 a 8 rodam **arquivo a arquivo, cada um numa transação própria**:
o arquivo passa por staging, regras e merge e é efetivado antes de o próximo
começar. O que já foi gravado fica gravado — uma falha no arquivo 30 reverte
só o arquivo 30, os demais seguem, a execução fecha como parcial e a varredura
tenta o arquivo de novo. O painel mostra o avanço a cada arquivo, e o log
registra uma linha por arquivo gravado (lidas, rejeitadas, inseridas,
atualizadas, duração). O log é gravado fora das transações e sobrevive para
explicar qualquer falha.

A etapa 5 confere o cabeçalho de todos os arquivos antes de carregar qualquer
linha, então um layout errado é recusado em segundos, com a primeira linha do
arquivo no log para diagnóstico.

**Idempotência.** Reexecutar o mesmo run é seguro: o staging de cada arquivo é
apagado e recarregado, e o `UPSERT` só conta como atualização a linha cujo preço
mudou de fato. Reprocessar um dia sem alteração na origem grava zero linhas.

### As oito regras de qualidade

Rodam em ordem sobre o staging de cada arquivo; a primeira que pega a linha é a
dona da rejeição, então uma linha nunca aparece com dois motivos.

1. Linha malformada no arquivo (não pôde ser separada em colunas)
2. GTIN inválido no dígito verificador (módulo 10 GS1, em `infoprice.gtin_valido`)
3. Preço menor ou igual a zero
4. Preço acima do limite (o fato guarda `numeric(12,2)`; maior que isso estouraria o merge)
5. Loja ausente em `dim_loja` — com `CADASTRAR_LOJAS` ligado (o padrão), as
   lojas do arquivo são cadastradas antes das regras, com a rede, a UF e a
   cidade que ele informa, e a regra só pega a linha sem loja
6. Data de coleta fora da janela — posterior ao run, ou mais antiga que
   `JANELA_COLETA_DIAS` (365 por padrão: o arquivo traz o último preço visto
   em cada loja, que pode ter meses)
7. Duplicidade na chave de conflito, dentro do arquivo — mantém a última
   ocorrência. A mesma chave em outro arquivo do run vira atualização no merge
   do arquivo seguinte.
8. Caractere inválido na descrição (encoding quebrado)

### Leitura tolerante do CSV

Uma linha defeituosa nunca interrompe a execução. O leitor aceita os dois
escapes de aspas que aparecem na prática — `""` e `\"`, o padrão do Spark, que
gera os arquivos `part-*.csv.gz` — e campos entre aspas com quebra de linha.
Uma aspa solta é lida como texto quando a linha ainda tem o número certo de
colunas; quando não tem, a linha entra no staging com o texto original e cai
na regra 1. O log da execução conta as linhas de cada caso, por arquivo.

### Layout do arquivo

O layout da InfoPrice (ISA-InfoPanel) é reconhecido sem configuração: 44
colunas separadas por `|`, nulo gravado como `\N` (padrão do Spark).

| Coluna interna | Vem de |
|---|---|
| `data_coleta` | `data_preco` |
| `id_loja` | `loja` (ou `id_loja`, quando `loja` vier vazia) |
| `municipio` | `cidade` |
| `preco` | `preco_regular` (ou `preco_pago`, quando o regular vier vazio) |
| `preco_promocional` | `preco_pago`, quando `flag_promocao` = true |
| `tipo_preco` | `Promoção` ou `Regular`, a partir de `flag_promocao` |
| `gtin`, `descricao`, `rede`, `uf` | colunas de mesmo nome |

As demais colunas seguem preservadas no payload de cada linha. Quando duas
colunas do arquivo caem no mesmo nome interno, vale o primeiro valor não vazio.

As colunas obrigatórias são `gtin`, `descricao`, `id_loja`, `preco` e
`data_coleta`; outros nomes alternativos comuns (`ean`, `produto`,
`codigo_loja`, `valor`, `dt_coleta`…) também são reconhecidos. Para ver como um
arquivo é interpretado — delimitador, cada coluna e para qual nome interno ela
foi mapeada, o que falta:

```bash
npm run inspecionar-arquivo --workspace @infoprice/server -- caminho/part-00000.csv.gz
```

Sem argumento, ele pega o arquivo mais recente da área temporária. Conforme o
resultado, ajuste no `server/.env`:

- **Nomes diferentes** — `MAPA_COLUNAS=gtin=cd_ean,preco=vl_preco,...`
  (coluna interna = nome no arquivo).
- **Arquivo sem cabeçalho** (o padrão do Spark ao gravar CSV) —
  `CSV_COLUNAS=gtin,descricao,id_loja,...` com os nomes na ordem das colunas;
  a primeira linha passa a ser lida como dado.

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

O gerador produz o layout real da InfoPrice e semeia defeitos de propósito (~0,32% das linhas, abaixo do limite de
0,5% que abre incidente), um por regra de qualidade, para a tela de rejeições
ter o que mostrar — e também aspas escapadas com barra, que devem ser aceitas. `--semente 7` regera o mesmo dia com outros preços, o que
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

## Deploy contra o PostgreSQL do Amazon RDS

Aponte `PGHOST` para o **endpoint do writer** — a aplicação escreve, e com
Multi-AZ esse endpoint acompanha a instância ativa depois de um failover.

### TLS

```env
PGHOST=infoprice.abc123.sa-east-1.rds.amazonaws.com
PGSSLMODE=verify-full
CA_RDS=./certs/rds-global-bundle.pem
```

```bash
npm run baixar-ca-rds --workspace @infoprice/server
```

`verify-full` é o padrão automático quando `PGHOST` termina em
`.rds.amazonaws.com`. Ele confere o certificado contra as CAs da AWS **e** o
hostname — é o que separa "a conexão está cifrada" de "a conexão está cifrada
com quem eu penso que é". `require` cifra sem verificar e protege apenas de
escuta passiva; existe como saída para quem não consegue provisionar o bundle,
e o servidor avisa no log quando está nesse modo.

No RDS, ligue também `rds.force_ssl=1` no parameter group: aí o próprio banco
recusa conexão em texto claro, independentemente do que a aplicação peça.

Para conferir antes de subir:

```bash
npm run testar-conexao --workspace @infoprice/server
```

Ele responde se a conexão está cifrada **de fato** (lendo `pg_stat_ssl`), e sai
com erro se o banco for remoto e o tráfego estiver em texto claro.

### Credenciais

| `PG_CREDENCIAL` | Como funciona |
|---|---|
| `env` | senha em `PGPASSWORD` |
| `secrets-manager` | senha lida de um segredo, via `PG_SEGREDO_ARN` |
| `iam` | token IAM de 15 min, gerado a cada conexão — sem senha fixa |

`iam` é o mais robusto: não existe segredo de longa duração para vazar, e
revogar acesso é tirar a permissão no IAM. Exige `GRANT rds_iam TO <usuario>` no
banco e a ação `rds-db:connect` no papel da aplicação. Os dois modos da AWS
usam pacotes opcionais, instalados só se você escolher usá-los:

```bash
npm i @aws-sdk/rds-signer --workspace @infoprice/server              # iam
npm i @aws-sdk/client-secrets-manager --workspace @infoprice/server  # secrets-manager
```

O usuário (`PGUSER`) vem sempre do ambiente: nome de login não é segredo.

### Tempos e failover

O pool usa `keepAlive`, para detectar o socket morto que sobra depois de um
failover Multi-AZ em vez de descobri-lo só na próxima consulta. Erros em
conexões ociosas são tratados e registrados: o driver descarta a conexão
quebrada e abre outra sozinho.

`statement_timeout` vale 30 s para as consultas de tela. A transação da
ingestão — COPY, regras de qualidade e merge — levanta o próprio teto para
`PG_TIMEOUT_INGESTAO_MS` (1 h por padrão), porque ela passa bem disso com
volume real. `idle_in_transaction_session_timeout` derruba a sessão que ficar
parada dentro de uma transação, para que um processo travado não segure locks
no RDS até alguém notar.

### Migrações

Rodam na subida, protegidas por um advisory lock: várias tarefas do serviço
subindo ao mesmo tempo não aplicam o mesmo arquivo em paralelo — uma aplica, as
outras esperam e seguem. As migrações rodam sem `statement_timeout`, já que
criar índice em tabela grande passa dos 30 s.

O schema não exige superusuário. `gen_random_uuid()` é nativo do PostgreSQL 13+,
que é o piso das versões do RDS, então `pgcrypto` não é necessário — o usuário
mestre do RDS não é superusuário e não poderia criá-lo.

### Rede

A instância deve ficar em subnet privada, sem acesso público, e o security
group do RDS deve liberar a porta 5432 **apenas** para o security group da
aplicação — não para um bloco CIDR aberto.

### Atenção: disco efêmero

A área de spool (`AREA_TEMPORARIA`) guarda as cópias locais dos arquivos
baixados, e é dela que saem o "Baixar bruto" e o download da pasta em `.tar`.
Se a aplicação rodar em contêiner (ECS/Fargate), esse disco morre a cada
implantação, e a retenção de 30 dias prometida pela tela não se sustenta —
o botão passa a responder "cópia local indisponível" para tudo que veio antes
do último deploy.

Escolha um destes antes de ir a produção:

- **EFS** montado em `AREA_TEMPORARIA` — mantém o código como está;
- **S3** como área de arquivo, trocando a leitura do disco local por um objeto
  versionado (muda `ctl_arquivo.caminho_local` e as duas rotas de download);
- **aceitar a perda**, reduzindo `RETENCAO_LOCAL_DIAS` e deixando claro na tela
  que o arquivo bruto só existe enquanto a origem o mantiver (5 dias).


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
| GET | `/api/qualidade` | motivos e rejeições explicadas: `execucao`, `motivo`, `arquivo`, `busca`, `pagina` |
| GET | `/api/qualidade/rejeicoes/:id` | linha rejeitada coluna a coluna, com a explicação |
| GET | `/api/runs` | datas processáveis: na origem, com cópia local e última execução |
| GET | `/api/incidentes` | incidentes e regras de notificação |
| GET | `/api/precos` | consulta do fato, com origem em cada linha |
| GET | `/api/config` | conexão, agendamento, destino e tabelas |
| POST | `/api/sessao` | login |
| GET | `/api/sessao` | quem está logado |
| DELETE | `/api/sessao` | logout |
| POST | `/api/sessao/senha` | troca da própria senha |
| GET | `/api/usuarios` | lista de usuários (administrador) |
| POST | `/api/usuarios` | cria usuário (administrador) |
| PATCH | `/api/usuarios/:id` | edita papel, nome ou situação (administrador) |
| POST | `/api/usuarios/:id/senha` | redefine senha (administrador) |
| GET | `/api/usuarios/tentativas` | auditoria de acesso (administrador) |
| POST | `/api/execucoes` | coleta manual: `{ runs: ["AAAA-MM-DD", …] }`, uma por vez |
| POST | `/api/execucoes/:id/cancelar` | para a coleta em andamento |
| POST | `/api/execucoes/:id/reprocessar` | reprocessa o run |
| POST | `/api/arquivos/:id/reprocessar` | reprocessa um arquivo |
| POST | `/api/inventario/:pasta/reprocessar` | reprocessa a pasta |
| POST | `/api/agendamento/pausar` \| `/retomar` | pausa e retoma |
| POST | `/api/incidentes/:codigo/resolver` | marca incidente como resolvido |
| GET | `/api/arquivos/:id/download` | arquivo bruto (cópia local) |
| GET | `/api/inventario/:pasta/download` | pasta inteira em `.tar` |
| GET | `/api/execucoes/:id/auditoria.csv` \| `.pdf` | relatório de auditoria |
| GET | `/api/qualidade/rejeicoes.csv`, `/api/precos.csv` | exportações |
| GET | `/api/admin/base` | o que um reset apagaria (administrador) |
| POST | `/api/admin/base/zerar` | zera a base: frase + senha (administrador) |

Só uma coleta roda por vez; uma segunda tentativa recebe `409` com a mensagem
que a tela mostra no toast.

## Publicar em servidor

Para instalar no Lightsail (Ubuntu) com PM2, Nginx e SSL do Let's Encrypt, veja
o passo a passo em [DEPLOY.md](DEPLOY.md).

## Verificação

```bash
npm run typecheck    # server + web
npm run build        # compila os dois
```
