/**
 * Configuração do PM2 para o Console de Ingestão.
 *
 * O servidor roda direto do TypeScript, sem etapa de compilação: o PM2 executa
 * o `tsx`, que transpila em memória. O front-end não entra aqui — ele é
 * compilado uma vez pelo Vite e servido como arquivo estático pelo Nginx.
 *
 * Os caminhos saem de __dirname, então funciona em qualquer diretório de
 * instalação sem edição.
 *
 * Uso:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 */
const path = require('node:path');

const raiz = __dirname;

module.exports = {
  apps: [
    {
      name: 'console-ingestao',

      // O tsx entra como carregador do próprio node (`--import tsx`), e não
      // como o comando `tsx`: este abre um processo-pai que, ao receber o
      // sinal de parada do PM2, dá ao filho só 30 ms para responder e depois o
      // mata com SIGKILL — e uma coleta ocupada não responde a tempo, ficando
      // órfã em vez de terminar como cancelada. Assim o sinal chega direto.
      script: 'src/main.ts',
      cwd: path.join(raiz, 'server'),
      interpreter: 'node',
      node_args: '--import tsx',

      /**
       * Uma instância só, de propósito.
       *
       * O agendador dispara a coleta diária, e o trilho que serializa as
       * execuções vive na memória do processo. Com duas instâncias, as duas
       * acordariam às 05:30 e tentariam a mesma coleta — o índice único em
       * ctl_execucao barraria a segunda, mas com erro em vez de silêncio.
       * Para escalar, seria preciso mover o agendamento para fora da API.
       */
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',
      },

      // Reinicia se algo vazar memória, mas não em laço: cinco tentativas
      // rápidas e o PM2 desiste, deixando o erro visível em vez de mascará-lo.
      max_memory_restart: '700M',
      max_restarts: 5,
      min_uptime: '30s',
      restart_delay: 4000,

      // A ingestão pode estar no meio de uma transação quando chega o SIGTERM;
      // 30s dão margem para o rollback fechar antes do SIGKILL.
      kill_timeout: 30000,
      listen_timeout: 10000,

      error_file: path.join(raiz, 'var/log/console-erro.log'),
      out_file: path.join(raiz, 'var/log/console-saida.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
