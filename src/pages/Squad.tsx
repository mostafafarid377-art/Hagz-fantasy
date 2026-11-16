import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { AddPlayerSheet } from '../components/AddPlayerSheet';
import { PlayerSheet } from '../components/PlayerSheet';
import { Avatar, PageTitle, PlayerCard, SectionHead } from '../components/UI';
import { useDemo } from '../hooks/useDemo';
import { defaultFormation, formations, limits, squadSummary, substitutionTargets, transferPlayer } from '../services/rules';
import { Pitch } from './Dashboard';
import type { Formation, Player, Position } from '../types';
import { formatMoney } from '../utils/format';

const errorLabels: Record<string, string> = { marketClosed: 'The market is closed.', wrongLeague: 'Select players from the current league.', inactive: 'Inactive players cannot be selected.', alreadySelected: 'Player already selected.', transferPosition: 'The replacement must play in the same position.', overBudget: 'Not enough budget.' };

function TransfersPage() {
  const { t } = useTranslation();
  const { players, squad, league, transfer } = useDemo();
  const [outId, setOutId] = useState(''); const [inId, setInId] = useState(''); const [message, setMessage] = useState('');
  const summary = squadSummary(squad.playerIds, players, league.budget);
  const outgoing = summary.selected.find(p => p.id === outId); const incoming = players.find(p => p.id === inId);
  const result = outId && inId ? transferPlayer(squad, outId, inId, players, league.budget, league.marketOpen) : undefined;
  return <><PageTitle eyebrow="YOUR TEAM" title="Transfers" description="Transfers are demo-only and update your local squad immediately."><Link to="/squad" className="button button-outline">{t('View squad')}</Link></PageTitle>
    <div className="two-column"><div className="panel form-panel"><SectionHead title="Make a transfer"/><p className="notice">{t('No transfer limits or costs are configured in this demo.')}</p>
      <label>{t('Player to transfer out')}<select value={outId} onChange={e => { setOutId(e.target.value); setInId(''); setMessage(''); }}><option value="">{t('Select a player')}</option>{summary.selected.map(p => <option key={p.id} value={p.id}>{p.name} · {p.position} · {formatMoney(p.price)}</option>)}</select></label>
      <label>{t('Replacement player')}<select value={inId} onChange={e => { setInId(e.target.value); setMessage(''); }}><option value="">{t('Select a player')}</option>{players.filter(p => p.active && !squad.playerIds.includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.name} · {p.position} · {formatMoney(p.price)}</option>)}</select></label>
      <div className="transfer-players">{[outgoing,incoming].filter((p): p is NonNullable<typeof p> => !!p).map(p=><div className="transfer-person" key={p.id}><Avatar name={p.name} image={p.image} color={p.color} size="sm"/><strong>{p.name}</strong></div>)}</div><div className="transfer-preview"><span>{t('Budget remaining')}: <b>{formatMoney(summary.remaining)}</b></span>{outgoing && incoming && <span>{t('After transfer')}: <b>{formatMoney(summary.remaining + outgoing.price - incoming.price)}</b></span>}</div>
      {result?.error && <p className="error" role="alert">{t(errorLabels[result.error] || result.error)}</p>}{message && <p className="form-message" role="status">{t(message)}</p>}
      <button className="button" disabled={!result?.squad} onClick={() => { const error = transfer(outId, inId); if (error) setMessage(errorLabels[error] || error); else { setOutId(''); setInId(''); setMessage('Transfer confirmed.'); } }}>{t('Confirm transfer')}</button>
      </div><div className="panel"><SectionHead title="Your squad"/><p className="section-description">{summary.size}/15 · {t('Budget remaining')} {formatMoney(summary.remaining)}</p>{summary.selected.map(p => <div className="suggestion-row" key={p.id}><Avatar name={p.name} color={p.color} image={p.image} size="sm"/><div><strong>{p.name}</strong><small>{p.position} · {formatMoney(p.price)}</small></div>{!p.active && <span className="badge">{t('Inactive')}</span>}</div>)}</div></div>
  </>;
}
export function SquadPage({builder=false,transfers=false}:{builder?:boolean;transfers?:boolean}) {
  if (transfers) return <TransfersPage/>;
  return <SquadEditor builder={builder}/>;
}
function SquadEditor({builder}:{builder:boolean}) {
  const { t } = useTranslation(); const { players, squad, league, state, removePlayer, updateSquad, transfer, addPlayer } = useDemo();
  const [starter, setStarter] = useState(''); const [substitute, setSubstitute] = useState('');
  const [addPosition,setAddPosition]=useState<Position>();
  const [selectedId,setSelectedId]=useState(''); const [swapSource,setSwapSource]=useState(''); const [feedback,setFeedback]=useState('');
  useEffect(()=>{setSelectedId('');setAddPosition(undefined);setSwapSource('');setFeedback('');},[league.id,state.role,builder]);
  const summary = squadSummary(squad.playerIds, players, league.budget);
  const formation = squad.formation || defaultFormation;
  const selectedPlayer=summary.selected.find(p=>p.id===selectedId);
  const sourceIndex=squad.playerIds.indexOf(swapSource);
  const swapTargets=swapSource ? substitutionTargets(squad,players,swapSource) : [];
  useEffect(()=>{if(!swapSource)return;const timer=window.setTimeout(()=>document.querySelector(sourceIndex<11?'.bench-strip':'.pitch')?.scrollIntoView({behavior:'smooth',block:'center'}),40);return ()=>window.clearTimeout(timer);},[swapSource,sourceIndex]);
  function selectPlayer(player:Player){
    if(!swapSource){setSelectedId(player.id);return;}
    if(!swapTargets.includes(player.id))return;
    const ids=[...squad.playerIds];const a=ids.indexOf(swapSource),b=ids.indexOf(player.id);if(a<0||b<0)return;
    [ids[a],ids[b]]=[ids[b],ids[a]];
    if(updateSquad({playerIds:ids})){setFeedback('Players swapped. Check your formation and confirm your lineup.');setSwapSource('');}
  }

  function move(index:number,direction:number) { const ids=[...squad.playerIds]; const next=index+direction; if(next<0||next>=ids.length)return; [ids[index],ids[next]]=[ids[next],ids[index]]; updateSquad({playerIds:ids}); }
  function swap() { const ids=[...squad.playerIds]; const a=ids.indexOf(starter), b=ids.indexOf(substitute); if(a<0||a>=11||b<11)return; [ids[a],ids[b]]=[ids[b],ids[a]]; updateSquad({playerIds:ids}); setStarter(''); setSubstitute(''); }
  return <><PageTitle eyebrow="YOUR TEAM" title={builder?'Squad Builder':'My Squad'} description="Maximum 15 players, with a 100M budget."/>
    <div className="squad-summary"><div><small>{t('Squad')}</small><strong>{summary.size}<span>/15</span></strong></div><div><small>{t('Squad value')}</small><strong>{formatMoney(summary.value)}</strong></div><div><small>{t('Budget remaining')}</small><strong className="lime">{formatMoney(summary.remaining)}</strong></div>{(Object.keys(limits) as Position[]).map(p=><div key={p}><small>{p}</small><strong>{summary.counts[p]}<span>/{limits[p]}</span></strong></div>)}</div>
    {feedback&&<p className="notice squad-feedback" role="status">{t(feedback)}</p>}
    {swapSource&&<div className="swap-banner" role="status"><div><strong>{t('Choose a player to swap')}</strong><span>{t('Select a highlighted player on the other side. Swaps must preserve or improve your formation.')}</span></div><button type="button" className="button button-outline" onClick={()=>setSwapSource('')}>{t('Cancel swap')}</button></div>}
    {addPosition&&<AddPlayerSheet key={addPosition} position={addPosition} players={players} selectedIds={squad.playerIds} remaining={summary.remaining} marketOpen={league.marketOpen} addPlayer={player=>{const error=addPlayer(player);if(!error)setFeedback('Player added to your squad.');return error;}} close={()=>setAddPosition(undefined)}/>}
    {selectedPlayer&&<PlayerSheet key={selectedPlayer.id} player={selectedPlayer} players={players} squad={squad} budget={league.budget} marketOpen={league.marketOpen} builder={builder} close={()=>setSelectedId('')} startSwap={()=>{setSwapSource(selectedPlayer.id);setSelectedId('');setFeedback('');}} canSwap={substitutionTargets(squad,players,selectedPlayer.id).length>0} transfer={(out,incoming)=>{const err=transfer(out,incoming);if(!err)setFeedback('Transfer confirmed.');return err;}} setCaptain={type=>updateSquad(type==='captain'?{captainId:selectedPlayer.id,viceCaptainId:squad.viceCaptainId===selectedPlayer.id?undefined:squad.viceCaptainId}:{viceCaptainId:selectedPlayer.id,captainId:squad.captainId===selectedPlayer.id?undefined:squad.captainId})}/>}
    <div className="squad-layout"><div className="panel"><SectionHead eyebrow="YOUR TEAM" title={builder||!summary.size?"Your squad":"Starting XI"}/>{(builder||!summary.size)&&<p className="section-description">{t("Tap an empty position to add a player. The first 11 players are starters; reorder them in My Squad.")}</p>}<label className="formation-select">{t('Formation')}<select aria-label={t('Formation')} value={formation} onChange={e=>updateSquad({formation:e.target.value as Formation})}>{(Object.keys(formations) as Formation[]).map(f=><option key={f} value={f}>{f}</option>)}</select></label><Pitch players={builder||!summary.size?summary.selected:summary.selected.slice(0,11)} formation={formation} captainId={squad.captainId} viceCaptainId={squad.viceCaptainId} onPlayerClick={selectPlayer} swapSource={swapSource} swapTargets={swapTargets} onAddPosition={setAddPosition} squadSlots={builder||!summary.size} canAddStarting={builder||squad.playerIds.length<11}/>{!builder&&summary.size>=11&&summary.size<15&&<p className="sheet-note">{t("To fill bench places, select an available position below. To change the starting XI, use substitution.")}</p>}<div className="bench-strip"><div className="bench-head"><h3>{t('Bench')}</h3>{swapSource&&<button type="button" className="text-link swap-cancel" onClick={()=>setSwapSource('')}>{t('Cancel swap')}</button>}</div><div className="bench-players">{summary.selected.slice(11).map(p=><button type="button" key={p.id} className={`bench-player ${swapSource===p.id?'swap-source':''} ${swapTargets.includes(p.id)?'swap-target':''} ${swapSource&&swapSource!==p.id&&!swapTargets.includes(p.id)?'swap-dim':''}`} aria-label={`${t(swapSource?'Select swap player':'Player details')}: ${p.name}`} disabled={!!swapSource&&!swapTargets.includes(p.id)} onClick={()=>selectPlayer(p)}><Avatar name={p.name} image={p.image} color={p.color} size="sm"/><strong>{p.name}</strong><small>{p.position} · {p.points} {t('pts')}</small></button>)}{!builder&&summary.size>=11&&summary.size<15&&(Object.keys(limits) as Position[]).flatMap(pos=>Array.from({length:Math.max(0,limits[pos]-summary.counts[pos])},(_,i)=><button type="button" className="bench-player bench-add" key={`${pos}-${i}`} aria-label={`${t('Add player')}: ${pos}`} disabled={!!swapSource} onClick={()=>setAddPosition(pos)}><span>+</span><strong>{pos}</strong></button>))}{summary.selected.length<=11&&(builder||summary.size<11)&&<small>{t('No substitutes yet.')}</small>}</div></div></div>
    <div className="panel roster"><SectionHead eyebrow="YOUR PLAYERS" title="Your squad"/><p className="section-description">{t('Starting XI')} 1–11 · {t('Bench')} 12–15</p>{summary.selected.map((p,i)=><div key={p.id}>{i===0&&<h3 className="roster-heading">{t('Starting XI')}</h3>}{i===11&&<h3 className="roster-heading">{t('Bench')}</h3>}<div className="roster-row"><span className="rank">{i+1}</span><Avatar name={p.name} color={p.color} image={p.image} size="sm"/><div><button type="button" className="roster-player-button" onClick={()=>selectPlayer(p)} disabled={!!swapSource&&!swapTargets.includes(p.id)} aria-label={`${t(swapSource?'Select swap player':'Player details')}: ${p.name}`}><strong>{p.name}</strong></button><small>{p.position} · {p.rating} {t('OVR')} · {formatMoney(p.price)}{!p.active&&` · ${t('Inactive')}`}</small></div><button className={`captain-button ${squad.captainId===p.id?'selected':''}`} aria-label={`${t('Set captain')}: ${p.name}`} title={t('Set captain')} onClick={()=>updateSquad({captainId:p.id,viceCaptainId:squad.viceCaptainId===p.id?undefined:squad.viceCaptainId})}>{t('C')}</button><button className={`captain-button ${squad.viceCaptainId===p.id?'selected':''}`} aria-label={`${t('Set vice captain')}: ${p.name}`} title={t('Set vice captain')} onClick={()=>updateSquad({viceCaptainId:p.id,captainId:squad.captainId===p.id?undefined:squad.captainId})}>{t('VC')}</button><button className="tiny-button" aria-label={`${t('Previous')}: ${p.name}`} title={t('Previous')} disabled={i===0} onClick={()=>move(i,-1)}><ArrowUp size={14}/></button><button className="tiny-button" aria-label={`${t('Next')}: ${p.name}`} title={t('Next')} disabled={i===summary.size-1} onClick={()=>move(i,1)}><ArrowDown size={14}/></button><button className="tiny-button" aria-label={`${t('Remove')}: ${p.name}`} title={t('Remove')} onClick={()=>removePlayer(p.id)}><Trash2 size={14}/></button></div></div>)}
    {summary.size>11&&<div className="swap-controls"><label>{t('Starter')}<select aria-label={t('Starter')} value={starter} onChange={e=>setStarter(e.target.value)}><option value="">{t('Select a player')}</option>{summary.selected.slice(0,11).map(p=><option value={p.id} key={p.id}>{p.name} · {p.position}</option>)}</select></label><label>{t('Substitute')}<select aria-label={t('Substitute')} value={substitute} onChange={e=>setSubstitute(e.target.value)}><option value="">{t('Select a player')}</option>{summary.selected.slice(11).map(p=><option value={p.id} key={p.id}>{p.name} · {p.position}</option>)}</select></label><button className="button button-outline" disabled={!starter||!substitute} onClick={swap}>{t('Swap players')}</button></div>}</div></div>
    {/* Actions sit BELOW the pitch: opening this screen shows the squad first, and
        editing controls come after it. Previously they were in the page header,
        above the pitch, which pushed the team itself down the screen. */}
    <div className="squad-actions">
      <Link to={builder?'/squad':'/squad-builder'} className="button button-outline">{t(builder?'View squad':'Edit squad')}</Link>
      <Link to="/market" className="button"><Plus size={16}/> {t('Add players')}</Link>
    </div>
    {builder&&<><div className="section-spacer"><SectionHead eyebrow="THE MARKET" title="Add players" action="View all" to="/market"/></div><div className="player-grid">{players.filter(p=>p.active&&!squad.playerIds.includes(p.id)).slice(0,4).map(p=><PlayerCard player={p} key={p.id}/>)}</div></>}</>;
}
