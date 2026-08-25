import type { Aviso } from '../hooks.js';

export function Toast({ aviso }: { aviso: Aviso | null }) {
  if (!aviso) return null;
  return (
    <div
      className={`toast${aviso.erro ? ' toast--erro' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="toast__ponto" />
      <span>{aviso.texto}</span>
    </div>
  );
}
