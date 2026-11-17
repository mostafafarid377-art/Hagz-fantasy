import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowRightLeft, X } from 'lucide-react';
import { Avatar } from '../../components/UI';
import { formatCompactMoney } from '../../utils/format';
import type { Player } from '../../types';

type Props = {
  player: Player; players: Player[]; ownedIds: string[]; starter: boolean;
  captainId: string | null; viceId: string | null; editing: boolean; viewOnly?: boolean;
  remaining: number; marketOpen: boolean; canSwap: boolean; busy: boolean;
  points?: number; error: string; close: () => void; startSwap: () => void;
  setCaptain: (type: 'captain' | 'vice') => void; transfer: (id: string) => void; remove: () => void;
};
export function LivePlayerSheet({ player, players, ownedIds, starter, captainId, viceId, editing, viewOnly = false, remaining, marketOpen, canSwap, busy, points, error, close, startSwap, setCaptain, transfer, remove }: Props) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [replacing, setReplacing] = useState(false);
  const [incoming, setIncoming] = useState('');
  useEffect(() => {
    const element = dialog.current;
    if (!element || element.open) return;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
  }, []);
  const candidates = players.filter(p => p.active && p.position === player.position && !ownedIds.includes(p.id));
  const choice = candidates.find(p => p.id === incoming);
  return <dialog ref={dialog} className="player-sheet" aria-labelledby="live-player-sheet-title" onClose={close} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="sheet-handle" aria-hidden="true"/><button type="button" className="sheet-close" aria-label={t('Close')} onClick={close}><X size={20}/></button>
    <div className="sheet-hero"><Avatar name={player.name} image={player.image} color={player.color} size="lg"/><div><span className="position-pill">{player.position}</span><h2 id="live-player-sheet-title">{player.name}</h2><p>{t(player.active ? 'Active' : 'Inactive')} · {t(starter ? 'Starting XI' : 'Bench')}</p></div></div>
    <div className="sheet-stats"><div><small>{t('Price')}</small><strong>{formatCompactMoney(player.price)}</strong></div><div><small>{t('Rating')}</small><strong>{player.rating}</strong></div><div><small>{t('Last game points')}</small><strong>{points ?? '—'}</strong></div></div>
    {editing && <div className="sheet-captains"><button type="button" className={`button button-outline ${captainId === player.id ? 'is-selected' : ''}`} aria-pressed={captainId === player.id} disabled={busy || !starter} onClick={() => setCaptain('captain')}>{t('Captain')}</button><button type="button" className={`button button-outline ${viceId === player.id ? 'is-selected' : ''}`} aria-pressed={viceId === player.id} disabled={busy || !starter} onClick={() => setCaptain('vice')}>{t('Vice captain')}</button></div>}
    {!editing && !viewOnly && <div className="sheet-captains"><button type="button" className={`button button-outline ${captainId === player.id ? 'is-selected' : ''}`} aria-pressed={captainId === player.id} disabled={busy || !starter} onClick={() => setCaptain('captain')}>{t('Captain')}</button><button type="button" className={`button button-outline ${viceId === player.id ? 'is-selected' : ''}`} aria-pressed={viceId === player.id} disabled={busy || !starter} onClick={() => setCaptain('vice')}>{t('Vice captain')}</button></div>}
    {editing && replacing && <section className="replacement-section"><h3>{t('Select replacement')}</h3><p>{t('Choose an available player in the same position.')}</p>{!candidates.length ? <p className="notice">{t('No available players in this position.')}</p> : <div className="replacement-list">{candidates.map(p => <button type="button" key={p.id} className={`replacement-row ${incoming === p.id ? 'selected' : ''}`} aria-pressed={incoming === p.id} onClick={() => setIncoming(p.id)}><Avatar name={p.name} image={p.image} color={p.color} size="sm"/><span><strong>{p.name}{candidates.some((other) => other.id !== p.id && other.name.trim().toLocaleLowerCase() === p.name.trim().toLocaleLowerCase()) && <small className="identity-hint">#{p.id.slice(0, 8)}</small>}</strong><small>{p.position} · {p.rating} {t('OVR')}</small></span><b>{formatCompactMoney(p.price)}</b></button>)}</div>}{choice && <div className="replacement-summary">{t('After transfer')}: {formatCompactMoney(remaining + player.price - choice.price)} {t('remaining')}</div>}{!marketOpen && <p className="notice">{t('The market is closed.')}</p>}{choice && choice.price > remaining + player.price && <p className="error">{t('Not enough budget.')}</p>}<button type="button" className="button sheet-primary" disabled={!choice || busy || !marketOpen || choice.price > remaining + player.price} onClick={() => transfer(incoming)}>{t('Confirm replacement')}</button></section>}
    {error && <p className="error" role="alert">{error}</p>}
    {editing ? <><Link className="button button-outline full-profile-action" to={`/players/${player.id}`} onClick={close}>{t('Full profile')}</Link><div className="sheet-action-row"><button type="button" className="button" disabled={replacing || busy || !marketOpen} onClick={() => setReplacing(true)}>{t('Select replacement')}</button><button type="button" className="button button-danger" disabled={busy || !marketOpen} onClick={remove}>{t('Remove')}</button><button type="button" className="button button-outline" disabled={!canSwap || busy} onClick={startSwap}><ArrowRightLeft size={16}/>{t('Make substitution')}</button></div></> : viewOnly
      ? <Link className="button button-outline full-profile-action" to={`/players/${player.id}`} onClick={close}>{t('Full profile')}</Link>
      : <div className="sheet-actions"><Link className="button button-outline" to={`/players/${player.id}`} onClick={close}>{t('Full profile')}</Link><button type="button" className="button" disabled={!canSwap || busy} onClick={startSwap}><ArrowRightLeft size={16}/>{t('Make substitution')}</button></div>}
    {!editing && !viewOnly && !canSwap && <p className="sheet-note">{t('No eligible swap preserves or improves your formation.')}</p>}
  </dialog>;
}
