// Live player market, player management (leader), and suggestions.
//
// These screens are where the role rules become visible: a manager sees the
// market and can submit suggestions; a leader sees the management controls and
// the approval queue. Hiding a control is a courtesy, NOT a control - the same
// action from a manager is refused by the database (see phase3-api.test.mjs).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, Check, Plus, Search, SlidersHorizontal, Upload, X } from 'lucide-react';
import { Avatar, Badge, Empty, PageTitle, SectionHead } from '../../components/UI';
import { BackLink } from '../../components/Navigation';
import { formatCompactMoney } from '../../utils/format';
import { useLive } from '../../hooks/useLive';
import { ErrorNote, Loading, PartialDataNote, Success } from './League';
import type { Position } from '../../types/api';

const positions: readonly Position[] = ['GK', 'DEF', 'MID', 'FWD'];
import type { ApiPlayer, ApiSuggestion } from '../../types/api';
import { inspectImage, StorageError, uploadBlocked } from '../../services/storage';
import { lastGamePointsForPlayer, seasonPointsForPlayer } from '../../services/points';

const POSITION_ORDER = ['GK', 'DEF', 'MID', 'FWD'] as const;

// ---------------------------------------------------------------------------
// Market browse
// ---------------------------------------------------------------------------

export function LiveMarket() {
  const { t } = useTranslation();
  const live = useLive();
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return live.players
      .filter((p) => p.active)
      .filter((p) => !position || p.position === position)
      .filter((p) => !query || p.name.toLowerCase().includes(query))
      .sort((a, b) => POSITION_ORDER.indexOf(a.position) - POSITION_ORDER.indexOf(b.position)
        || b.rating - a.rating);
  }, [live.players, search, position]);

  const owned = new Set((live.squad?.players ?? []).map((p) => p.league_player_id));

  async function add(player: ApiPlayer) {
    setBusy(player.id); setNotice('');
    try {
      await live.buy(player.id);
      setNotice(t('Player added to your squad.'));
    } catch { /* live.error shows the reason */ } finally { setBusy(''); }
  }

  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  return (
    <>
      <PageTitle eyebrow="THE MARKET" title="Player Market"
        description={`${live.league.name} · ${live.league.market_open ? t('Open') : t('Closed')}`}>
        <Link className="button" to="/suggest">{t('Suggest Player')}</Link>
      </PageTitle>

      {live.error && <ErrorNote message={live.error} onRetry={() => void live.reload()} />}
      <PartialDataNote failures={live.partialFailures} onRetry={() => void live.reload()} />
      <Success message={notice} />
      {!live.league.market_open && (
        <p className="notice">{t('The market is closed. You cannot add players until your leader opens it.')}</p>
      )}

      {/* Same filter bar as the demo market: .filter-bar with a search box and a
          position select. The live version used its own .market-filters markup
          without a search label, so the two screens looked different and the input
          was unlabelled for screen readers. */}
      <div className="filter-bar">
        <div className="search-box">
          <Search size={18} />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={t('Search players')} aria-label={t('Search players')} />
        </div>
        <div className="filters">
          <SlidersHorizontal size={17} />
          <select value={position} onChange={(e) => setPosition(e.target.value)} aria-label={t('Position')}>
            <option value="">{t('All positions')}</option>
            {POSITION_ORDER.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Empty
          title={live.players.length ? 'No match found' : 'No players in this market yet.'}
          description={live.players.length ? undefined : t('Your leader publishes the market players. You can still suggest one.')}
          to={live.players.length ? undefined : '/suggest'} action={live.players.length ? undefined : 'Suggest Player'}
        />
      ) : (
        <div className="player-grid">
          {filtered.map((player) => {
            const mine = owned.has(player.id);
            return (
              <div className="player-card" key={player.id}>
                <div className="player-card-top">
                  <div>
                    <span className="position-pill">{player.position}</span>
                    <div className="player-rating">{player.rating}<small>{t('OVR')}</small></div>
                  </div>
                  <Avatar name={player.name} image={player.image_url ?? undefined} size="lg" />
                </div>
                <Link to={`/players/${player.id}`} className="player-name">{player.name}</Link>
                {live.players.some((other) => other.id !== player.id && other.name.trim().toLocaleLowerCase() === player.name.trim().toLocaleLowerCase()) &&
                  <small className="identity-hint" title={t('Distinct player record')}>#{player.id.slice(0, 8)}</small>}
                <div className="player-meta">
                  <span>{player.position} <span className="dot">·</span> {player.owned_by ?? 0} {t('managers')}</span>
                </div>
                <div className="player-card-bottom">
                  <div><small>{t('PRICE')}</small><strong>{formatCompactMoney(player.price)}</strong></div>
                  <button
                    className={mine ? 'button button-muted' : 'button button-small'}
                    disabled={mine || !live.league!.market_open || busy === player.id
                      || (live.squad?.players?.length ?? 0) >= 15}
                    onClick={() => void add(player)}
                  >
                    {mine ? t('In squad') : busy === player.id ? t('Adding…') : t('Add to squad')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export function LivePlayerProfile() {
  const { t } = useTranslation();
  const live = useLive();
  const { id } = useParams<{ id: string }>();
  const player = live.players.find((p) => p.id === id || p.player_id === id);
  if (live.loading) return <Loading />;
  if (!player) return <Empty title="No match found" description="This player is not in your league market." to="/market" action="Player Market" />;

  return (
    <>
      <BackLink fallback="/market" />
      <PageTitle eyebrow="PLAYER PROFILE" title={player.name} description={`${player.position} · ${player.rating} ${t('OVR')}`} />
      {/* Same hero as the demo profile: badges, then a stats row. The live version
          showed a price line only, so the two screens looked like different products
          even though every figure here is real. */}
      <div className="panel profile-hero">
        <Avatar name={player.name} image={player.image_url ?? undefined} size="lg" />
        <div>
          <Badge kind="lime">{player.position}</Badge>{' '}
          <Badge kind={player.active ? 'approved' : 'neutral'}>{t(player.active ? 'Active' : 'Inactive')}</Badge>
          <h1>{player.name}</h1>
          <p>{live.league?.name}</p>
          <div className="profile-stats">
            <span><strong>{player.rating}</strong> {t('OVR')}</span>
            <span><strong>{formatCompactMoney(player.price)}</strong> {t('Price')}</span>
            <span><strong>{lastGamePointsForPlayer(live.points, player.id) ?? '—'}</strong> {t('Last game points')}</span>
            <span><strong>{seasonPointsForPlayer(live.points, player.id) ?? '—'}</strong> {t('Total points')}</span>
            <span><strong>{player.owned_by ?? 0}</strong> {t('managers')}</span>
          </div>
        </div>
        <Link className="button button-outline" to="/market">{t('Player Market')}</Link>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Leader: player management
// ---------------------------------------------------------------------------

export function LiveManagement() {
  const { t } = useTranslation();
  const live = useLive();
  const [editing, setEditing] = useState<ApiPlayer | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');

  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;
  const canManage = live.isLeader;

  async function removeFromMarket(player: ApiPlayer) {
    if (!window.confirm(t('Remove this player from the active market? Existing squads and history will be kept.'))) return;
    try {
      await live.savePlayer({ name: player.name, position: player.position, price: player.price,
        rating: player.rating, active: false, imageUrl: player.image_url, playerId: player.player_id });
      setNotice(t('Player removed from the active market.'));
    } catch { /* live.error shows the reason */ }
  }

  return (
    <>
      <PageTitle eyebrow="LEADER TOOLS" title="Player Management"
        description={t('Create and manage real players in your league.')}>
        {canManage && <button className="button" onClick={() => setCreating(true)}><Plus size={16} />{t('Add player')}</button>}
      </PageTitle>

      {live.error && <ErrorNote message={live.error} />}
      <Success message={notice} />
      {!canManage && <p className="notice">{t('Only the League Leader can publish, edit or deactivate market players.')}</p>}

      {/* Card rows like the demo's Player Management, not a table: each row shows
          avatar, name, position/rating/price and its actions together. */}
      <div className="panel manage-list-wrap">
        <div className="management-list">
          {live.players.length === 0 && <Empty title="No players in this market yet." />}
          {live.players.map((p) => (
            <div className="manage-row" key={p.id}>
              <Avatar name={p.name} image={p.image_url ?? undefined} size="sm" />
              <div>
                <strong>{p.name}</strong>
                {live.players.some((other) => other.id !== p.id && other.name.trim().toLocaleLowerCase() === p.name.trim().toLocaleLowerCase()) && <small className="identity-hint">#{p.id.slice(0, 8)}</small>}
                <small>{p.position} · {p.rating} {t('OVR')} · {formatCompactMoney(p.price)}</small>
              </div>
              <Badge kind={p.active ? 'approved' : 'neutral'}>{t(p.active ? 'Active' : 'Inactive')}</Badge>
              {canManage && <><button className="button button-muted" onClick={() => setEditing(p)}>{t('Edit')}</button>{p.active && <button className="button button-danger" onClick={() => void removeFromMarket(p)}>{t('Delete')}</button>}</>}
            </div>
          ))}
        </div>
      </div>

      {(creating || editing) && (
        <PlayerDialog
          player={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={(message) => { setCreating(false); setEditing(null); setNotice(message); }}
          onDeleted={(message) => { setCreating(false); setEditing(null); setNotice(message); }}
        />
      )}
    </>
  );
}

/**
 * Create/edit dialog. Price is entered in millions and converted to the stored
 * NUMERIC (a 100M budget means 100,000,000) - the conversion lives here so the
 * UI never shows a raw 8-digit number.
 */
function PlayerDialog({ player, onClose, onSaved, onDeleted }: {
  player: ApiPlayer | null; onClose: () => void; onSaved: (message: string) => void; onDeleted: (message: string) => void;
}) {
  const { t } = useTranslation();
  const live = useLive();
  const [name, setName] = useState(player?.name ?? '');
  const [position, setPosition] = useState<'GK' | 'DEF' | 'MID' | 'FWD'>(player?.position ?? 'MID');
  const [priceM, setPriceM] = useState(player ? String(player.price / 1_000_000) : '5');
  const [rating, setRating] = useState(player ? String(player.rating) : '75');
  const [active, setActive] = useState(player?.active ?? true);
  const [imageUrl, setImageUrl] = useState(player?.image_url ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element || element.open) return;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
  }, []);

  async function removeFromMarket() {
    if (!player) return;
    setError(''); setBusy(true);
    try {
      await live.savePlayer({ name: player.name, position: player.position, price: player.price,
        rating: player.rating, active: false, imageUrl: player.image_url, playerId: player.player_id });
      onDeleted(t('Player removed from the active market. Existing squads and history are kept.'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Player could not be deleted.'));
    } finally { setBusy(false); }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setBusy(true);
    try {
      const millions = Number(priceM);
      if (!Number.isFinite(millions) || millions <= 0) throw new Error(t('Price must be positive.'));
      await live.savePlayer({
        name: name.trim(), position, price: Math.round(millions * 1_000_000),
        rating: Number(rating), active,
        imageUrl: imageUrl.trim() || null,
        playerId: player?.player_id ?? null,
      });
      onSaved(t(player ? 'Player updated.' : 'Player added.'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Player could not be saved.'));
    } finally { setBusy(false); }
  }

  return (
    <dialog ref={dialog} className="player-sheet player-edit-sheet" aria-labelledby="player-dialog-title"
      onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="sheet-handle" aria-hidden="true" />
      <button type="button" className="sheet-close" aria-label={t('Close')} onClick={onClose}><X size={20} /></button>
      <div className="eyebrow">{t('THE MARKET')}</div>
      <h2 id="player-dialog-title">{t(player ? 'Edit player' : 'Add player')}</h2>
      <form id="player-editor-form" className="form-panel player-editor-form" onSubmit={save}>
        <label>{t('Player name')}
          <input required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>{t('Position')}
          <select value={position} onChange={(e) => setPosition(e.target.value as typeof position)}>
            {positions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <div className="form-row">
          <label>{t('Price (millions)')}
            <input required type="number" min="0.1" step="0.1" value={priceM} onChange={(e) => setPriceM(e.target.value)} />
          </label>
          <label>{t('Rating')}
            <input required type="number" min="1" max="99" value={rating} onChange={(e) => setRating(e.target.value)} />
          </label>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {t('Active in the market')}
        </label>
        <ImageField value={imageUrl} onChange={setImageUrl} />
        {error && <p className="error" role="alert"><AlertCircle size={14} /> {error}</p>}
        {confirmDelete && <div className="notice" role="alert">
          <p>{t('This removes the player from the active market. Existing squads and history are kept.')}</p>
          <div className="button-row"><button className="button button-danger" type="button" disabled={busy} onClick={() => void removeFromMarket()}>{busy ? t('Deleting…') : t('Confirm delete')}</button>
            <button className="button button-outline" type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>{t('Cancel')}</button></div>
        </div>}
      </form>
      <div className="button-row player-editor-actions">
        <button className="button sheet-primary" type="submit" form="player-editor-form" disabled={busy || !name.trim()}>{busy ? t('Saving…') : t('Save')}</button>
        {player?.active && <button className="button button-danger" type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>{t('Delete player')}</button>}
      </div>
    </dialog>
  );
}

/**
 * Image input. Upload is offered but explained honestly: the bucket has no upload
 * policy yet, so the picker validates the file, shows a preview, and tells the
 * user to use a URL instead. No pretend upload.
 */
function ImageField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState('');

  async function choose(file?: File) {
    if (!file) return;
    setMessage('');
    try {
      await inspectImage(file);
      setPreview(URL.createObjectURL(file));
      if (uploadBlocked) {
        setMessage(t('This image is valid (under 5 MB). Upload is not enabled yet, so paste an image URL instead.'));
      }
    } catch (caught) {
      setMessage(caught instanceof StorageError ? caught.message : t('Could not read this image.'));
    }
  }

  return (
    <div className="image-picker">
      <label className="button button-outline image-file-button">
        <Upload size={15} /> {t('Choose an image')}
        <input className="image-file-input" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
          onChange={(e) => void choose(e.target.files?.[0])} />
      </label>
      <small>{t('JPG, PNG or WebP up to 5 MB.')}</small>
      {preview && (
        <div className="image-preview">
          <img src={preview} alt={t('Image preview')} />
          <button type="button" className="button button-outline" onClick={() => { setPreview(''); setMessage(''); }}>
            {t('Remove image')}
          </button>
        </div>
      )}
      <label>{t('Image URL (optional)')}
        <input type="url" value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://" />
      </label>
      {message && <p className="notice" role="status">{message}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export function LiveSuggestPlayer() {
  const { t } = useTranslation();
  const live = useLive();
  type Draft = { key: number; name: string; position: 'GK' | 'DEF' | 'MID' | 'FWD'; notes: string; imageUrl: string };
  const [drafts, setDrafts] = useState<Draft[]>([{ key: 1, name: '', position: 'MID', notes: '', imageUrl: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const mine = live.suggestions;
  function update(key: number, patch: Partial<Draft>) {
    setDrafts((current) => current.map((draft) => draft.key === key ? { ...draft, ...patch } : draft));
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setDone(''); setBusy(true);
    try {
      await live.suggestPlayers(drafts.map(({ name, position, notes, imageUrl }) => ({
        name: name.trim(), position, notes: notes.trim() || undefined, imageUrl: imageUrl.trim() || null,
      })));
      setDrafts([{ key: Date.now(), name: '', position: 'MID', notes: '', imageUrl: '' }]);
      setDone(t('Suggestions submitted. Your league leader will review each one.'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('Could not submit those suggestions. No suggestions were saved.'));
    } finally { setBusy(false); }
  }

  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  return (
    <>
      <PageTitle eyebrow="THE MARKET" title="Suggest a player"
        description="Propose one or more players for your league market. The leader sets the final price and rating for each." />

      <form className="panel form-panel suggestion-batch" onSubmit={submit}>
        {drafts.map((draft, index) => (
          <fieldset className="suggestion-draft" key={draft.key}>
            <legend>{t('Player suggestion')} {index + 1}</legend>
            <label>{t('Player name')}
              <input required minLength={2} maxLength={100} value={draft.name}
                onChange={(e) => update(draft.key, { name: e.target.value })} />
            </label>
            <label>{t('Position')}
              <select value={draft.position} onChange={(e) => update(draft.key, { position: e.target.value as Draft['position'] })}>
                {positions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label>{t('Details')}
              <textarea maxLength={500} rows={2} value={draft.notes}
                onChange={(e) => update(draft.key, { notes: e.target.value })}
                placeholder={t('Optional details for your leader')} />
            </label>
            <label>{t('Image URL (optional)')}
              <input type="url" value={draft.imageUrl} onChange={(e) => update(draft.key, { imageUrl: e.target.value })} placeholder="https://" />
            </label>
            {drafts.length > 1 && <button type="button" className="button button-outline"
              onClick={() => setDrafts((current) => current.filter((item) => item.key !== draft.key))}>{t('Remove suggestion')}</button>}
          </fieldset>
        ))}
        <div className="button-row">
          <button type="button" className="button button-outline" disabled={busy || drafts.length >= 50}
            onClick={() => setDrafts((current) => [...current, { key: Date.now() + current.length, name: '', position: 'MID', notes: '', imageUrl: '' }])}>
            <Plus size={16} /> {t('Add another player')}
          </button>
          <button className="button" disabled={busy || drafts.some((draft) => draft.name.trim().length < 2)}>
            {busy ? t('Submitting…') : t('Submit all suggestions')}
          </button>
        </div>
        {error && <p className="error" role="alert"><AlertCircle size={14} /> {error}</p>}
        {done && <p className="validation-panel valid" role="status"><Check size={14} /> {done}</p>}
        <small>{t('Each suggestion is reviewed separately. The entire batch is saved together or not at all.')}</small>
      </form>

      <div className="panel section-spacer">
        <SectionHead eyebrow="YOUR ACTIVITY" title="My suggestions" />
        {mine.length === 0
          ? <Empty title="No suggestions yet" description="Anything you propose appears here with its status." />
          : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>{t('PLAYER')}</th><th>{t('Position')}</th><th>{t('Status')}</th><th>{t('Details')}</th></tr></thead>
                <tbody>
                  {mine.map((s) => (
                    <tr key={s.id}>
                      <td><strong>{s.name}</strong>{mine.some((other) => other.id !== s.id && other.name.trim().toLocaleLowerCase() === s.name.trim().toLocaleLowerCase()) && <small className="identity-hint">#{s.id.slice(0, 8)}</small>}</td>
                      <td>{s.position}</td>
                      <td><Badge kind={s.status === 'approved' ? 'lime' : s.status === 'rejected' ? 'danger' : 'neutral'}>
                        {t(s.status === 'pending' ? 'Pending' : s.status === 'approved' ? 'Approved' : 'Rejected')}
                      </Badge></td>
                      <td>
                        {s.status === 'rejected' && s.rejection_reason && <small>{s.rejection_reason}</small>}
                        {s.status === 'approved' && <small>{t('Added to the market')}</small>}
                        {s.status === 'pending' && <small>{t('Waiting for the leader')}</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </>
  );
}

export function LiveApprovals() {
  const { t } = useTranslation();
  const live = useLive();
  const [selected, setSelected] = useState<ApiSuggestion | null>(null);
  const [priceM, setPriceM] = useState('5');
  const [rating, setRating] = useState('75');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const pending = live.suggestions.filter((s) => s.status === 'pending');

  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;
  if (!live.isLeader) {
    return <><PageTitle eyebrow="LEADER TOOLS" title="Approval Queue" /><p className="notice">{t('Only the League Leader can review suggestions.')}</p></>;
  }

  async function decide(decision: 'approved' | 'rejected') {
    if (!selected) return;
    setError(''); setBusy(true);
    try {
      await live.reviewSuggestion(selected.id, decision, decision === 'approved'
        ? { price: Math.round(Number(priceM) * 1_000_000), rating: Number(rating) }
        : { reason });
      setNotice(t(decision === 'approved' ? 'Suggestion approved and added to the market.' : 'Suggestion rejected.'));
      setSelected(null); setReason(''); setPriceM('5'); setRating('75');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('This suggestion could not be reviewed.'));
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageTitle eyebrow="LEADER TOOLS" title="Approval Queue"
        description={`${pending.length} ${t('suggestions waiting for review')}`} />
      {live.error && <ErrorNote message={live.error} />}
      <Success message={notice} />

      {pending.length === 0
        ? <Empty title="Nothing to review" description="New suggestions from your managers will appear here." />
        : (
          <div className="panel">
            {pending.map((s) => (
              <div className="suggestion-row" key={s.id}>
                <Avatar name={s.name} image={s.image_url ?? undefined} size="sm" />
                <div>
                  <strong>{s.name}{pending.some((other) => other.id !== s.id && other.name.trim().toLocaleLowerCase() === s.name.trim().toLocaleLowerCase()) && <small className="identity-hint">#{s.id.slice(0, 8)}</small>}</strong>
                  <small>{s.position} · {t('Submitted by')} {s.submitted_by_name} {s.submitted_by === live.myUserId ? `(${t('you')})` : ''}</small>
                  {s.notes && <small className="muted">{s.notes}</small>}
                </div>
                <button className="button button-small" disabled={s.submitted_by === live.myUserId}
                  title={s.submitted_by === live.myUserId ? t('You cannot review your own suggestion') : undefined}
                  onClick={() => { setSelected(s); setError(''); setNotice(''); }}>
                  {t('Review')}
                </button>
              </div>
            ))}
          </div>
        )}

      {selected && (
        <dialog open className="player-sheet" aria-labelledby="review-title">
          <div className="sheet-handle" aria-hidden="true" />
          <button className="sheet-close" aria-label={t('Close')} onClick={() => setSelected(null)}><X size={20} /></button>
          <div className="eyebrow">{t('NEW SUGGESTION')}</div>
          <h2 id="review-title">{selected.name}{pending.some((other) => other.id !== selected.id && other.name.trim().toLocaleLowerCase() === selected.name.trim().toLocaleLowerCase()) && <small className="identity-hint">#{selected.id.slice(0, 8)}</small>}</h2>
          <p className="sheet-note">{selected.position} · {t('Submitted by')} {selected.submitted_by_name}</p>
          {selected.notes && <p className="sheet-note">{selected.notes}</p>}

          <div className="form-row">
            <label>{t('Final price (millions)')}
              <input type="number" min="0.1" step="0.1" value={priceM} onChange={(e) => setPriceM(e.target.value)} />
            </label>
            <label>{t('Final rating')}
              <input type="number" min="1" max="99" value={rating} onChange={(e) => setRating(e.target.value)} />
            </label>
          </div>
          <label>{t('Rejection reason (required to reject)')}
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </label>
          {error && <p className="error" role="alert"><AlertCircle size={14} /> {error}</p>}
          <div className="sheet-actions">
            <button className="button button-outline" disabled={busy || !reason.trim()} onClick={() => void decide('rejected')}>
              {t('Reject suggestion')}
            </button>
            <button className="button" disabled={busy} onClick={() => void decide('approved')}>
              {t('Approve and publish')}
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
