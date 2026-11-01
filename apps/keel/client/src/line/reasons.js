// Why a card is where it is, as a sentence: shared by the web app (with its t()) and the server's
// posts to Teams and Slack (with server/i18n.js translator's t), so both say the same thing.
// English text is the key, as everywhere; the Portuguese is in locales/pt/.

/** The stages' names, as English keys for t(). */
export const STAGE_NAMES = { planned: 'Planned', building: 'Building', review: 'In review', merged: 'Merged', deploying: 'Deploying', live: 'Live' };

/** A card's reason ({ code, … } from stages.js) as a sentence, through `t`. */
export function reasonText(r, t) {
  if (!r) return '';
  switch (r.code) {
    case 'p1-waiting': return t('P1, not started for {n} days', { n: r.days });
    case 'blocked': return t('Blocked');
    case 'quiet': return t('No update for {n} days', { n: r.days });
    case 'conflicts': return t('Merge conflicts');
    case 'stale': return t('Open {n} days', { n: r.days });
    case 'pr-in-review': return t('In review');
    case 'pr-approved': return t('Approved');
    case 'pr-waiting-author': return t('Waiting on author');
    case 'pr-rejected': return t('Rejected');
    case 'pr-draft': return t('Draft');
    case 'pr-no-reviewers': return t('No reviewers');
    case 'waiting-changes': return t(r.n === 1 ? '1 change waiting' : '{n} changes waiting', { n: r.n });
    case 'approval-yours': return t('Waiting for your approval');
    case 'approval': return t('Waiting for approval');
    case 'deploying': return t('Deploying');
    case 'red': return t(r.n === 1 ? 'Red on its last run' : 'Red, {n} runs in a row', { n: r.n });
    case 'running': return t('Running');
    case 'monitor-up': return t('Up');
    case 'monitor-down': return t('Down');
    case 'monitor-degraded': return t('Degraded');
    case 'monitor-deploying': return t('Deploying');
    case 'monitor-settling': return t('Just deployed');
    default: return '';
  }
}
