import type { StatusResposta } from '@infoprice/shared';
import { dataHoraBR } from '../util.js';

export function Cabecalho({
  status,
  densidade,
  alternarDensidade,
  aoAlternarAgendamento,
  aoColetar,
  ocupado,
}: {
  status: StatusResposta | null;
  densidade: string;
  alternarDensidade: () => void;
  aoAlternarAgendamento: () => void;
  aoColetar: () => void;
  ocupado: boolean;
}) {
  const pausado = status?.agendamento.pausado ?? false;
  const proxima = status?.agendamento.proximaExecucao;

  // Sigla do fuso (BRT) para deixar claro em que horário a coleta está marcada.
  const sigla = proxima
    ? new Intl.DateTimeFormat('pt-BR', {
        timeZone: status?.agendamento.timezone,
        timeZoneName: 'short',
      })
        .formatToParts(new Date(proxima))
        .find((p) => p.type === 'timeZoneName')?.value
    : undefined;

  const textoAgenda = pausado
    ? 'Agendamento pausado'
    : proxima
      ? `Próxima coleta ${dataHoraBR(proxima)}${sigla ? ` ${sigla}` : ''}`
      : 'Agendamento sem próxima execução';

  return (
    <header className="cabecalho">
      <span className="cabecalho__caminho">
        {status?.sftp.diretorioBase ?? '—'}/
      </span>
      <div className="cabecalho__espaco" />

      <span
        className={`cabecalho__agenda${pausado ? ' cabecalho__agenda--pausado' : ''}`}
      >
        {textoAgenda}
      </span>

      <button
        className="botao"
        onClick={alternarDensidade}
        title="Alterna a altura das linhas das tabelas"
      >
        {densidade === 'compacta' ? 'Densidade compacta' : 'Densidade confortável'}
      </button>

      <button className="botao" onClick={aoAlternarAgendamento}>
        {pausado ? 'Retomar agendamento' : 'Pausar agendamento'}
      </button>

      <button
        className="botao botao--primario"
        onClick={aoColetar}
        disabled={ocupado}
      >
        {ocupado ? 'Coleta em andamento…' : 'Coleta manual'}
      </button>
    </header>
  );
}
