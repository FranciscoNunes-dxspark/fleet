import { Link, useLocation } from 'react-router-dom';
import { Logo } from '../ui.jsx';
import { t } from '../i18n.js';
import { Button } from '@radix-ui/themes';

/** An address Keel doesn't have (an old link, a typo): say so, instead of quietly going home. */
export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="page not-found">
      <Logo mood="worried" size={72} />
      <h1>{t("There's no page here.")}</h1>
      <p className="muted">{t("Keel has nothing at {path}. The link may be old, or the page may have moved.", { path: pathname })}</p>
      <Button asChild size="2" variant="solid"><Link to="/">{t('Go to Keel')}</Link></Button>
    </div>
  );
}
