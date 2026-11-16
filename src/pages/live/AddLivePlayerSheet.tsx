// Position-filtered player picker for the LIVE squad.
//
// This is the live counterpart of components/AddPlayerSheet.tsx, which is bound to the
// demo store. The demo behaviour it reproduces:
//
//   tapping "+" on a pitch slot opens a sheet listing only the AVAILABLE players in
//   that position, and picking one buys them into the squad straight away.
//
// Previously the live pitch's "+" simply navigated to /market, so the user lost the
// position they had tapped and had to find the player again among the whole market.
//
// The candidate list is derived from the real market rows (live.players), so it obeys
// the server's own rules: inactive players are excluded, players already in the squad
// are excluded, and the squad/position/budget limits are re-checked server-side by
// ff_squad_buy() - a refusal here is always the server's message, never a local guess.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Avatar } from '../../components/UI';
import { formatCompactMoney } from '../../utils/format';
import type { ApiPlayer } from '../../types/api';
import type { Position } from '../../types';

interface Props {
  position: Position;
  /** Every market row in the league, including ones already owned. */
  market: ApiPlayer[];
  /** league_player_ids already in this squad. */
  ownedIds: string[];
  remaining: number;
  marketOpen: boolean;
  busy: boolean;
  onPick: (player: ApiPlayer) => Promise<void>;
  close: () => void;
}

export function AddLivePlayerSheet({
  position, market, ownedIds, remaining, marketOpen, busy, onPick, close,
}: Props) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  // Same position, available, not already yours. Note a real-life player may be owned by
  // several managers in different squads (an independent market per league), so
  // "owned" means owned BY THIS SQUAD, not owned at all.
  const candidates = market.filter((p) => p.position === position && p.active && !ownedIds.includes(p.id));

  return (
    <dialog
      ref={dialog}
      className="player-sheet add-player-sheet"
      aria-labelledby="live-add-player-title"
      onClose={close}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div className="sheet-handle" aria-hidden="true" />
      <button type="button" className="sheet-close" aria-label={t('Close')} onClick={close}>
        <X size={20} />
      </button>
      <div className="eyebrow">{t('THE MARKET')}</div>
      <h2 id="live-add-player-title">{t('Add player')} · {position}</h2>
      <p className="sheet-note">
        {t('Choose an available player in this position.')} · {t('Budget remaining')}:{' '}
        <strong>{formatCompactMoney(remaining)}</strong>
      </p>

      {!marketOpen && <p className="error" role="status">{t('The market is closed.')}</p>}

      {candidates.length === 0 ? (
        <p className="notice">{t('No available players in this position.')}</p>
      ) : (
        <div className="replacement-list add-player-list">
          {candidates.map((player) => (
            <button
              type="button"
              key={player.id}
              className="replacement-row"
              disabled={busy || !marketOpen}
              onClick={async () => {
                setError('');
                try {
                  await onPick(player);
                  close();
                } catch (caught) {
                  // The server is the authority on squad size, budget and position
                  // limits; show its message rather than a local approximation.
                  setError(caught instanceof Error ? caught.message : t('That did not work'));
                }
              }}
            >
              <Avatar name={player.name} image={player.image_url ?? undefined} size="sm" />
              <span>
                <strong>{player.name}</strong>
                <small>{player.position} · {player.rating} {t('OVR')}</small>
              </span>
              <b>{formatCompactMoney(player.price)}</b>
            </button>
          ))}
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
    </dialog>
  );
}
