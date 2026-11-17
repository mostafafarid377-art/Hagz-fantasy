import { useEffect, useRef, useState } from 'react';
import { DetailLink } from './Navigation';
import { useTranslation } from 'react-i18next';
import { X, ArrowRightLeft } from 'lucide-react';
import { Avatar } from './UI';
import { transferPlayer } from '../services/rules';
import type { Player, Squad } from '../types';
import { formatMoney } from '../utils/format';

type Props = {player:Player; players:Player[]; squad:Squad; budget:number; marketOpen:boolean; builder:boolean; viewOnly?:boolean; close:()=>void; startSwap:()=>void; canSwap:boolean; transfer:(out:string,incoming:string)=>string|null; remove:()=>void; setCaptain:(type:'captain'|'vice')=>void};
export function PlayerSheet({player,players,squad,budget,marketOpen,builder,viewOnly=false,close,startSwap,canSwap,transfer,remove,setCaptain}:Props) {
  const {t}=useTranslation(); const dialog=useRef<HTMLDialogElement>(null);
  const [replacing,setReplacing]=useState(false);const [incomingId,setIncomingId]=useState(''); const [message,setMessage]=useState('');
  useEffect(()=>{ const element=dialog.current; if(element&&!element.open)element.showModal(); },[]);
  const incoming=players.find(p=>p.id===incomingId);
  const candidates=players.filter(p=>p.active&&p.position===player.position&&!squad.playerIds.includes(p.id));
  const result=incoming ? transferPlayer(squad,player.id,incoming.id,players,budget,marketOpen) : undefined;
  const errors:Record<string,string>={overBudget:'Not enough budget.',marketClosed:'The market is closed.',wrongLeague:'Select players from the current league.',inactive:'Inactive players cannot be selected.',alreadySelected:'Player already selected.',transferPosition:'The replacement must play in the same position.'};
  const currentValue=squad.playerIds.reduce((sum,id)=>sum+(players.find(p=>p.id===id)?.price||0),0);
  return <dialog ref={dialog} className="player-sheet" aria-labelledby="player-sheet-title" onClose={close} onClick={e=>{if(e.target===e.currentTarget)close();}}>
    <div className="sheet-handle" aria-hidden="true"/><button type="button" className="sheet-close" aria-label={t('Close')} onClick={close}><X size={20}/></button>
    <div className="sheet-hero"><Avatar name={player.name} image={player.image} color={player.color} size="lg"/><div><span className="position-pill">{player.position}</span><h2 id="player-sheet-title">{player.name}</h2><p>{t(player.active?'Active':'Inactive')} · {t(squad.playerIds.indexOf(player.id)<11?'Starting XI':'Bench')}</p></div></div>
    <div className="sheet-stats"><div><small>{t('Price')}</small><strong>{formatMoney(player.price)}</strong></div><div><small>{t('Rating')}</small><strong>{player.rating}</strong></div><div><small>{t('Fantasy points')}</small><strong>{player.points}</strong></div></div>
    <p className="sheet-note">{t('Player points are static demo data.')}</p>
    {builder && <div className="sheet-captains"><button type="button" className={`button button-outline ${squad.captainId===player.id?'is-selected':''}`} aria-pressed={squad.captainId===player.id} disabled={squad.playerIds.indexOf(player.id)>=11} onClick={()=>setCaptain('captain')}>{t('Captain')}</button><button type="button" className={`button button-outline ${squad.viceCaptainId===player.id?'is-selected':''}`} aria-pressed={squad.viceCaptainId===player.id} disabled={squad.playerIds.indexOf(player.id)>=11} onClick={()=>setCaptain('vice')}>{t('Vice captain')}</button></div>}
    {!builder && !viewOnly && <div className="sheet-captains"><button type="button" className={`button button-outline ${squad.captainId===player.id?'is-selected':''}`} aria-pressed={squad.captainId===player.id} onClick={()=>setCaptain('captain')}>{t('Captain')}</button><button type="button" className={`button button-outline ${squad.viceCaptainId===player.id?'is-selected':''}`} aria-pressed={squad.viceCaptainId===player.id} onClick={()=>setCaptain('vice')}>{t('Vice captain')}</button></div>}
    {builder && replacing && <section className="replacement-section"><h3>{t('Select replacement')}</h3><p>{t('Choose an available player in the same position.')}</p>{!candidates.length?<p className="notice">{t('No available players in this position.')}</p>:<div className="replacement-list">{candidates.map(p=><button type="button" key={p.id} className={`replacement-row ${incomingId===p.id?'selected':''}`} aria-pressed={incomingId===p.id} onClick={()=>{setIncomingId(p.id);setMessage('');}}><Avatar name={p.name} image={p.image} color={p.color} size="sm"/><span><strong>{p.name}</strong><small>{p.position} · {p.rating} {t('OVR')}</small></span><b>{formatMoney(p.price)}</b></button>)}</div>}
      {incoming&&<div className="replacement-summary"><span>{t('After transfer')}: <strong>{formatMoney(Math.round((budget-currentValue+player.price-incoming.price)*100)/100)}</strong> {t('remaining')}</span>{(squad.captainId===player.id||squad.viceCaptainId===player.id)&&<p>{t('Replacing this player clears their captain or vice captain assignment.')}</p>}</div>}
      {(result?.error||message)&&<p className="error" role="alert">{t(errors[result?.error||message]||message)}</p>}
      <button type="button" className="button sheet-primary" disabled={!result?.squad} onClick={()=>{if(!incoming)return;const error=transfer(player.id,incoming.id);if(error)setMessage(error);else close();}}>{t('Confirm replacement')}</button>
    </section>}
    {builder?<><DetailLink className="button button-outline full-profile-action" to={`/players/${player.id}`} onClick={close}>{t('Full profile')}</DetailLink><div className="sheet-action-row"><button type="button" className="button" onClick={()=>{setReplacing(true);setIncomingId('');}} disabled={replacing||!marketOpen}>{t('Select replacement')}</button><button type="button" className="button button-danger" disabled={!marketOpen} onClick={remove}>{t('Remove')}</button></div></>:viewOnly
      ? <DetailLink className="button button-outline full-profile-action" to={`/players/${player.id}`} onClick={close}>{t('Full profile')}</DetailLink>
      : <div className="sheet-actions"><DetailLink className="button button-outline" to={`/players/${player.id}`} onClick={close}>{t('Full profile')}</DetailLink><button type="button" className="button" disabled={!canSwap} onClick={startSwap}><ArrowRightLeft size={16}/>{t('Make substitution')}</button></div>}
    {!builder&&!viewOnly&&!canSwap&&<p className="sheet-note">{t('No eligible swap preserves or improves your formation.')}</p>}
  </dialog>;
}
