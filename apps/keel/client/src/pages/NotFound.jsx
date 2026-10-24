import { Link, useLocation } from 'react-router-dom';
import { Pinch } from '../ui.jsx';
import { t } from '../i18n.js';

/** An address Keel doesn't have (an old link, a typo): say so, instead of quietly showing the Dashboard. */
export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="page not-found">
      <Pinch mood="worried" width={128} />
      <h1>{t("There's no page here.")}</h1>
      <p className="muted">{t("Keel has nothing at {path}. The link may be old, or the page may have moved.", { path: pathname })}</p>
      <Link to="/" className="btn btn-primary">{t('Go to the Dashboard')}</Link>
    </div>
  );
}
