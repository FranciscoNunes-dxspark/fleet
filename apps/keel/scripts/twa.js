// The twa-manifest.json Bubblewrap builds Keel's Android app from (scripts/build-android.mjs),
// derived from the web app's manifest so the icon, name, colours and shortcuts stay the same.

/** Bubblewrap's twa-manifest.json for Keel served at `host`, from client/public/manifest.webmanifest. */
export function twaManifest({ host, packageId, versionCode, versionName, webManifest, keystore }) {
  const url = (p) => new URL(p, `https://${host}`).href;
  const icon = (purpose) => webManifest.icons.filter((i) => i.purpose === purpose).sort((a, b) => parseInt(b.sizes) - parseInt(a.sizes))[0];
  return {
    packageId,
    host,
    name: webManifest.name,
    launcherName: webManifest.short_name || webManifest.name,
    display: webManifest.display,
    themeColor: webManifest.theme_color,
    themeColorDark: webManifest.theme_color,
    navigationColor: webManifest.theme_color,
    navigationColorDark: webManifest.theme_color,
    navigationDividerColor: webManifest.theme_color,
    navigationDividerColorDark: webManifest.theme_color,
    backgroundColor: webManifest.background_color,
    // Push notifications (server/push.js) show as the app's, through Chrome's notification delegation.
    enableNotifications: true,
    startUrl: webManifest.start_url,
    iconUrl: url(icon('any').src),
    maskableIconUrl: url(icon('maskable').src),
    // The white silhouette also used for the status bar badge on the web.
    monochromeIconUrl: url('/icons/badge-96.png'),
    splashScreenFadeOutDuration: 300,
    signingKey: { path: keystore.path, alias: keystore.alias },
    appVersionCode: versionCode,
    appVersion: versionName,
    shortcuts: (webManifest.shortcuts || []).map((s) => ({ name: s.name, shortName: s.name, url: url(s.url), chosenIconUrl: url(s.icons[0].src) })),
    generatorApp: 'bubblewrap-cli',
    webManifestUrl: url('/manifest.webmanifest'),
    fallbackType: 'customtabs',
    features: {},
    alphaDependencies: { enabled: false },
    enableSiteSettingsShortcut: true,
    isChromeOSOnly: false,
    isMetaQuest: false,
    fullScopeUrl: url(webManifest.scope || '/'),
    minSdkVersion: 21,
    orientation: 'default',
    fingerprints: [],
    additionalTrustedOrigins: [],
    retainedBundles: [],
  };
}
