import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import * as api from '../../services/api';
import type { ApiMember } from '../../types/api';

export function ScheduleMatchForm({ leagueId, gameweeks, members, onCreated, onCancel }: {
  leagueId: string;
  gameweeks: Array<{ id: string; number: number; season_name: string }>;
  members: ApiMember[];
  onCreated: (matchId: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<Array<{ id: string; name: string; active: boolean }>>([]);
  const [teamError, setTeamError] = useState('');
  const [teamName, setTeamName] = useState('');
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamSaveError, setTeamSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [gameweekId, setGameweekId] = useState('');
  const [teamA, setTeamA] = useState('');
  const [teamB, setTeamB] = useState('');
  const [organizerId, setOrganizerId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [venue, setVenue] = useState('');
  const [starters, setStarters] = useState('7');
  const [substitutes, setSubstitutes] = useState('5');
  const organizers = members.filter(m => m.is_organizer && m.status === 'active');

  useEffect(() => {
    let active = true;
    api.realTeams(leagueId).then(rows => { if (active) setTeams(rows.filter(x => x.active)); })
      .catch(e => { if (active) setTeamError(e instanceof Error ? e.message : 'Could not load league teams'); });
    return () => { active = false; };
  }, [leagueId]);

  async function addTeam() {
    if (!teamName.trim()) return;
    setTeamBusy(true); setTeamSaveError('');
    try {
      const created = await api.createRealTeam(leagueId, teamName.trim());
      const rows = await api.realTeams(leagueId);
      if (!rows.some(x => x.id === created.id)) throw new Error('Team was created but could not be loaded. Refresh before trying again.');
      setTeams(rows.filter(x => x.active)); setTeamName(''); setTeamError('');
    } catch (e) { setTeamSaveError(e instanceof Error ? e.message : 'Could not create real team'); }
    finally { setTeamBusy(false); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const created = await api.createMatch(leagueId, {
        gameweekId: gameweekId || null, teamA, teamB, organizerId,
        startsAt: new Date(startsAt).toISOString(), venue, startersPerSide: Number(starters), maxSubstitutes: Number(substitutes),
      });
      // PR #56: the parent performs one authoritative refresh, verifies the new
      // id against that same response, and updates the shared list from it.
      await onCreated(created.id);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create match'); }
    finally { setBusy(false); }
  }

  return <section className="panel match-create-panel">
    <h2>{t('Schedule a real match')}</h2>
    <p className="muted">{t('Only published League Market players can be selected in lineups. Scheduling does not create player profiles or affect fantasy squads.')}</p>
    {teamError && <p className="error-text" role="alert">{t('Teams could not be loaded')}: {teamError}</p>}
    <div className="inline-team-create"><label>{t('New real team')}<input value={teamName} maxLength={100} onChange={e => setTeamName(e.target.value)} placeholder={t('Enter real team name')} /></label><button type="button" className="button button-outline" disabled={teamBusy || !teamName.trim()} onClick={() => void addTeam()}>{teamBusy ? t('Saving…') : t('Add team')}</button>{teamSaveError && <p className="error-text" role="alert">{teamSaveError}</p>}</div>
    <form className="match-form" onSubmit={e => void submit(e)}>
      <label>{t('Gameweek')} <small>{t('Optional')}</small><select value={gameweekId} onChange={e => setGameweekId(e.target.value)}><option value="">{t('No gameweek')}</option>{gameweeks.map(g => <option key={g.id} value={g.id}>Gameweek {g.number}{g.season_name ? ` · ${g.season_name}` : ''}</option>)}</select></label>
      <label>{t('Team A')}<select required value={teamA} onChange={e => setTeamA(e.target.value)}><option value="">{t('Choose team')}</option>{teams.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label>{t('Team B')}<select required value={teamB} onChange={e => setTeamB(e.target.value)}><option value="">{t('Choose team')}</option>{teams.filter(x => x.id !== teamA).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label>{t('Assigned Organizer')}<select required value={organizerId} onChange={e => setOrganizerId(e.target.value)}><option value="">{t('Choose appointed organizer')}</option>{organizers.map(x => <option key={x.user_id} value={x.user_id}>{x.name}</option>)}</select></label>
      <label>{t('Date & kick-off')}<input required type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} /></label>
      <label>{t('Venue')}<input required minLength={1} maxLength={200} value={venue} onChange={e => setVenue(e.target.value)} /></label>
      <label>{t('Starters per side')}<input required type="number" min={1} max={11} value={starters} onChange={e => setStarters(e.target.value)} /></label>
      <label>{t('Maximum substitutes')}<input required type="number" min={0} max={30} value={substitutes} onChange={e => setSubstitutes(e.target.value)} /></label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="form-actions"><button className="button button-primary" disabled={busy || teams.length < 2 || organizers.length === 0}>{busy ? t('Saving…') : t('Create match')}</button><button type="button" className="button button-outline" onClick={onCancel}>{t('Cancel')}</button></div>
      {teams.length < 2 && !teamError && <p className="notice">{t('At least two active real teams are required.')}</p>}
      {organizers.length === 0 && <p className="notice">{t('Appoint an active league member as Match Organizer in league management first.')}</p>}
    </form>
  </section>;
}
