# Publicar no Lightsail (Ubuntu) com PM2, Nginx e SSL

Passo a passo do zero até o console no ar em `https://console.suaempresa.com.br`,
com o banco no RDS.

**Arquitetura:** o Nginx atende as portas 80/443, serve o front-end como arquivo
estático e repassa `/api` para o Node na porta 3001, que o PM2 mantém de pé. O
Node nunca é exposto à internet.

**Sobre "sem build":** o *servidor* roda direto do TypeScript, sem compilação —
o PM2 executa o `tsx`. O *front-end* não tem essa opção: ele é um bundle Vite e
precisa ser compilado uma vez para virar arquivo estático. Não existe "rodar
TypeScript direto" no navegador.

---

## 1 · Criar a instância

No console do Lightsail:

1. **Create instance** → Linux/Unix → **Ubuntu 24.04 LTS**
2. Plano: **2 GB RAM / 60 GB SSD** é o mínimo confortável. Ver o dimensionamento
   de disco no passo 2 antes de fechar.
3. Dê um nome (`console-ingestao`) e crie.

Depois de criada, em **Networking**:

4. **Attach static IP** — sem isto o IP muda a cada parada da instância, e o
   registro de DNS aponta para o vazio.
5. **IPv4 Firewall**: mantenha SSH (22) restrito ao seu IP, e adicione
   **HTTP (80)** e **HTTPS (443)** abertos.

## 2 · Dimensionar o disco

A área de spool guarda as cópias locais dos arquivos baixados, e é dela que saem
o "Baixar bruto" e o download da pasta em `.tar`. Com o volume típico da
InfoPrice:

```
1,84 GB/dia  ×  30 dias de retenção  ≈  55 GB
```

Some ~5 GB de sistema e dependências. Um disco de 60 GB fica no limite; **80 GB
dá folga**. As saídas, se quiser um plano menor:

- reduzir `RETENCAO_LOCAL_DIAS` (o arquivo bruto só é garantido enquanto a
  origem o mantém, que são 5 dias);
- anexar um **block storage** do Lightsail e montar em `AREA_TEMPORARIA`.

Diferente de contêiner, o disco do Lightsail é persistente: a área de spool
sobrevive a reinícios e implantações.

## 3 · Liberar o acesso da instância ao RDS

Esta é a pegadinha do Lightsail: ele fica numa **VPC própria**, separada da VPC
padrão onde o RDS costuma estar. Sem isto, a conexão simplesmente expira.

1. Lightsail → canto superior direito → **Account** → **Advanced**
2. Marque **VPC peering** na região do RDS
3. No console do **EC2 → Security Groups**, no grupo do RDS, adicione uma regra
   de entrada: **PostgreSQL (5432)** com origem no **CIDR da VPC do Lightsail**
   (aparece na tela de peering, algo como `172.26.0.0/16`)

Não libere `0.0.0.0/0`. E mantenha a instância RDS sem acesso público.

## 4 · Preparar o servidor

Conecte por SSH (o Lightsail tem terminal no navegador, ou use sua chave).

```bash
sudo apt update && sudo apt upgrade -y
sudo timedatectl set-timezone America/Sao_Paulo   # deixa os logs legíveis
```

**Node 22** pelo repositório oficial — o do Ubuntu é velho demais:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git nginx
node -v    # deve mostrar v22.x
```

**Swap** — na instância de 1–2 GB, o `npm ci` pode estourar a memória:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 5 · Instalar a aplicação

```bash
sudo mkdir -p /opt/console-ingestao
sudo chown ubuntu:ubuntu /opt/console-ingestao
git clone https://github.com/melhorartecnologia-arch/etlinfoproce.git /opt/console-ingestao
cd /opt/console-ingestao
npm ci
```

`npm ci` instala as dependências dos três workspaces, incluindo o `tsx` que o
PM2 vai usar.

## 6 · Configurar

```bash
cp server/.env.example server/.env
nano server/.env
```

O que **precisa** mudar:

```env
NODE_ENV=production
PORT=3001

# ── Banco no RDS ──
PGHOST=infoprice.abc123.sa-east-1.rds.amazonaws.com   # endpoint do WRITER
PGDATABASE=dw_precos
PGUSER=infoprice
PGPASSWORD=<a senha>
PGSSLMODE=verify-full
CA_RDS=/opt/console-ingestao/server/certs/rds-global-bundle.pem

# ── Sessão ──
# Obrigatório atrás de HTTPS. Ver a nota no passo 11.
COOKIE_SEGURO=true

# ── Origem SFTP ──
SFTP_DRIVER=sftp
SFTP_HOST=<host do fornecedor>
SFTP_USUARIO=<usuário>
SFTP_CHAVE_PRIVADA=/opt/console-ingestao/server/secrets/chave-sftp.pem
SFTP_DIRETORIO_BASE=/home/<usuário>/output/ISA-InfoPanel

