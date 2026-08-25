/** Papéis, em ordem crescente de poder. */
export const PAPEIS = ['leitor', 'operador', 'administrador'] as const;

export type Papel = (typeof PAPEIS)[number];

export const ROTULO_PAPEL: Record<Papel, string> = {
  leitor: 'Leitor',
  operador: 'Operador',
  administrador: 'Administrador',
};

export const DESCRICAO_PAPEL: Record<Papel, string> = {
  leitor: 'Vê todas as telas e exporta relatórios. Não dispara nada.',
  operador:
    'Além de ver: coleta manual, reprocessamento, pausar o agendamento, resolver incidentes e baixar arquivos.',
  administrador: 'Tudo que o operador faz, mais a gestão de usuários.',
};

/** Um papel atende à exigência de outro? administrador ⊇ operador ⊇ leitor. */
export function papelAtende(papel: Papel, minimo: Papel): boolean {
  return PAPEIS.indexOf(papel) >= PAPEIS.indexOf(minimo);
}

/** O usuário logado, do ponto de vista da tela. */
export interface UsuarioSessao {
  id: number;
  login: string;
  nome: string;
  email: string | null;
  papel: Papel;
  /** Senha definida por um administrador: precisa ser trocada no primeiro acesso. */
  trocarSenha: boolean;
}

/** Um usuário na tela de gestão. */
export interface Usuario {
  id: number;
  login: string;
  nome: string;
  email: string | null;
  papel: Papel;
  ativo: boolean;
  trocarSenha: boolean;
  ultimoAcesso: string | null;
  senhaAlteradaEm: string;
  criadoEm: string;
  criadoPor: string | null;
  sessoesAtivas: number;
}

export interface LoginPedido {
  login: string;
  senha: string;
}

export interface LoginResposta {
  usuario: UsuarioSessao;
  expiraEm: string;
}

export interface SessaoResposta {
  usuario: UsuarioSessao | null;
}

export interface TrocarSenhaPedido {
  senhaAtual: string;
  senhaNova: string;
}

export interface CriarUsuarioPedido {
  login: string;
  nome: string;
  email?: string;
  papel: Papel;
  /** Ausente: o servidor sorteia uma senha e devolve na resposta. */
  senha?: string;
}

export interface CriarUsuarioResposta {
  usuario: Usuario;
  /** Só vem preenchido quando o servidor sorteou a senha. */
  senhaProvisoria?: string;
}

export interface AtualizarUsuarioPedido {
  nome?: string;
  email?: string | null;
  papel?: Papel;
  ativo?: boolean;
}

export interface TentativaLogin {
  id: number;
  login: string;
  ip: string | null;
  sucesso: boolean;
  motivo: string | null;
  ocorridaEm: string;
}
