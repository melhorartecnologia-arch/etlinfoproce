# Publicar no Lightsail (Ubuntu 24.04) com PM2, Nginx e SSL

Passo a passo do zero até o console no ar em `https://console.suaempresa.com.br`.

**Arquitetura:** o Nginx atende as portas 80/443, serve o console (front-end)
como arquivos estáticos e repassa `/api` para o Node na porta 3001, que o PM2
mantém de pé. O Node nunca fica exposto à internet. O banco é um PostgreSQL —
na própria instância (opção A, a mais simples) ou no Amazon RDS (opção B).

**Sobre "sem build":** o *servidor* roda direto do TypeScript (`node --import
tsx`), sem compilação. O *console* é um bundle Vite e precisa ser compilado
uma vez a cada atualização.

---

## 0 · Antes de começar

Tenha em mãos:

- acesso à conta da AWS (console do Lightsail);
- a chave `.pem` do SFTP da InfoPrice, o host, o usuário e o diretório base
  (`/home/<usuário>/output/ISA-InfoPanel`);
- acesso ao repositório no GitHub (ele é privado — ver o passo 6);
- um domínio, se quiser HTTPS (recomendado). Sem domínio dá para testar pelo IP.

Pergunte à InfoPrice se o SFTP **restringe por IP**. Se sim, você vai passar a
eles o IP estático criado no passo 2.

## 1 · Criar a instância

No console do Lightsail → **Create instance**:

1. **Região:** São Paulo (`sa-east-1`) — perto do banco e da origem.
2. **Plataforma:** Linux/Unix → **Blueprint:** *OS Only* → **Ubuntu 24.04 LTS**.
3. **Plano:** veja o dimensionamento no passo 3 antes de escolher. Com o banco
   na própria instância, **4 GB de RAM é o mínimo e 8 GB é o recomendado**: o
   merge de um arquivo de ~385 mil linhas usa bastante memória.
4. **Nome:** `console-ingestao` → **Create instance**.

## 2 · IP estático e firewall

Na instância → aba **Networking**:

1. **Attach static IP** → crie e anexe. Sem isto o IP muda a cada parada, e o
   DNS aponta para o vazio.
2. **IPv4 Firewall:**
   - SSH (22): edite e marque *Restrict to IP address* com o IP de quem
     administra;
   - adicione **HTTP (80)** e **HTTPS (443)**.
3. **IPv6 Firewall:** repita as mesmas regras, ou desligue o IPv6 da instância.

## 3 · Dimensionar o disco

O que ocupa espaço:

| O quê | Quanto | Controle |
|---|---|---|
| Arquivos baixados (área temporária) | ~2,1 GB por dia de coleta | `RETENCAO_LOCAL_DIAS` + limpeza do passo 15 |
| Banco (opção A) | preços, rejeições e staging; cresce todo dia | ver a nota abaixo |
| Sistema, Node, dependências | ~6 GB | — |

Com 10 dias de retenção local (≈ 21 GB) e o banco na instância, comece com
**160 GB** (plano de 8 GB de RAM). Se o plano escolhido tiver disco menor,
anexe um **block storage** do Lightsail (aba *Storage*) e monte-o em
`/opt/console-ingestao/server/var` antes do passo 7.

> **Atenção ao crescimento do banco.** A tabela de staging
> (`stg_isa_infopanel_preco`) guarda cada linha lida e hoje não é limpa
> automaticamente — com o volume real, ~19 milhões de linhas por dia de
> coleta. Acompanhe o disco (`df -h`) nas primeiras semanas.

## 4 · Conectar por SSH

O jeito mais rápido é o botão **Connect using SSH** da instância (terminal no
navegador). Para usar o seu terminal (PowerShell no Windows também tem `ssh`):

1. Lightsail → **Account** → **SSH keys** → baixe a chave padrão da região
   (`LightsailDefaultKey-sa-east-1.pem`).
2. Conecte:

```bash
ssh -i LightsailDefaultKey-sa-east-1.pem ubuntu@<IP-ESTÁTICO>
```

No Linux/macOS, antes: `chmod 600 LightsailDefaultKey-sa-east-1.pem`.

## 5 · Preparar o Ubuntu

```bash
sudo apt update && sudo apt upgrade -y
sudo timedatectl set-timezone America/Sao_Paulo   # logs no horário de Brasília

# Node 22 pelo repositório oficial (o do Ubuntu é antigo demais)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git nginx
node -v    # deve mostrar v22.x

# Swap: na compilação e no npm ci a memória aperta
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Atualizações de segurança automáticas e proteção do SSH
sudo apt install -y unattended-upgrades fail2ban
sudo systemctl enable --now fail2ban
```

