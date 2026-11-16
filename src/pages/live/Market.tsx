import { playerImage } from '../../services/playerImage';
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
import { inspectImage, uploadPlayerImage, removePlayerImage } from '../../services/storage';
import { useImageSource } from '../../hooks/useImageSource';
import { marketPlayers } from '../../services/api';

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
                  <Avatar name={player.name} image={playerImage(player)} size="lg" />
                </div>
                <Link to={`/players/${player.id}`} className="player-name">{player.name}</Link>
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
        <Avatar name={player.name} image={playerImage(player)} size="lg" />
        <div>
          <Badge kind="lime">{player.position}</Badge>{' '}
          <Badge kind={player.active ? 'approved' : 'neutral'}>{t(player.active ? 'Active' : 'Inactive')}</Badge>
          <h1>{player.name}</h1>
          <p>{live.league?.name}</p>
          <div className="profile-stats">
            <span><strong>{player.rating}</strong> {t('OVR')}</span>
            <span><strong>{formatCompactMoney(player.price)}</strong> {t('Price')}</span>
            {/* No per-player points exist in the live schema, so this figure is
                omitted rather than shown as 0. */}
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
              <Avatar name={p.name} image={playerImage(p)} size="sm" />
              <div>
                <strong>{p.name}</strong>
                <small>{p.position} · {p.rating} {t('OVR')} · {formatCompactMoney(p.price)}</small>
              </div>
              <Badge kind={p.active ? 'approved' : 'neutral'}>{t(p.active ? 'Active' : 'Inactive')}</Badge>
              {canManage && <button className="button button-muted" onClick={() => setEditing(p)}>{t('Edit')}</button>}
            </div>
          ))}
        </div>
      </div>

      {(creating || editing) && (
        <PlayerDialog
          player={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={(message) => { setCreating(false); setEditing(null); setNotice(message); }}
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
function PlayerDialog({ player, onClose, onSaved }: {
  player: ApiPlayer | null; onClose: () => void; onSaved: (message: string) => void;
}) {
  const { t } = useTranslation();
  const live = useLive();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);
  const [name, setName] = useState(player?.name ?? '');
  const [position, setPosition] = useState<'GK' | 'DEF' | 'MID' | 'FWD'>(player?.position ?? 'MID');
  const [priceM, setPriceM] = useState(player ? String(player.price / 1_000_000) : '5');
  const [rating, setRating] = useState(player ? String(player.rating) : '75');
  const [active, setActive] = useState(player?.active ?? true);
  const [imageUrl, setImageUrl] = useState(player?.image_url ?? '');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [savedId, setSavedId] = useState(player?.player_id ?? '');
  const [currentPath, setCurrentPath] = useState(player?.image_path ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setBusy(true);
    let detailsSaved = false;
    try {
      const millions = Number(priceM);
      if (!Number.isFinite(millions) || millions <= 0) throw new Error(t('Price must be positive.'));
      if (!live.leagueId) throw new Error(t('Select a league'));
      let id = savedId;
      let previousPath = currentPath;
      // Explicitly unlink an existing image before replacing it with a URL or removing it.
      if (id && (removeImage || (!imageFile && imageUrl !== (player?.image_url ?? ''))) && (previousPath || player?.image_url)) {
        await removePlayerImage({ leagueId: live.leagueId, kind: 'player', targetId: id, previousPath });
        previousPath = null; setCurrentPath(null);
      }
      const saved = await live.savePlayer({
        name: name.trim(), position, price: Math.round(millions * 1_000_000),
        rating: Number(rating), active,
        imageUrl: imageFile || removeImage ? null : imageUrl.trim() || null,
        playerId: id || null,
      });
      id = saved.player_id; setSavedId(id); detailsSaved = true;
      if (imageFile) {
        const path = await uploadPlayerImage({ leagueId: live.leagueId, kind: 'player', targetId: id, previousPath }, imageFile, setProgress);
        setCurrentPath(path); setImageFile(null);
      }
      await live.reload();
      onSaved(t(player ? 'Player updated.' : 'Player added.'));
    } catch (caught) {
      setError((detailsSaved ? t('Player details saved; the image update failed. ') : '') + (caught instanceof Error ? caught.message : t('Player could not be saved.')));
    } finally { setBusy(false); }
  }

  return (
    <dialog ref={dialog} className="player-sheet player-form-dialog" aria-labelledby="player-dialog-title" onClose={onClose}>
      <div className="sheet-handle" aria-hidden="true" />
      <button type="button" className="sheet-close" disabled={busy} aria-label={t('Close')} onClick={onClose}><X size={20} /></button>
      <div className="eyebrow">{t('THE MARKET')}</div>
      <h2 id="player-dialog-title">{t(player ? 'Edit player' : 'Add player')}</h2>
      <form className="form-panel" onSubmit={save}>
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
        <ImageField value={imageUrl} onChange={value => { setImageUrl(value); setRemoveImage(false); }} currentImage={!removeImage ? (currentPath ? `storage-image:${currentPath}` : imageUrl) : ''} file={imageFile} onFile={file => { setImageFile(file); setRemoveImage(false); }} onRemove={() => { setImageFile(null); setImageUrl(''); setRemoveImage(true); }} onBusyChange={setImageBusy} />
        {progress !== null && <p role="status">{t('Uploading image')}: {progress}%</p>}
        {error && <p className="error" role="alert"><AlertCircle size={14} /> {error}</p>}
        <button className="button sheet-primary" disabled={busy || imageBusy || !name.trim()}>
          {busy ? t('Saving…') : t('Save')}
        </button>
      </form>
    </dialog>
  );
}

/** Live image picker: selection is local until the enclosing form is saved. */
function ImageField({ value, onChange, currentImage, file, onFile, onRemove, onBusyChange, allowUrl = true }: {
  value: string; onChange: (value: string) => void; currentImage?: string; file: File | null;
  onFile: (file: File | null) => void; onRemove: () => void; onBusyChange: (busy: boolean) => void; allowUrl?: boolean;
}) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState('');
  const existing = useImageSource(currentImage);
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);
  useEffect(() => { if (!file) { setPreview(''); return; } const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url); }, [file]);
  async function choose(file?: File) {
    if (!file) return;
    const current = ++sequence.current; onBusyChange(true); setMessage('');
    try { await inspectImage(file); if (current === sequence.current) onFile(file); }
    catch (error) { if (current === sequence.current) setMessage(error instanceof Error ? error.message : t('Could not read this image.')); }
    finally { if (current === sequence.current) onBusyChange(false); }
  }
  return <div className="image-picker">
    <label className="button button-outline image-file-button"><Upload size={15} /> {t('Choose an image')}
      <input className="image-file-input" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={e => { void choose(e.target.files?.[0]); e.target.value=''; }} />
    </label>
    <small>{t('JPG, PNG or WebP up to 5 MB.')}</small>
    {(preview || existing) && <div className="image-preview"><img src={preview || existing} alt={t('Image preview')} onError={e => { e.currentTarget.hidden = true; }} />
      <button type="button" className="button button-outline" onClick={() => { sequence.current++; onBusyChange(false); setMessage(''); onRemove(); }}>{t('Remove image')}</button></div>}
    {allowUrl && <label>{t('Image URL (optional)')}<input type="url" value={value} onChange={e => { sequence.current++; onBusyChange(false); onFile(null); setMessage(''); onChange(e.target.value); }} placeholder="https://" /></label>}
    {message && <p className="error" role="alert">{t(message)}</p>}
  </div>;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export function LiveSuggestPlayer() {
  const { t } = useTranslation();
  const live = useLive();
  const [name, setName] = useState('');
  const [position, setPosition] = useState<'GK' | 'DEF' | 'MID' | 'FWD'>('MID');
  const [notes, setNotes] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [createdId, setCreatedId] = useState('');
  const [editingImage, setEditingImage] = useState<ApiSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const mine = live.suggestions;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setDone(''); setBusy(true);
    let didCreate = !!createdId;
    try {
      if (!live.leagueId) throw new Error(t('Select a league'));
      const id = createdId || (await live.suggestPlayer({ name: name.trim(), position, notes: notes.trim() || undefined, imageUrl: imageFile ? null : imageUrl.trim() || null })).id;
      setCreatedId(id); didCreate = true;
      if (imageFile) await uploadPlayerImage({ leagueId: live.leagueId, kind: 'suggestion', targetId: id, previousPath: null }, imageFile, setProgress);
      setName(''); setNotes(''); setImageUrl(''); setImageFile(null); setCreatedId(''); setProgress(null);
      await live.reload();
      setDone(t('Suggestion submitted. Your league leader will review it.'));
    } catch (caught) {
      setError((didCreate ? t('Suggestion created; retry the image upload. ') : '') + (caught instanceof Error ? caught.message : t('Could not submit that suggestion.')));
    } finally { setBusy(false); }
  }

  if (live.loading) return <Loading />;
  if (!live.league) return <Empty title="Join or create a league" to="/create-league" action="Create League" />;

  return (
    <>
      <PageTitle eyebrow="THE MARKET" title="Suggest a player"
        description="Propose a player for your league market. The leader sets the final price and rating." />

      <form className="panel form-panel" onSubmit={submit}>
        <label>{t('Player name')}
          <input disabled={!!createdId} required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>{t('Position')}
          <select disabled={!!createdId} value={position} onChange={(e) => setPosition(e.target.value as typeof position)}>
            {positions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>{t('Details')}
          <textarea disabled={!!createdId} maxLength={500} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder={t('Optional details for your leader')} />
        </label>
        <ImageField value={imageUrl} onChange={setImageUrl} currentImage={imageUrl} file={imageFile} onFile={setImageFile} onRemove={() => { setImageUrl(''); setImageFile(null); }} onBusyChange={setImageBusy} allowUrl={!createdId} />
        {progress !== null && <p role="status">{t('Uploading image')}: {progress}%</p>}
        {error && <p className="error" role="alert"><AlertCircle size={14} /> {error}</p>}
        {done && <p className="validation-panel valid" role="status"><Check size={14} /> {done}</p>}
        <button className="button" disabled={busy || imageBusy || name.trim().length < 2}>
          {busy ? t('Submitting…') : t('Submit suggestion')}
        </button>
      </form>

      {editingImage && live.leagueId && <SuggestionImageEditor key={editingImage.id} suggestion={editingImage} leagueId={live.leagueId} onClose={() => setEditingImage(null)} onSaved={async () => { setEditingImage(null); await live.reload(); }} />}
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
                      <td><strong>{s.name}</strong></td>
                      <td>{s.position}</td>
                      <td>
                        <Badge kind={s.status === 'approved' ? 'lime' : s.status === 'rejected' ? 'danger' : 'neutral'}>
                          {t(s.status === 'pending' ? 'Pending' : s.status === 'approved' ? 'Approved' : 'Rejected')}
                        </Badge>
                      </td>
                      <td>
                        {s.status === 'rejected' && s.rejection_reason && <small>{s.rejection_reason}</small>}
                        {s.status === 'approved' && <small>{t('Added to the market')}</small>}
                        {s.status === 'pending' && <small>{t('Waiting for the leader')}</small>}
                        {s.status === 'pending' && s.submitted_by === live.myUserId && <button type="button" className="button button-muted" onClick={() => setEditingImage(s)}>{t('Edit image')}</button>}
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

function SuggestionImageEditor({ suggestion, leagueId, onClose, onSaved }: { suggestion: ApiSuggestion; leagueId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null); const [removing, setRemoving] = useState(false);
  const [validating, setValidating] = useState(false); const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null); const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try {
      const target = { leagueId, kind: 'suggestion' as const, targetId: suggestion.id, previousPath: suggestion.image_path };
      if (file) await uploadPlayerImage(target, file, setProgress);
      else if (removing) await removePlayerImage(target);
      await onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('Could not save image.')); }
    finally { setBusy(false); }
  }
  return <section className="panel section-spacer" aria-label={`${t('Edit image')}: ${suggestion.name}`}>
    <h2>{t('Edit image')}: {suggestion.name}</h2>
    <ImageField value="" onChange={() => {}} currentImage={removing ? '' : playerImage(suggestion)} file={file} onFile={f => { setFile(f); setRemoving(false); }} onRemove={() => { setFile(null); setRemoving(true); }} onBusyChange={setValidating} allowUrl={false} />
    {progress !== null && <p role="status">{t('Uploading image')}: {progress}%</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="button-row"><button className="button" type="button" disabled={busy || validating || (!file && !removing)} onClick={() => void save()}>{t('Save')}</button><button className="button button-outline" disabled={busy} type="button" onClick={onClose}>{t('Cancel')}</button></div>
  </section>;
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
  const [approvedId, setApprovedId] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [removeImage, setRemoveImage] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

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
      if (!live.leagueId) throw new Error(t('Select a league'));
      let marketId = approvedId;
      if (!marketId) {
        const reviewed = await live.reviewSuggestion(selected.id, decision, decision === 'approved'
          ? { price: Math.round(Number(priceM) * 1_000_000), rating: Number(rating), imagePath: (imageFile || removeImage || imageUrl !== (selected.image_url ?? '')) ? '__remove__' : null }
          : { reason });
        if (decision === 'approved') { marketId = reviewed.league_player_id ?? ''; setApprovedId(marketId); }
      }
      if (decision === 'approved' && (imageFile || removeImage || imageUrl !== (selected.image_url ?? ''))) {
        const published = (await marketPlayers(live.leagueId, { includeInactive: true })).find(p => p.id === marketId);
        if (!published) throw new Error(t('Player was approved but could not be loaded. Retry the image update.'));
        const target = { leagueId: live.leagueId, kind: 'player' as const, targetId: published.player_id, previousPath: published.image_path };
        if (imageFile) await uploadPlayerImage(target, imageFile, setProgress);
        else {
          await removePlayerImage(target);
          if (!removeImage && imageUrl.trim()) await live.savePlayer({ playerId: published.player_id, name: published.name, position: published.position, price: published.price, rating: published.rating, active: published.active, imageUrl: imageUrl.trim() });
        }
      }
      setNotice(t(decision === 'approved' ? 'Suggestion approved and added to the market.' : 'Suggestion rejected.'));
      setSelected(null); setReason(''); setPriceM('5'); setRating('75'); setApprovedId(''); setImageFile(null); setProgress(null);
      await live.reload();
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
                <Avatar name={s.name} image={playerImage(s)} size="sm" />
                <div>
                  <strong>{s.name}</strong>
                  <small>{s.position} · {t('Submitted by')} {s.submitted_by_name} {s.submitted_by === live.myUserId ? `(${t('you')})` : ''}</small>
                  {s.notes && <small className="muted">{s.notes}</small>}
                </div>
                <button className="button button-small" disabled={s.submitted_by === live.myUserId}
                  title={s.submitted_by === live.myUserId ? t('You cannot review your own suggestion') : undefined}
                  onClick={() => { setSelected(s); setImageUrl(s.image_url ?? ''); setImageFile(null); setRemoveImage(false); setApprovedId(''); setProgress(null); setError(''); setNotice(''); }}>
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
          <Avatar name={selected.name} image={playerImage(selected)} size="lg" />
          <h2 id="review-title">{selected.name}</h2>
          <p className="sheet-note">{selected.position} · {t('Submitted by')} {selected.submitted_by_name}</p>
          {selected.notes && <p className="sheet-note">{selected.notes}</p>}
          <ImageField value={imageUrl} onChange={value => { setImageUrl(value); setRemoveImage(false); }} currentImage={removeImage ? '' : (selected.image_path ? `storage-image:${selected.image_path}` : imageUrl)} file={imageFile} onFile={file => { setImageFile(file); setRemoveImage(false); }} onRemove={() => { setImageFile(null); setImageUrl(''); setRemoveImage(true); }} onBusyChange={setImageBusy} />
          {progress !== null && <p role="status">{t('Uploading image')}: {progress}%</p>}
          {approvedId && <p className="notice">{t('Player approved; retry the image update before closing.')}</p>}

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
            <button className="button button-outline" disabled={busy || !!approvedId || !reason.trim()} onClick={() => void decide('rejected')}>
              {t('Reject suggestion')}
            </button>
            <button className="button" disabled={busy || imageBusy} onClick={() => void decide('approved')}>
              {t('Approve and publish')}
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
