import type { ProgressoGravacao, SessaoBanco } from '@infoprice/shared';
import { Aviso, Par, Pilula } from './base.js';
import { duracaoBR, hora, numeroBR } from '../util.js';

/** "Lock:transactionid", "IO:DataFileRead"… ou o estado, quando não espera. */
function espera(s: SessaoBanco): string {
  if (s.esperaTipo) return `${s.esperaTipo}:${s.espera ?? '?'}`;
  return s.estado === 'active' ? 'executando (CPU)' : (s.estado ?? '—');
}

function desde(iso: string): string {
  return duracaoBR(Math.max(0, Date.now() - Date.parse(iso)));
}

/**
 * Onde a gravação no banco está: o arquivo em curso, a fase dentro da
 * transação dele e o que o backend do PostgreSQL está fazendo agora. É o que
 * separa "o banco está trabalhando" de "o banco está parado esperando um lock".
 */
export function GravacaoNoBanco({
  progresso: p,
  aoVivo,
  emCurso,
}: {
  progresso: ProgressoGravacao;
  aoVivo: boolean;
  emCurso: boolean;
}) {
  const b = p.banco;

  return (
    <div className="cartao cartao__corpo" style={{ gap: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          Gravação no banco
        </h2>
        {aoVivo ? (
          <Pilula tom="exec">ao vivo · {hora(new Date().toISOString())}</Pilula>
        ) : (
          <Pilula tom="neutro">
            {emCurso ? 'entre arquivos' : 'último ponto registrado'}
          </Pilula>
        )}
      </div>

      {p.bloqueadores.length > 0 && (
        <Aviso tag="Bloqueada" tom="erro">
          A transação do arquivo está parada há{' '}
          {duracaoBR(b?.consultaHaMs ?? 0)} esperando um lock
          {b ? ` (${espera(b)})` : ''}, preso por outra sessão do banco:{' '}
          {p.bloqueadores.map((x) => (
            <span key={x.pid} style={{ display: 'block', marginTop: 4 }}>
              <strong className="mono">pid {x.pid}</strong>
              {x.aplicacao ? ` · ${x.aplicacao}` : ''}
              {x.estado ? ` · ${x.estado}` : ''}
              {x.transacaoHaMs !== null
                ? ` · transação aberta há ${duracaoBR(x.transacaoHaMs)}`
                : ''}
              {x.consulta ? (
                <span className="mono suave" style={{ display: 'block' }}>
                  {x.consulta}
                </span>
              ) : null}
            </span>
          ))}
          <span style={{ display: 'block', marginTop: 6 }}>
            Se for uma coleta antiga ou uma sessão esquecida, libere no banco
            com{' '}
            <code className="mono">
              {p.bloqueadores
                .map((x) => `SELECT pg_terminate_backend(${x.pid});`)
                .join(' ')}
            </code>
          </span>
        </Aviso>
      )}

      {p.bloqueadores.length === 0 && b?.estado === 'idle in transaction' && (
        <Aviso tag="Aguardando a coleta" tom="atencao">
          O banco está com a transação aberta e ocioso há{' '}
          {duracaoBR(b.consultaHaMs ?? 0)}: quem está devendo é o processo da
          coleta (lendo e descompactando o arquivo), não o PostgreSQL.
        </Aviso>
      )}

      <Par chave="Arquivo" valor={`[${p.posicao}/${p.total}] ${p.arquivo}`} />
      <Par
        chave="Fase"
        valor={emCurso ? `${p.fase} · há ${desde(p.faseDesde)}` : p.fase}
      />
      {emCurso && (
        <Par chave="Tempo no arquivo" valor={desde(p.arquivoDesde)} />
      )}
      <Par chave="Linhas enviadas ao COPY" valor={numeroBR(p.linhasLidas)} />
      {b ? (
        <>
          <Par
            chave="Backend"
            valor={`pid ${b.pid} · ${b.estado ?? '—'} · ${espera(b)}`}
          />
          <Par
            chave="Consulta em curso há"
            valor={duracaoBR(b.consultaHaMs)}
          />
          {b.consulta && <pre className="sql">{b.consulta}</pre>}
        </>
      ) : (
        <Par chave="Backend" valor={p.pid ? `pid ${p.pid}` : '—'} />
      )}
      <Par chave="Atualizado às" valor={hora(p.atualizadoEm)} />
    </div>
  );
}