Se o `apt upgrade` pedir reinício (*System restart required*), rode
`sudo reboot` e conecte de novo.

## 6 · Baixar o código

O repositório é privado. Crie uma **deploy key** (só leitura) para a instância:

```bash
ssh-keygen -t ed25519 -C "console-ingestao@lightsail" -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub
```

No GitHub: repositório → **Settings** → **Deploy keys** → **Add deploy key** →
cole a chave pública (sem marcar *write access*). Depois:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github_deploy
EOF

sudo mkdir -p /opt/console-ingestao
sudo chown ubuntu:ubuntu /opt/console-ingestao
git clone git@github.com:melhorartecnologia-arch/etlinfoproce.git /opt/console-ingestao
cd /opt/console-ingestao
```

**Qual versão?** Use a branch onde está a versão que você testou. Se ela ainda
não foi juntada à `main`, faça o checkout dela:

```bash
git checkout claude/tender-keller-hij82n
```

Instale as dependências — **sem** `NODE_ENV=production` no terminal: o `tsx`,
que roda o servidor, é dependência de desenvolvimento e seria pulado.

```bash
npm ci
```

## 7 · Banco de dados

### Opção A — PostgreSQL na própria instância (recomendado para começar)

O Ubuntu 24.04 traz o PostgreSQL 16:

```bash
sudo apt install -y postgresql
sudo systemctl enable --now postgresql

# Troque a senha abaixo por uma forte e anote — ela vai para o .env
sudo -u postgres psql -c "CREATE ROLE infoprice LOGIN PASSWORD 'TROQUE-ESTA-SENHA';"
sudo -u postgres psql -c "CREATE DATABASE dw_precos OWNER infoprice ENCODING 'UTF8' TEMPLATE template0;"
```

O PostgreSQL só escuta em `localhost` por padrão — mantenha assim; a porta 5432
**não** deve ser aberta no firewall.

Ajuste de memória (para o plano de 8 GB; com 4 GB, use metade):

```bash
sudo tee /etc/postgresql/16/main/conf.d/console.conf <<'EOF'
shared_buffers = 2GB
effective_cache_size = 5GB
work_mem = 64MB
maintenance_work_mem = 512MB
max_wal_size = 4GB
EOF
sudo systemctl restart postgresql
```

No `.env` (passo 8): `PGHOST=127.0.0.1`, `PGSSLMODE=disable` (a conexão não
sai da máquina) e `PG_CREDENCIAL=env`.

### Opção B — Amazon RDS

O Lightsail fica numa **VPC própria**, separada da VPC onde o RDS costuma
estar; sem o peering a conexão simplesmente expira.

1. Lightsail → **Account** → **Advanced** → marque **VPC peering** na região do RDS.
2. EC2 → **Security Groups** → grupo do RDS → regra de entrada **PostgreSQL
   (5432)** com origem no **CIDR da VPC do Lightsail** (aparece na tela de
   peering, algo como `172.26.0.0/16`). Não libere `0.0.0.0/0`, e mantenha o
   RDS sem acesso público.
3. No RDS, crie o banco `dw_precos` e o usuário `infoprice`.
4. No `.env`: `PGHOST` = endpoint do **writer**, `PGSSLMODE=verify-full`,
   `CA_RDS=/opt/console-ingestao/server/certs/rds-global-bundle.pem`, e baixe o
   bundle de CAs:

```bash
npm run baixar-ca-rds --workspace @infoprice/server
```

Credenciais pelo Secrets Manager ou por IAM: veja "Credenciais" no README.

## 8 · Configurar

```bash
cp server/.env.example server/.env
nano server/.env
```

O que **precisa** mudar:

```env
NODE_ENV=production
PORT=3001

# ── Banco (opção A) ──
PGHOST=127.0.0.1
PGDATABASE=dw_precos
PGUSER=infoprice
PGPASSWORD=<a senha do passo 7>
PGSSLMODE=disable
INSTANCIA_ROTULO=postgres local · lightsail

# ── Sessão ──
# false só enquanto não houver HTTPS (passo 13); depois, true.
COOKIE_SEGURO=false

# ── Origem SFTP ──
SFTP_DRIVER=sftp
SFTP_HOST=<host do fornecedor>
SFTP_USUARIO=<usuário>
SFTP_CHAVE_PRIVADA=/opt/console-ingestao/server/secrets/chave-sftp.pem
SFTP_DIRETORIO_BASE=/home/<usuário>/output/ISA-InfoPanel

