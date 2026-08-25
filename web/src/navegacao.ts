export type Tela =
  | 'hoje'
  | 'alertas'
  | 'exec'
  | 'linhagem'
  | 'arquivos'
  | 'qualidade'
  | 'precos'
  | 'config'
  | 'usuarios';

export interface ItemNav {
  tela: Tela;
  rotulo: string;
}

export interface GrupoNav {
  titulo: string;
  itens: ItemNav[];
}

/**
 * Os grupos visíveis dependem do papel: só administrador enxerga a
 * administração. Esconder é conveniência de interface — quem garante é o
 * servidor, que recusa a rota.
 */
export function gruposPara(podeAdministrar: boolean): GrupoNav[] {
  return podeAdministrar
    ? [...GRUPOS_NAV, GRUPO_ADMIN]
    : GRUPOS_NAV;
}

export const GRUPO_ADMIN: GrupoNav = {
  titulo: 'administração',
  itens: [{ tela: 'usuarios', rotulo: 'Usuários' }],
};

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
