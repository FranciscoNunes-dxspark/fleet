import { app } from './app.js';

// The compiled builds have the version baked in by scripts/build.js; from a checkout, the app's
// package.json is read (configureApp in app.js). Releases are versioned when they're built, so a
// checkout's package.json lags behind them.

/** This app's version: "1.2.3". */
export const version = () => app().VERSION;

/** True in the single-file executables, false when running from a checkout. */
export const compiled = () => app().COMPILED;