# ── Arquivos baixados ──
AREA_TEMPORARIA=/opt/console-ingestao/server/var/spool/infoprice
RETENCAO_LOCAL_DIAS=10

# ── Agendamento ──
# Deixe false até validar a primeira coleta manual (passo 14).
AGENDAMENTO_ATIVO=false
```

O layout da InfoPrice (44 colunas, `|`, nulo `\N`) é reconhecido sem
configuração; `MAPA_COLUNAS` e `CSV_COLUNAS` ficam vazios. `JANELA_COLETA_DIAS`
(365) e `CADASTRAR_LOJAS` (true) já vêm com os valores certos.

Para alertas por e-mail, preencha `SMTP_HOST`, `SMTP_USUARIO`, `SMTP_SENHA` e
`ALERTA_DESTINATARIOS`; sem SMTP, os alertas ficam só no painel.

A chave do SFTP, com permissão restrita:

```bash
mkdir -p server/secrets
nano server/secrets/chave-sftp.pem     # cole o conteúdo
chmod 600 server/secrets/chave-sftp.pem
```

Confira o banco antes de seguir:

```bash
npm run testar-conexao --workspace @infoprice/server
```

## 9 · Criar o schema e o primeiro administrador

```bash
npm run migrate --workspace @infoprice/server

npm run usuario --workspace @infoprice/server -- \
    criar --login seu.login --nome "Seu Nome" --papel administrador
```

A senha provisória aparece **uma única vez**. Anote — a troca é exigida no
primeiro acesso. (O `seed` de lojas é opcional: as lojas dos arquivos são
cadastradas sozinhas.)

## 10 · Compilar o console

```bash
npm run build --workspace @infoprice/web
```

Gera `web/dist/`, que o Nginx serve. Repita a cada atualização.

## 11 · Subir com o PM2

```bash
sudo npm install -g pm2
cd /opt/console-ingestao
mkdir -p var/log
pm2 start ecosystem.config.cjs
pm2 logs console-ingestao --lines 30     # confira a subida
```

Você deve ver `[main] console de ingestão em http://localhost:3001/api` com o
banco e o modo de TLS. Para sobreviver a reinícios e não encher o disco de log:

```bash
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu
# rode o comando `sudo env PATH=...` que ele imprimir

pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

> **Uma instância só.** O `ecosystem.config.cjs` fixa `instances: 1`: o
> agendador e o controle de "uma coleta por vez" vivem no processo. Ele também
> roda o servidor com `node --import tsx` e dá 30 s de `kill_timeout`, para que
> um `pm2 stop`/`restart` pare uma coleta em curso de forma limpa.

## 12 · Nginx

```bash
sudo cp deploy/nginx-console-ingestao.conf /etc/nginx/sites-available/console-ingestao
sudo nano /etc/nginx/sites-available/console-ingestao
#   server_name console.suaempresa.com.br;   ← seu domínio
#   (sem domínio ainda: server_name _;)
sudo ln -s /etc/nginx/sites-available/console-ingestao /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Se o `nginx -t` reclamar de `Address family not supported by protocol`, a
instância é só-IPv4: a linha `listen [::]:80` já vem comentada por isso.

Teste pelo navegador em `http://<IP-ESTÁTICO>` — com `COOKIE_SEGURO=false` o
login funciona por HTTP. Entre e troque a senha provisória.

## 13 · Domínio e HTTPS

1. No seu provedor de DNS, crie um registro **A** de
   `console.suaempresa.com.br` para o **IP estático**. Confira com
   `dig +short console.suaempresa.com.br` — o certbot só emite depois que resolver.
2. Certificado do Let's Encrypt:

```bash
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
sudo certbot --nginx -d console.suaempresa.com.br
sudo certbot renew --dry-run          # confere a renovação automática
```

Escolha **redirecionar HTTP para HTTPS**.

3. Agora o cookie de sessão precisa ser seguro:

```bash
sed -i 's/^COOKIE_SEGURO=.*/COOKIE_SEGURO=true/' server/.env
pm2 restart console-ingestao
```

> Sob HTTPS com `COOKIE_SEGURO=false` a sessão trafegaria sem proteção; sob
> HTTP com `true`, o login parece dar certo e todo o resto responde 401.

## 14 · Primeira coleta e agendamento

1. No console: **Coleta manual** → marque o dia (ou datas anteriores ainda na
   origem) → **Processar**. Acompanhe em **Coleta do dia**; cada arquivo
   gravado aparece no log como `[n/50] … gravado`.
