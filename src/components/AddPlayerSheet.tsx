import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Avatar } from './UI';
import { formatMoney } from '../utils/format';
import type { Player, Position } from '../types';

type Props={position:Position;players:Player[];selectedIds:string[];remaining:number;marketOpen:boolean;addPlayer:(player:Player)=>string|null;close:()=>void};
const errors:Record<string,string>={squadFull:'Your squad is full.',overBudget:'Not enough budget.',positionFull:'This position is full.',alreadySelected:'Player already selected.',marketClosed:'The market is closed.',inactive:'Inactive players cannot be selected.',wrongLeague:'Select players from the current league.'};
export function AddPlayerSheet({position,players,selectedIds,remaining,marketOpen,addPlayer,close}:Props){
  const {t}=useTranslation();const dialog=useRef<HTMLDialogElement>(null);const [error,setError]=useState('');
  useEffect(()=>{if(dialog.current&&!dialog.current.open)dialog.current.showModal();},[]);
  const candidates=players.filter(p=>p.position===position&&p.active&&!selectedIds.includes(p.id));
  return <dialog ref={dialog} className="player-sheet add-player-sheet" aria-labelledby="add-player-title" onClose={close} onClick={e=>{if(e.target===e.currentTarget)close();}}>
    <div className="sheet-handle" aria-hidden="true"/><button type="button" className="sheet-close" aria-label={t('Close')} onClick={close}><X size={20}/></button>
    <div className="eyebrow">{t('THE MARKET')}</div><h2 id="add-player-title">{t('Add player')} · {position}</h2>
    <p className="sheet-note">{t('Choose an available player in this position.')} · {t('Budget remaining')}: <strong>{formatMoney(remaining)}</strong></p>
    {!marketOpen&&<p className="error" role="status">{t('The market is closed.')}</p>}
    {!candidates.length?<p className="notice">{t('No available players in this position.')}</p>:<div className="replacement-list add-player-list">{candidates.map(p=><button type="button" key={p.id} className="replacement-row" onClick={()=>{const result=addPlayer(p);if(result)setError(errors[result]||result);else close();}}><Avatar name={p.name} image={p.image} color={p.color} size="sm"/><span><strong>{p.name}</strong><small>{p.position} · {p.rating} {t('OVR')}</small></span><b>{formatMoney(p.price)}</b></button>)}</div>}
    {error&&<p className="error" role="alert">{t(error)}</p>}
  </dialog>;
}
