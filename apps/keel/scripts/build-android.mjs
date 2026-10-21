// Builds Keel's Android app with Bubblewrap: a Trusted Web Activity, so Chrome opens the Keel
// served at --host full screen, with its icon, shortcuts and push notifications. The app holds
// no code of Keel's own, so a deploy updates it too; rebuild only to change host, name or icon.
//   npm run build:android -- --keystore keel.keystore                 for https://keel.example.com
//   npm run build:android -- --host keel.example.com --package com.example.keel --keystore …
// Needs JDK 17 (JAVA_HOME) and the Android SDK (ANDROID_HOME), and the keystore's passwords in
// BUBBLEWRAP_KEYSTORE_PASSWORD and BUBBLEWRAP_KEY_PASSWORD. The host must already be serving Keel:
// Bubblewrap downloads the icons from it. Output: release/keel-android.apk (to install directly)
// and release/keel-android.aab (for Google Play).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { twaManifest } from './twa.js';

const BUBBLEWRAP = '@bubblewrap/cli@1.27.0';
// The build-tools that Bubblewrap version builds with (BUILD_TOOLS_VERSION in @bubblewrap/core).
const BUILD_TOOLS = '36.1.0';

const { values: opts } = parseArgs({
  options: {
    host: { type: 'string', default: 'keel.example.com' },
    package: { type: 'string', default: 'com.example.keel' },
    'version-code': { type: 'string', default: '1' },
    'version-name': { type: 'string' },
    keystore: { type: 'string' },
    alias: { type: 'string', default: 'keel' },
  },
});

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) fail(`${cmd} ${args[0]} failed.`);
  return result;
};

const root = path.resolve(import.meta.dirname, '..');
const versionCode = Number(opts['version-code']);
if (!Number.isInteger(versionCode) || versionCode < 1) fail('--version-code must be a whole number, 1 or more.');
if (!opts.keystore) fail('--keystore is required. Make one with: keytool -genkeypair -v -keystore keel.keystore -alias keel -keyalg RSA -keysize 2048 -validity 10000');
const keystore = path.resolve(opts.keystore);
if (!existsSync(keystore)) fail(`No keystore at ${keystore}.`);
const { BUBBLEWRAP_KEYSTORE_PASSWORD: storePass, BUBBLEWRAP_KEY_PASSWORD: keyPass } = process.env;
if (!storePass || !keyPass) fail('Set BUBBLEWRAP_KEYSTORE_PASSWORD and BUBBLEWRAP_KEY_PASSWORD to the keystore\'s passwords.');

// Bubblewrap asks to download its own JDK and SDK unless its config names them.
const jdk = process.env.JAVA_HOME;
if (!jdk || !/JAVA_VERSION="17\./.test(existsSync(path.join(jdk, 'release')) ? readFileSync(path.join(jdk, 'release'), 'utf8') : '')) {
  fail('Set JAVA_HOME to a JDK 17 (Bubblewrap needs that version).');
}
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk || !existsSync(sdk)) fail('Set ANDROID_HOME to the Android SDK.');
// Bubblewrap would install build-tools with the SDK's old tools/ folder, which current SDKs don't have.
if (!existsSync(path.join(sdk, 'build-tools', BUILD_TOOLS))) {
  const sdkmanager = path.join(sdk, 'cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager');
  if (!existsSync(sdkmanager)) fail(`Install the Android SDK's build-tools ${BUILD_TOOLS}, or its command-line tools so this can.`);
  run(sdkmanager, ['--install', `build-tools;${BUILD_TOOLS}`]);
}

const out = path.join(root, 'release');
const project = path.join(out, 'android');
rmSync(project, { recursive: true, force: true });
mkdirSync(project, { recursive: true });
const config = path.join(out, 'android-bubblewrap.json');
writeFileSync(config, JSON.stringify({ jdkPath: jdk, androidSdkPath: sdk }, null, 2));

const webManifest = JSON.parse(readFileSync(path.join(root, 'client/public/manifest.webmanifest'), 'utf8'));
const manifest = twaManifest({
  host: opts.host,
  packageId: opts.package,
  versionCode,
  versionName: opts['version-name'] || String(versionCode),
  webManifest,
  keystore: { path: keystore, alias: opts.alias },
});
writeFileSync(path.join(project, 'twa-manifest.json'), JSON.stringify(manifest, null, 2));

// Run from the project folder: Bubblewrap names its outputs relative to it.
const bubblewrap = (...args) => run('npx', ['--yes', BUBBLEWRAP, ...args, `--config=${config}`], { cwd: project });
bubblewrap('update', '--skipVersionUpgrade');
bubblewrap('build', '--skipPwaValidation');

copyFileSync(path.join(project, 'app-release-signed.apk'), path.join(out, 'keel-android.apk'));
copyFileSync(path.join(project, 'app-release-bundle.aab'), path.join(out, 'keel-android.aab'));

// The server vouches for the app with this certificate (server/android.js).
const listed = spawnSync(path.join(jdk, 'bin', 'keytool'), ['-list', '-v', '-keystore', keystore, '-alias', opts.alias, '-storepass', storePass], { encoding: 'utf8' });
const sha256 = listed.stdout?.match(/SHA256:\s*([0-9A-F:]{95})/i)?.[1];
console.log(`\nBuilt release/keel-android.apk and release/keel-android.aab (${opts.package} ${manifest.appVersion}, code ${versionCode}).`);
console.log(sha256
  ? `On the server at ${opts.host}, set ANDROID_PACKAGE=${opts.package} and ANDROID_CERT_SHA256=${sha256}`
  : 'Set ANDROID_PACKAGE and ANDROID_CERT_SHA256 (keytool -list -v shows the SHA256) on the server.');
