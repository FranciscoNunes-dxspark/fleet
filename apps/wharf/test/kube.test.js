import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageOf, createKube, deploymentOf, kubeProblem, parsePods, parseTop, safeName, statusOf } from '../src/kube.js';
import { findPod, podRows, podTone } from '../src/rows.js';
import { demoPods } from '../src/demokube.js';

const POD = (name, extra = {}) => ({
  metadata: { name, namespace: 'shop', creationTimestamp: '2026-10-27T08:00:00Z', ownerReferences: [{ kind: 'ReplicaSet', name: 'web-7d9f8b6c4d' }], ...extra.metadata },
  spec: { nodeName: 'node-1', containers: [{ name: 'app' }, { name: 'proxy' }] },
  status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 1, state: { running: {} } }, { name: 'proxy', ready: false, restartCount: 2, state: { running: {} } }], ...extra.status },
});

test('kubectl get pods -o json: status, ready, restarts and the deployment a pod belongs to', () => {
  const [web, crash, gone] = parsePods(
    JSON.stringify({
      items: [
        POD('web-7d9f8b6c4d-abcde'),
        POD('api-1', { status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 9, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } }),
        POD('old', { metadata: { deletionTimestamp: '2026-10-27T09:00:00Z' } }),
      ],
    }),
  );
  assert.deepEqual([web.name, web.namespace, web.status, web.ready, web.restarts, web.node, web.deployment], ['web-7d9f8b6c4d-abcde', 'shop', 'Running', '1/2', 3, 'node-1', 'web']);
  assert.deepEqual([crash.status, crash.restarts], ['CrashLoopBackOff', 9]);
  assert.equal(gone.status, 'Terminating');
  assert.throws(() => parsePods('error: nope'), /not JSON/);
  assert.equal(deploymentOf({ metadata: { ownerReferences: [{ kind: 'StatefulSet', name: 'db' }] } }), null);
  assert.equal(statusOf({ status: { phase: 'Pending', initContainerStatuses: [{ state: { waiting: { reason: 'PodInitializing' } } }] } }), 'PodInitializing');
  assert.equal(statusOf({ status: { containerStatuses: [{ state: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] } }), 'OOMKilled');
});

test('top, ages, and what the errors of a missing or unreachable kubectl mean', () => {
  const top = parseTop('shop   web-1   12m   64Mi\nmonitoring prom-0 250m 1Gi\n');
  assert.deepEqual(top.get('shop/web-1'), { cpu: 12, mem: 64 * 1024 * 1024 });
  assert.equal(top.get('monitoring/prom-0').mem, 1024 ** 3);
  assert.deepEqual([...parseTop('web-1 5m 10Mi', 'dev').keys()], ['dev/web-1']);
  const now = Date.parse('2026-10-27T12:00:00Z');
  assert.deepEqual(['2026-10-27T11:59:30Z', '2026-10-27T11:55:00Z', '2026-10-27T09:00:00Z', '2026-10-20T12:00:00Z', 'nonsense'].map((t) => ageOf(t, now)), ['30s', '5m', '3h', '7d', '']);
  assert.match(kubeProblem("'kubectl' is not recognized as an internal or external command"), /isn't installed/);
  assert.match(kubeProblem('Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout'), /can't be reached/);
  assert.match(kubeProblem('error: You must be logged in to the server (Unauthorized)'), /turned the credentials down/);
  assert.equal(kubeProblem('pods "x" not found'), null);
});

test('only names Kubernetes would have given reach the shell, and the commands are what kubectl takes', async () => {
  assert.ok(safeName('web-7d9f8b6c4d-abcde') && safeName('db-0') && safeName('a.b-c'));
  assert.ok(!safeName('Web') && !safeName('a; rm') && !safeName('-x') && !safeName('') && !safeName('a b'));
  const calls = [];
  const kube = createKube({ run: async (command) => (calls.push(command), { stdout: '{"items":[]}', stderr: '' }) });
  await kube.pods({ namespace: 'shop' });
  await kube.pods({ namespace: 'all' });
  await kube.logs({ namespace: 'shop', name: 'web-1' });
  await kube.logs({ namespace: 'shop', name: 'web-1' }, { container: 'proxy', tail: 50 });
  await kube.deletePod({ namespace: 'shop', name: 'web-1' });
  await kube.rolloutRestart('web', 'shop');
  await kube.useContext('aks-prod');
  assert.deepEqual(calls, [
    'kubectl get pods -n shop -o json',
    'kubectl get pods -A -o json',
    'kubectl logs --timestamps --tail 500 -n shop web-1 --all-containers=true',
    'kubectl logs --timestamps --tail 50 -n shop web-1 -c proxy',
    'kubectl delete pod -n shop web-1',
    'kubectl rollout restart deployment/web -n shop',
    'kubectl config use-context aks-prod',
  ]);
  await assert.rejects(kube.deletePod({ namespace: 'shop', name: 'x; echo hi' }), /isn't a name/);
  await assert.rejects(kube.pods({ namespace: 'a b' }), /isn't a name/);
  await assert.rejects(kube.useContext('x y'), /isn't a context/);
});

test('pods are listed by namespace with the ones that are not well first, and found by name or namespace/name', () => {
  const pods = demoPods();
  const rows = podRows(pods);
  assert.deepEqual(rows.filter((r) => r.heading).map((r) => r.heading), ['monitoring', 'shop']);
  assert.equal(rows[3].p.name, 'api-5c8d7f9b6-klmno');
  assert.deepEqual(pods.map(podTone).slice(0, 5), ['add', 'add', 'del', 'add', 'warn']);
  assert.equal(findPod(pods, 'db-0').name, 'db-0');
  assert.equal(findPod(pods, 'shop/db-0').name, 'db-0');
  assert.equal(findPod(pods, 'web-'), null);
  assert.equal(findPod(pods, 'prom').name, 'prometheus-0');
});