# ── Onde ficam os arquivos baixados ──
AREA_TEMPORARIA=/opt/console-ingestao/server/var/spool/infoprice
```

A chave `.pem` do SFTP, com permissão restrita:

```bash
mkdir -p server/secrets
nano server/secrets/chave-sftp.pem     # cole o conteúdo
chmod 600 server/secrets/chave-sftp.pem
```

O bundle de CAs do RDS:

```bash
npm run baixar-ca-rds --workspace @infoprice/server
```

**Confira a conexão antes de seguir:**

```bash
npm run testar-conexao --workspace @infoprice/server
```

Ele responde se a conexão está cifrada de fato e falha se o tráfego estiver em
texto claro. Não avance com este passo falhando.

## 7 · Criar o schema e o primeiro usuário

```bash
npm run migrate --workspace @infoprice/server
npm run seed --workspace @infoprice/server     # popula dim_loja

npm run usuario --workspace @infoprice/server -- \
    criar --login seu.login --nome "Seu Nome" --papel administrador
```

A senha provisória é exibida **uma única vez**. Anote — a troca é exigida no
primeiro acesso.

## 8 · Compilar o front-end

Único build do processo:

```bash
npm run build --workspace @infoprice/web
```

Gera `web/dist/`, que o Nginx vai servir. Repita este comando a cada atualização
do front.

## 9 · Subir com o PM2

```bash
sudo npm install -g pm2
cd /opt/console-ingestao
pm2 start ecosystem.config.cjs
pm2 logs console-ingestao --lines 30     # confira a subida
```

Você deve ver a linha de inicialização com o banco e o modo de TLS. Se aparecer
`EADDRINUSE`, há outro processo na 3001 — `pm2 delete all` e suba de novo.

Sobreviver ao reboot:

```bash
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu
# rode o comando `sudo env PATH=...` que ele imprimir
```

Rotação de log, para o disco não encher:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

> **Uma instância só.** O `ecosystem.config.cjs` fixa `instances: 1` de
> propósito: o agendador dispara a coleta diária, e o trilho que serializa as
> execuções vive na memória do processo. Com duas instâncias, as duas acordariam
> às 05:30 para a mesma coleta.

## 10 · Nginx

```bash
sudo cp deploy/nginx-console-ingestao.conf \
        /etc/nginx/sites-available/console-ingestao
sudo nano /etc/nginx/sites-available/console-ingestao   # troque o server_name
sudo ln -s /etc/nginx/sites-available/console-ingestao \
           /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Se o `nginx -t` reclamar de `Address family not supported by protocol`, a
instância é só-IPv4: a linha `listen [::]:80` já vem comentada no arquivo por
isso.

Aponte o DNS antes do próximo passo: um registro **A** de
`console.suaempresa.com.br` para o **IP estático** do Lightsail. Confira com
`dig +short console.suaempresa.com.br` — o certbot só emite depois que resolver.

## 11 · SSL com Let's Encrypt

```bash
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
sudo certbot --nginx -d console.suaempresa.com.br
```

Escolha **redirecionar HTTP para HTTPS** quando ele perguntar. O certbot escreve
o bloco 443 e o redirecionamento sozinho — não edite isso à mão.

Renovação automática (o snap já instala o timer):

```bash
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

> **Atenção — o console não funciona sobre HTTP puro em produção.**
> Com `NODE_ENV=production`, o cookie de sessão sai marcado `Secure`, e nenhum
> navegador o devolve por HTTP. Antes do certbot, o login parece dar certo e
> todo o resto responde 401. Isso é proposital: a sessão não deve trafegar em
> claro. Se precisar testar antes do TLS, use `COOKIE_SEGURO=false` — e volte
> para `true` assim que o HTTPS estiver de pé.

## 12 · Conferir

```bash
curl -s https://console.suaempresa.com.br/api/saude | jq
```

Deve trazer `"ok": true` e `"conexaoCifrada": true`. Abra o domínio no
navegador, entre com o usuário criado no passo 7 e troque a senha provisória.

Checagem final: **o agendamento**. O console mostra "Próxima coleta 26/08, 05:30
BRT" no cabeçalho. Se quiser validar a coleta sem esperar, use o botão **Coleta
manual**.

---

## Atualizar depois

```bash
cd /opt/console-ingestao
git pull
npm ci
npm run build --workspace @infoprice/web        # só se o front mudou
npm run migrate --workspace @infoprice/server   # só se houver migração nova
pm2 restart console-ingestao
```

As migrações são protegidas por advisory lock, então rodá-las é seguro mesmo se
algo já as tiver aplicado.

## Endurecer (recomendado)

```bash
# Atualizações de segurança automáticas
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades

# Bloqueia força bruta no SSH
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

No firewall do Lightsail, restrinja a porta 22 ao seu IP. O console já tem trava
própria de força bruta no login (5 falhas em 15 min).

## Quando algo não sobe

| Sintoma | Onde olhar |
|---|---|
| `pm2 list` mostra `errored` | `pm2 logs console-ingestao --err --lines 50` |
| Timeout ao conectar no RDS | VPC peering (passo 3) e security group |
| `502 Bad Gateway` | o Node caiu: `pm2 list`, depois os logs |
| Login OK mas tudo 401 | `COOKIE_SEGURO=true` sem HTTPS — veja o passo 11 |
| `EADDRINUSE` na 3001 | `pm2 delete all` e suba de novo |
| Certbot não emite | DNS ainda não propagou; confira com `dig` |
| Disco cheio | spool acima da retenção: veja o passo 2 |
