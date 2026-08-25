import { useCallback, useEffect, useRef, useState } from 'react';

export interface Recurso<T> {
  dados: T | null;
  carregando: boolean;
  erro: string | null;
  recarregar: () => void;
}

/**
 * Busca um recurso da API e reexecuta quando as dependências mudam.
 *
 * `intervaloMs` liga a atualização periódica — usada no painel enquanto uma
 * coleta está em andamento, para as etapas avançarem sozinhas na tela.
 */
export function useRecurso<T>(
  buscar: () => Promise<T>,
  deps: unknown[],
  intervaloMs?: number,
): Recurso<T> {
  const [dados, setDados] = useState<T | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [gatilho, setGatilho] = useState(0);

  // Mantém a função de busca fora das dependências do efeito: quem chama
  // costuma passar uma arrow nova a cada render.
  const buscarRef = useRef(buscar);
  buscarRef.current = buscar;

  useEffect(() => {
    let ativo = true;

    const carregar = async (primeira: boolean) => {
      if (primeira) setCarregando(true);
      try {
        const resultado = await buscarRef.current();
        if (!ativo) return;
        setDados(resultado);
        setErro(null);
      } catch (e) {
        if (!ativo) return;
        setErro(e instanceof Error ? e.message : String(e));
      } finally {
        if (ativo && primeira) setCarregando(false);
      }
    };

    void carregar(true);

    if (!intervaloMs) return () => { ativo = false; };

    const id = setInterval(() => void carregar(false), intervaloMs);
    return () => {
      ativo = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, gatilho, intervaloMs]);

  const recarregar = useCallback(() => setGatilho((g) => g + 1), []);

  return { dados, carregando, erro, recarregar };
}

export interface Aviso {
  texto: string;
  erro?: boolean;
}

/** Fila simples de toasts: a mensagem some sozinha depois de alguns segundos. */
export function useToast(): {
  toast: Aviso | null;
  avisar: (texto: string, erro?: boolean) => void;
} {
  const [toast, setToast] = useState<Aviso | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const avisar = useCallback((texto: string, erro = false) => {
    setToast({ texto, erro });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { toast, avisar };
}

/** Lê e grava uma preferência simples no localStorage. */
export function usePreferencia(
  chave: string,
  padrao: string,
): [string, (v: string) => void] {
  const [valor, setValor] = useState<string>(() => {
    try {
      return localStorage.getItem(chave) ?? padrao;
    } catch {
      return padrao;
    }
  });

  const definir = useCallback(
    (v: string) => {
      setValor(v);
      try {
        localStorage.setItem(chave, v);
      } catch {
        // navegador sem armazenamento — a preferência vale só nesta sessão
      }
    },
    [chave],
  );

  return [valor, definir];
}