2. Se a etapa *Validação de schema* recusar os arquivos, veja como o layout
   foi interpretado — sem argumento, o comando pega o arquivo mais recente já
   baixado:

```bash
npm run inspecionar-arquivo --workspace @infoprice/server
```

3. Confira **Qualidade e rejeições**: o percentual deve ser pequeno, e cada
   linha rejeitada explica o motivo.
4. Validado, ligue o agendamento (coleta às 05:30, varreduras às 12:00 e 18:00):

```bash
sed -i 's/^AGENDAMENTO_ATIVO=.*/AGENDAMENTO_ATIVO=true/' server/.env
pm2 restart console-ingestao
```

## 15 · Rotinas de manutenção

**Limpeza dos arquivos baixados.** A aplicação ainda não apaga sozinha os
arquivos mais antigos que `RETENCAO_LOCAL_DIAS`. Agende a limpeza diária às
03:00 (ajuste o `+10` para a retenção escolhida):

```bash
( crontab -l 2>/dev/null; echo '0 3 * * * find /opt/console-ingestao/server/var/spool/infoprice -mindepth 1 -mtime +10 -delete' ) | crontab -
```

Arquivo apagado continua no histórico; apenas o "Baixar bruto" passa a
responder "cópia local indisponível", e a data deixa de poder ser reprocessada
se também já saiu da origem.

**Backup do banco (opção A).** Um `pg_dump` diário às 04:00, guardando 7 dias:

```bash
sudo mkdir -p /var/backups/console && sudo chown postgres /var/backups/console
sudo -u postgres bash -c '( crontab -l 2>/dev/null; echo "0 4 * * * pg_dump -Fc dw_precos > /var/backups/console/dw_precos-\$(date +\%u).dump" ) | crontab -'
```

E, no Lightsail, ative **snapshots automáticos** da instância (aba
*Snapshots*). Com o RDS, os backups são do próprio RDS.

**Disco.** Confira de vez em quando:

```bash
df -h /                                     # espaço livre
du -sh /opt/console-ingestao/server/var/spool/infoprice
sudo -u postgres psql dw_precos -c "SELECT pg_size_pretty(pg_database_size('dw_precos'));"
```

## 16 · Conferir

```bash
curl -s https://console.suaempresa.com.br/api/saude
```

Deve trazer `"ok": true` e o banco conectado. No console, o cabeçalho mostra
"Próxima coleta …, 05:30 BRT".

---

## Atualizar depois

```bash
cd /opt/console-ingestao
git pull
npm ci
npm run build --workspace @infoprice/web        # se o console mudou
npm run migrate --workspace @infoprice/server   # se houver migração nova
pm2 restart console-ingestao
```

Se o `ecosystem.config.cjs` mudou, o `restart` não relê a configuração: use
`pm2 delete console-ingestao && pm2 start ecosystem.config.cjs && pm2 save`.
As migrações são protegidas por advisory lock e também rodam na subida.

Atualizar no meio de uma coleta é seguro: o `restart` para a coleta num ponto
seguro (arquivos já gravados ficam) e a varredura retoma o que faltou.

## Quando algo não sobe

| Sintoma | Onde olhar |
|---|---|
| `pm2 list` mostra `errored` | `pm2 logs console-ingestao --err --lines 50` |
| `Cannot find package 'tsx'` | o `npm ci` rodou com `NODE_ENV=production`; rode `npm ci` de novo num terminal limpo |
| `ECONNREFUSED 127.0.0.1:5432` | `sudo systemctl status postgresql` |
| `password authentication failed` | `PGUSER`/`PGPASSWORD` no `.env` × o passo 7 |
| Timeout ao conectar no RDS | VPC peering e security group (opção B) |
| Layout recusado na validação de schema | `npm run inspecionar-arquivo --workspace @infoprice/server` |
| Coleta falha na conexão SFTP | host/usuário/chave no `.env`; a InfoPrice libera o seu IP estático? Teste com `sftp -i server/secrets/chave-sftp.pem <usuário>@<host>` |
| `502 Bad Gateway` | o Node caiu: `pm2 list`, depois os logs |
| Login OK mas tudo 401 | `COOKIE_SEGURO=true` sem HTTPS — veja o passo 13 |
| `EADDRINUSE` na 3001 | `pm2 delete all` e suba de novo |
| Certbot não emite | DNS ainda não propagou; confira com `dig` |
| Disco cheio | limpeza do passo 15; tamanho do banco; aumente o disco ou anexe block storage |
