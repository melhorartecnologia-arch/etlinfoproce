export type Tela =
  | 'hoje'
  | 'alertas'
  | 'exec'
  | 'linhagem'
  | 'arquivos'
  | 'qualidade'
  | 'precos'
  | 'config';

export interface ItemNav {
  tela: Tela;
  rotulo: string;
}

export interface GrupoNav {
  titulo: string;
  itens: ItemNav[];
}

export const GRUPOS_NAV: GrupoNav[] = [
  {
    titulo: 'operação',
    itens: [
      { tela: 'hoje', rotulo: 'Coleta do dia' },
      { tela: 'alertas', rotulo: 'Alertas e incidentes' },
    ],
  },
  {
    titulo: 'rastreabilidade',
    itens: [
      { tela: 'exec', rotulo: 'Execução passo a passo' },
      { tela: 'linhagem', rotulo: 'Linhagem do dado' },
      { tela: 'arquivos', rotulo: 'Inventário SFTP' },
      { tela: 'qualidade', rotulo: 'Qualidade e rejeições' },
    ],
  },
  {
    titulo: 'dados',
    itens: [{ tela: 'precos', rotulo: 'Consulta de preços' }],
  },
  {
    titulo: 'configuração',
    itens: [{ tela: 'config', rotulo: 'Conexão e destino' }],
  },
];
