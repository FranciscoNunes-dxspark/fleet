// Standup mode (Team → On the line → Start standup): the team one person at a time, full
// screen, then the team's blockers. Each slide is what moved for that person since the previous
// working day, what they hold on the Line now, what of it is stuck and the reviews waiting on them.
// A timer per person shows when time's up and moves on by itself only when asked to. The rules
// are pure in standup.js; the Line's cards come from the shell (LineShell.jsx).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@radix-ui/themes';
import { useApi, useApp } from '../context.js';
import { useSticky } from '../sticky.js';
import { Avatar, Checkbox, Loading, Select, useTypeColor } from '../ui.jsx';
import { locale, t } from '../i18n.js';
import { useLine } from './LineShell.jsx';
import { Card, useOpenCard } from './Line.jsx';
import { stageName } from './names.js';
import { previousWorkingDay, slideCounts, standupSlides, teamBlockers } from './standup.js';
import './standup.css';

const MINUTES = [1, 2, 3, 5];
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** What moved for one person: a row per thing, newest first, each opening in the details panel. */
function Moved({ slide, open }) {
  const m = slide.moved;
  const rows = [
    ...m.finished.map((x) => ({ x, label: t('Finished'), tone: 'ok', sub: `${x.type} ${x.id} · ${x.projectName}` })),
    ...m.merged.map((x) => ({ x, label: t('Merged'), tone: 'ok', sub: `${x.repoName} · !${x.id}` })),
    ...m.changed.map((x) => ({ x, label: t('Now {state}', { state: x.state }), tone: 'info', sub: `${x.type} ${x.id} · ${x.projectName}` })),
    ...m.opened.map((x) => ({ x, label: t('Opened'), tone: 'info', sub: `${x.repoName} · !${x.id}` })),
    ...m.reviewed.map((x) => ({ x, label: t('Reviewed'), tone: 'info', sub: `${x.repoName} · !${x.id}` })),
  ];
  if (!rows.length) return <p className="muted">{t('Nothing moved.')}</p>;
  return (
    <ul className="standup-moved">
      {rows.map(({ x, label, tone, sub }) => (
        <li key={`${label}:${x.key}`}>
          <button type="button" className="standup-row" onClick={() => open(x)}>
            <span className={`standup-tag standup-tag-${tone}`}>{label}</span>
            <span className="standup-row-title">{x.title}</span>
            <span className="standup-row-sub muted">{sub}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function Standup() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const teamKey = params.get('team') || '';
  const { stages, loading } = useLine();
  const { drawer } = useApp();
  const team = useApi('/team');
  const open = useOpenCard();
  const typeColor = useTypeColor();
  // Fixed when the standup starts, so a standup that runs past midnight keeps its day.
  const since = useMemo(() => previousWorkingDay(), []);
  const raw = useApi(`/standup?since=${encodeURIComponent(since.toISOString())}`);
  const [minutes, setMinutes] = useSticky('standup.minutes', 2);
  const [auto, setAuto] = useSticky('standup.auto', false);
  const [index, setIndex] = useState(0);
  const [started, setStarted] = useState(() => Date.now());
  const [paused, setPaused] = useState(null); // when it was paused, or null
  const [now, setNow] = useState(() => Date.now());
  const [full, setFull] = useState(false);
  const root = useRef(null);

  // The people to walk through: the team picked on the Team page, else everyone in the tracked teams.
  const members = useMemo(() => {
    const rows = team.data?.rows;
    if (!rows?.length) return null;
    const inTeam = (p) => !teamKey || (p.teams || []).some((x) => `${x.projectId}:${x.teamId}` === teamKey);
    return rows.map((r) => r.person).filter(inTeam);
  }, [team.data, teamKey]);
  const slides = useMemo(
    () => standupSlides({ stages, raw: raw.data || {}, since: since.getTime(), members }),
    [stages, raw.data, since, members],
  );
  const blockers = useMemo(() => teamBlockers(stages, members), [stages, members]);
  const count = slides.length + 1; // the people, then the blockers
  const at = Math.min(index, count - 1);
  const slide = slides[at] || null;

  const go = useCallback((i) => {
    setIndex(Math.max(0, Math.min(count - 1, i)));
    setStarted(Date.now());
    setPaused(null);
  }, [count]);
  const close = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    navigate(teamKey ? `/people?team=${encodeURIComponent(teamKey)}` : '/people');
  }, [navigate, teamKey]);

  const limit = minutes * 60_000;
  const elapsed = (paused ?? now) - started;
  const over = !!slide && elapsed >= limit;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    const onFull = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', onFull);
    return () => { clearInterval(timer); document.removeEventListener('fullscreenchange', onFull); };
  }, []);

  // Moving on by itself only when asked to, and never past the blockers.
  useEffect(() => {
    if (auto && over && !paused && at < count - 1) go(at + 1);
  }, [auto, over, paused, at, count, go]);

  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen?.());
  const togglePause = () => {
    if (paused) {
      setStarted((s) => s + (Date.now() - paused));
      setPaused(null);
    } else setPaused(Date.now());
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, select, textarea, [role="dialog"]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) go(at + 1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) go(at - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(count - 1);
      else if (e.key === 'p') togglePause();
      else if (e.key === 'f') toggleFull();
      else if (e.key === 'Escape' && !document.fullscreenElement && !drawer) close();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const day = since.toLocaleDateString(locale(), { weekday: 'long' });
  const ready = !(loading && !stages.some((s) => s.count)) && !(raw.loading && !raw.data);

  return (
    <div className="standup" ref={root} role="region" aria-label={t('Standup')}>
      <header className="standup-bar">
        <strong className="standup-title">{t('Standup')}</strong>
        <span className="muted">{t('Since {day}', { day })}</span>
        <ol className="standup-people" aria-label={t('People')}>
          {slides.map((s, i) => (
            <li key={s.key}>
              <button type="button" className={`standup-dot${i === at ? ' on' : ''}${s.stuck.length ? ' has-stuck' : ''}`} onClick={() => go(i)} title={s.person?.displayName} aria-current={i === at || undefined}>
                <Avatar person={s.person} size={24} />
              </button>
            </li>
          ))}
          <li>
            <button type="button" className={`standup-dot standup-dot-end${at === count - 1 ? ' on' : ''}`} onClick={() => go(count - 1)} aria-current={at === count - 1 || undefined}>{t('Blockers')}</button>
          </li>
        </ol>
        <span className="standup-controls">
          <label className="standup-inline">{t('Per person')}
            <Select className="input" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label={t('Minutes per person')}>
              {MINUTES.map((m) => <option key={m} value={m}>{t('{n} min', { n: m })}</option>)}
            </Select>
          </label>
          <label className="check standup-inline"><Checkbox checked={!!auto} onChange={(e) => setAuto(e.target.checked)} /> {t('Move on when time is up')}</label>
          <Button size="1" variant="soft" color="gray" type="button" onClick={toggleFull}>{full ? t('Exit full screen') : t('Full screen')}</Button>
          <Button size="1" variant="soft" color="gray" type="button" onClick={close}>{t('End standup')}</Button>
        </span>
      </header>

      {!ready ? <Loading /> : slide ? (
        <main className="standup-slide" key={slide.key}>
          <div className="standup-who">
            <Avatar person={slide.person} size={56} />
            <div>
              <h1 className="standup-name">{slide.person?.displayName}</h1>
              <p className="muted">{t('{i} of {n}', { i: at + 1, n: slides.length })}</p>
            </div>
            <div className={`standup-timer${over ? ' over' : ''}${paused ? ' paused' : ''}`} aria-live="polite">
              <span className="standup-clock">{over ? t("Time's up") : clock(limit - elapsed)}</span>
              <Button size="1" variant="ghost" color="gray" type="button" onClick={togglePause}>{paused ? t('Resume') : t('Pause')}</Button>
            </div>
          </div>

          {slide.quiet ? (
            <p className="standup-quiet">{t('Nothing on the Line for {name}, and nothing moved since {day}.', { name: slide.person?.displayName, day })}</p>
          ) : (
            <div className="standup-cols">
              <section>
                <h2 className="section-title">{t('Since {day}', { day })}</h2>
                <Moved slide={slide} open={open} />
              </section>
              <section>
                <h2 className="section-title">{t('On the Line now')}</h2>
                <ul className="standup-holding">
                  {['planned', 'building', 'review'].map((id) => (
                    <li key={id}><span className="standup-n">{slide.holding[id].length}</span> {stageName(id)}</li>
                  ))}
                </ul>
                {slide.stuck.length > 0 ? (
                  <>
                    <h3 className="standup-sub text-bad">{t(slide.stuck.length === 1 ? '1 stuck' : '{n} stuck', { n: slide.stuck.length })}</h3>
                    <ol className="cards">
                      {slide.stuck.map((card) => <Card key={card.key} card={card} onOpen={open} drawer={drawer} typeColor={typeColor} />)}
                    </ol>
                  </>
                ) : slideCounts(slide).holding > 0 && <p className="muted">{t('Nothing stuck.')}</p>}
              </section>
              <section>
                <h2 className="section-title">{t('Reviews owed')}</h2>
                {slide.reviews.length ? (
                  <ol className="cards">
                    {slide.reviews.map((card) => <Card key={card.key} card={card} onOpen={open} drawer={drawer} typeColor={typeColor} />)}
                  </ol>
                ) : <p className="muted">{t('No reviews waiting.')}</p>}
              </section>
            </div>
          )}
        </main>
      ) : (
        <main className="standup-slide">
          <div className="standup-who">
            <div>
              <h1 className="standup-name">{t('Blockers')}</h1>
              <p className="muted">{t('Everything stuck on the Line, worst and oldest first.')}</p>
            </div>
          </div>
          {blockers.length ? (
            <ol className="cards cards-grid">
              {blockers.map((card) => (
                <Card key={card.key} card={card} onOpen={open} drawer={drawer} typeColor={typeColor} />
              ))}
            </ol>
          ) : <p className="standup-quiet">{t('Nothing is stuck. Good standup.')}</p>}
          {blockers.some((c) => !c.person && (c.kind === 'workitem' || c.kind === 'pr')) && (
            <p className="muted">{t('Cards without a face are stuck work nobody holds.')}</p>
          )}
        </main>
      )}

      <footer className="standup-foot muted">
        <Button size="1" variant="soft" color="gray" type="button" onClick={() => go(at - 1)} disabled={at === 0}>{t('Previous')}</Button>
        <span>{t('Arrow keys move, P pauses, F is full screen, Esc ends.')}</span>
        <Button size="1" variant="solid" type="button" onClick={() => go(at + 1)} disabled={at === count - 1}>{at === slides.length - 1 ? t('Blockers') : t('Next')}</Button>
      </footer>
    </div>
  );
}
