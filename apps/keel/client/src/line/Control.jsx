// The Control room: Keel as a live status wall, made to stay open (full screen, on a second
// screen or a TV). A tile per production service (state, response, the day's checks, its latest
// deploy and what's waiting to ship to it), the pipelines' recent runs, and a timeline of the
// last 24 hours running down the side: runs, deploys, outages, approvals, merges. It follows
// Keel's live updates like every page. The tiles and timeline come from views.js.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi, useApp } from '../context.js';
import { age } from '../format.js';
import { Loading } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { locale, t } from '../i18n.js';
import { buildTimeline, serviceTiles } from './views.js';
import { useLine } from './LineShell.jsx';
import { Button } from '@radix-ui/themes';

const stateName = (s) => ({ up: t('Up'), down: t('Down'), degraded: t('Degraded'), deploying: t('Deploying'), settling: t('Just deployed') })[s] || t('Not checked yet');
const time = (iso) => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

function eventText(e) {
  switch (e.code) {
    case 'run': return {
      succeeded: t('{name} passed', { name: e.name }), failed: t('{name} failed', { name: e.name }),
      partiallySucceeded: t('{name} partly passed', { name: e.name }), canceled: t('{name} was canceled', { name: e.name }),
    }[e.result] || e.name;
    case 'deploy': return t('{label} deployed to {name}', { label: e.label, name: e.name });
    case 'down': return t('{name} went down', { name: e.name });
    case 'regression': return t('Failures rose on {name} after {label}', { name: e.name, label: e.label });
    case 'approval': return t('{name} is waiting for approval', { name: e.name });
    case 'merged': return t('Merged: {name}', { name: e.name });
    default: return '';
  }
}

