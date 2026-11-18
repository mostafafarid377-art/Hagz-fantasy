import { useState, useLayoutEffect, useRef } from 'react';
import { useImageSource } from '../hooks/useImageSource';
import { formatMoney } from '../utils/format';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, ChevronRight, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DetailLink } from './Navigation';
import type { Player } from '../types';
import { useDemo } from '../hooks/useDemo';
import { ownershipCount } from '../services/market';
export function SectionHead({eyebrow,title,action,to}:{eyebrow?:string;title:string;action?:string;to?:string}){const {t}=useTranslation();return <div className="section-head"><div>{eyebrow&&<div className="eyebrow">{t(eyebrow)}</div>}<h2>{t(title)}</h2></div>{action&&to&&<Link className="text-link" to={to}>{t(action)} <ArrowUpRight size={15}/></Link>}</div>}
function AvatarImage({source, initials}:{source?:string;initials:string}) {
  const [broken, setBroken] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  // An image can fail before React observes its error event (notably in WebKit).
  // Check completed images after attachment as well as listening for later errors.
  useLayoutEffect(() => {
    const element = image.current;
    if (element?.complete && element.naturalWidth === 0) setBroken(true);
  }, []);
  return source && !broken ? <img ref={image} src={source} alt="" onError={()=>setBroken(true)}/> : <span>{initials}</span>;
}
export function Avatar({name,color='#9caf9b',image,size='md'}:{name:string;color?:string;image?:string;size?:'sm'|'md'|'lg'}){const source=useImageSource(image);const initials=name.split(' ').map(n=>n[0]).slice(0,2).join('');return <div className={`avatar avatar-${size}`} style={{background:color}}><AvatarImage key={source} source={source} initials={initials}/></div>}
export function Badge({children,kind='neutral'}:{children:React.ReactNode;kind?:string}){return <span className={`badge badge-${kind}`}>{children}</span>}
export function PlayerCard({player}:{player:Player}){const {t}=useTranslation();const {squad,addPlayer,removePlayer,state,league}=useDemo();const selected=squad.playerIds.includes(player.id);const ownership=ownershipCount(player.id,league.id,state.squads);return <div className="player-card"><div className="player-card-top"><div><span className="position-pill">{player.position}</span><div className="player-rating">{player.rating}<small>{t('OVR')}</small></div></div><Avatar name={player.name} image={player.image} color={player.color} size="lg"/><DetailLink to={`/players/${player.id}`} className="icon-button player-open" aria-label={`${t('See player')} ${player.name}`}><ArrowUpRight size={17}/></DetailLink></div><DetailLink to={`/players/${player.id}`} className="player-name">{player.name}</DetailLink><div className="player-meta"><span>{player.position} <span className="dot">·</span> {player.points} {t('pts')} <span className="dot">·</span> {t(player.active?'Active':'Inactive')}</span><span><Users size={13}/> {ownership}</span></div><div className="player-card-bottom"><div><small>{t('PRICE')}</small><strong>{formatMoney(player.price)}</strong></div><button disabled={!selected&&!player.active} className={selected?'button button-muted':'button button-small'} onClick={()=>{if(selected)removePlayer(player.id);else {const error=league.marketOpen?addPlayer(player):'marketClosed';if(error)window.alert(t(({squadFull:'Your squad is full.',overBudget:'Not enough budget.',positionFull:'This position is full.',alreadySelected:'Player already selected.',marketClosed:'The market is closed.',inactive:'Inactive players cannot be selected.',wrongLeague:'Select players from the current league.'} as Record<string,string>)[error]||error));}}}>{t(selected?'Remove':'Add to squad')}</button></div></div>}
export function PageTitle({eyebrow,title,description,children}:{eyebrow?:string;title:string;description?:string;children?:React.ReactNode}){const {t}=useTranslation();return <div className="page-title"><div>{eyebrow&&<div className="eyebrow">{t(eyebrow)}</div>}<h1>{t(title)}</h1>{description&&<p>{t(description)}</p>}</div>{children&&<div className="page-actions">{children}</div>}</div>}
export function Empty({title,description,to,action}:{title:string;description?:string;to?:string;action?:string}){const {t}=useTranslation();return <div className="empty"><div className="empty-icon"><Users/></div><h3>{t(title)}</h3>{description&&<p>{t(description)}</p>}{to&&action&&<Link className="button" to={to}>{t(action)} <ChevronRight size={16}/></Link>}</div>}