export default function Control() {
  const { data, loading } = useLine();
  const { openDrawer } = useApp();
  const navigate = useNavigate();
  const closed = useApi('/prs/closed?days=7');
  const wall = useRef(null);
  const [full, setFull] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    const onFull = () => setFull(document.fullscreenElement === wall.current);
    document.addEventListener('fullscreenchange', onFull);
    return () => { clearInterval(timer); document.removeEventListener('fullscreenchange', onFull); };
  }, []);

  const tiles = useMemo(() => serviceTiles(data, now), [data, now]);
  const events = useMemo(() => buildTimeline({ ...data, closed: closed.data }, now), [data, closed.data, now]);
  const pipes = useMemo(() => [...(data.pipelines || [])].sort((a, b) => (b.health === 'failing') - (a.health === 'failing') || (b.running?.length > 0) - (a.running?.length > 0)), [data.pipelines]);

  if (!data.production && loading) return <Loading />;

  const down = tiles.filter((x) => x.state === 'down').length;
  const degraded = tiles.filter((x) => x.state === 'degraded').length;
  const sameDay = (iso) => new Date(iso).toDateString() === new Date(now).toDateString();
  const today = (code, pick = () => true) => events.filter((e) => e.code === code && sameDay(e.at) && pick(e)).length;
  const tone = down ? 'bad' : degraded ? 'warn' : 'ok';
  const headline = down ? t(down === 1 ? '1 service is down' : '{n} services are down', { n: down })
    : degraded ? t(degraded === 1 ? '1 service is degraded' : '{n} services are degraded', { n: degraded })
      : t('All services up');
  const open = (e) => (e.open ? openDrawer(e.open) : e.link && navigate(e.link));

  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : wall.current?.requestFullscreen?.());

  return (
    <div className="control" ref={wall}>
      <header className="control-head">
        <div className="control-clock">
          <span className="control-time">{new Date(now).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span>
          <span className="control-date">{new Date(now).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })}</span>
        </div>
        <div className={`control-status control-status-${tone}`} role="status">
          <span className="control-pulse" aria-hidden="true" />
          {headline}
        </div>
        <dl className="control-today">
          <div><dt>{t('Deploys today')}</dt><dd>{today('deploy')}</dd></div>
          <div><dt>{t('Merged today')}</dt><dd>{today('merged')}</dd></div>
          <div><dt>{t('Failed runs today')}</dt><dd className={today('run', (e) => e.result === 'failed') ? 'text-bad' : ''}>{today('run', (e) => e.result === 'failed')}</dd></div>
        </dl>
        <Button size="1" variant="outline" color="gray" className="control-full" type="button" onClick={toggleFull}>
          <Icon name={full ? 'collapse' : 'expand'} size={14} /> {full ? t('Leave full screen') : t('Full screen')}
        </Button>
      </header>

      <div className="control-body">
        <div className="control-main">
          <h2 className="control-h">{t('Services')}</h2>
          {!tiles.length && <p className="muted">{t('No production monitors yet. Add them in Settings.')}</p>}
          <ol className="tiles">
            {tiles.map((tile) => <ServiceTile key={tile.id} tile={tile} onOpen={() => navigate('/production')} />)}
          </ol>

          <h2 className="control-h">{t('Pipelines')}</h2>
          <ol className="pipe-strip">
            {pipes.map((p) => (
              <li key={p.key}>
                <button type="button" className={`pipe pipe-${p.health}${p.running?.length ? ' pipe-running' : ''}`} onClick={() => openDrawer({ type: 'pipeline', key: p.key })}>
                  <span className="pipe-name truncate">{p.definition.name}</span>
                  <span className="pipe-runs" aria-hidden="true">
                    {(p.recent || []).slice(0, 12).reverse().map((r) => <span key={r.id} className={`lc-run lc-run-${r.result === 'succeeded' ? 'ok' : r.result === 'failed' ? 'bad' : r.result === 'partiallySucceeded' ? 'warn' : 'idle'}`} />)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>

        <aside className="timeline" aria-label={t('The last 24 hours')}>
          <h2 className="control-h">{t('The last 24 hours')}</h2>
          {!events.length && <p className="muted small">{t('Nothing has happened yet today.')}</p>}
          <ol>
            {events.map((e) => (
              <li key={e.key} className={`ev ev-${e.tone}`}>
                <button type="button" onClick={() => open(e)}>
                  <time dateTime={e.at}>{time(e.at)}</time>
                  <span className="ev-dot" aria-hidden="true" />
                  <span className="ev-text">
                    <span className="ev-title">{eventText(e)}</span>
                    {(e.repo || e.by || e.label) && (
                      <span className="ev-sub">{[e.code === 'run' ? e.label : null, e.repo, e.by].filter(Boolean).join(' · ')}</span>
                    )}
                  </span>
                  {e.mine && <span className="lc-you">{t('You')}</span>}
                </button>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}

/** One production service: its state, response, the day's checks as a sparkline, and what's next for it. */
export function ServiceTile({ tile, onOpen }) {
  const max = Math.max(1, ...tile.checks.map((c) => c.ms || 0));
  const w = 160;
  const h = 34;
  const step = tile.checks.length > 1 ? w / (tile.checks.length - 1) : w;
  const points = tile.checks.map((c, i) => `${(i * step).toFixed(1)},${(h - ((c.ms || 0) / max) * (h - 4) - 2).toFixed(1)}`).join(' ');
  const Tag = onOpen ? 'button' : 'div';
  return (
    <li className={`tile tile-${tile.state}`}>
      <Tag {...(onOpen ? { type: 'button', onClick: onOpen } : {})} className="tile-hit">
        <span className="tile-top">
          <span className="tile-name truncate">{tile.name}</span>
          <span className="tile-state">{stateName(tile.state)}</span>
        </span>
        <span className="tile-figures">
          <span className="tile-big">{tile.latency != null ? <>{tile.latency}<small>ms</small></> : '—'}</span>
          {tile.uptime != null && <span className="tile-uptime">{t('{pct} up', { pct: `${Math.round(tile.uptime * 1000) / 10}%` })}</span>}
        </span>
        {tile.checks.length > 1 && (
          <svg className="tile-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
            <polyline points={points} />
            {tile.checks.map((c, i) => (!c.ok ? <rect key={i} x={i * step - 1} y={0} width={2} height={h} className="tile-fail" /> : null))}
          </svg>
        )}
        {tile.db && (
          <span className={`tile-db small${tile.db.failRate >= 0.05 ? ' text-bad' : ' muted'}`}>
            {t('Database: p95 {ms}, {pct} failing', { ms: tile.db.p95 == null ? '—' : tile.db.p95 >= 1000 ? `${(tile.db.p95 / 1000).toFixed(1)}s` : `${Math.round(tile.db.p95)}ms`, pct: `${Math.round(tile.db.failRate * 1000) / 10}%` })}
          </span>
        )}
        <span className="tile-foot">
          {tile.deploying
            ? <span className="tile-deploying">{t('Deploying {label}', { label: tile.deploying.label })}</span>
            : tile.lastDeploy && <span>{t('{label}, {age}', { label: tile.lastDeploy.label, age: age(tile.lastDeploy.at) })}</span>}
          {tile.waiting > 0 && <span className="tile-waiting">{t(tile.waiting === 1 ? '1 change waiting' : '{n} changes waiting', { n: tile.waiting })}</span>}
        </span>
      </Tag>
    </li>
  );
}
