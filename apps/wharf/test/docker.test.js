import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesOf, composeCommand, createDocker, dockerProblem, exitCodeOf, healthOf, hostPorts, labelsOf, parseContainers, parseImages, parseStats, safe, shortPorts } from '../src/docker.js';

const PS = [
  JSON.stringify({ ID: 'a1b2c3d4e5f6', Names: 'shop-web-1', Image: 'shop/web:1.4', State: 'running', Status: 'Up 2 hours (healthy)', Ports: '0.0.0.0:8080->80/tcp, :::8080->80/tcp', RunningFor: '2 days ago', Labels: 'com.docker.compose.project=shop,com.docker.compose.service=web' }),
  'WARNING: something Docker said first',
  JSON.stringify({ ID: 'b2c3d4e5f6a1', Names: 'redis', Image: 'redis:7', State: 'exited', Status: 'Exited (137) 3 minutes ago', Ports: '', RunningFor: '1 week ago', Labels: '' }),
].join('\n');

test('a docker ps listing: JSON lines, with compose labels, health, exit code and published ports', () => {
  const [web, redis] = parseContainers(PS);
  assert.deepEqual([web.id, web.name, web.image, web.state, web.project, web.service, web.health, web.hostPorts], ['a1b2c3d4e5f6', 'shop-web-1', 'shop/web:1.4', 'running', 'shop', 'web', 'healthy', [8080]]);
  assert.deepEqual([redis.state, redis.exitCode, redis.project, redis.health, redis.hostPorts], ['exited', 137, null, null, []]);
});

test('labels, health, exit codes and ports are read from the strings Docker prints', () => {
  assert.deepEqual(labelsOf('a=b,c=d=e,junk'), { a: 'b', c: 'd=e' });
  assert.equal(healthOf('Up 5 minutes (unhealthy)'), 'unhealthy');
  assert.equal(healthOf('Up 5 seconds (health: starting)'), 'starting');
  assert.equal(healthOf('Up 5 minutes'), null);
  assert.equal(exitCodeOf('Exited (0) 2 hours ago'), 0);
  assert.equal(exitCodeOf('Up 2 hours'), null);
  assert.deepEqual(hostPorts('0.0.0.0:8080->80/tcp, :::8080->80/tcp, 5432/tcp, 0.0.0.0:9000-9001->9000-9001/tcp'), [8080, 9000]);
  assert.equal(shortPorts('0.0.0.0:8080->80/tcp, :::8080->80/tcp, 5432/tcp'), '8080→80, 5432');
  assert.equal(shortPorts(''), '');
});

test('stats are keyed by short id, memory in bytes', () => {
  assert.equal(bytesOf('12.5MiB'), 13107200);
  assert.equal(bytesOf('1.5GB'), 1.5e9);
  assert.equal(bytesOf('nonsense'), null);
  const stats = parseStats(JSON.stringify({ ID: 'a1b2c3d4e5f6aaaaaaaa', CPUPerc: '12.34%', MemUsage: '100MiB / 1.9GiB', MemPerc: '5.1%' }));
  assert.deepEqual(stats.get('a1b2c3d4e5f6'), { cpu: 12.34, mem: 104857600, memPercent: 5.1 });
});

test('images: untagged ones are dangling', () => {
  const images = parseImages([JSON.stringify({ ID: 'x1', Repository: 'redis', Tag: '7', Size: '117MB', CreatedSince: '4 weeks ago' }), JSON.stringify({ ID: 'x2', Repository: '<none>', Tag: '<none>', Size: '1MB', CreatedSince: 'now' })].join('\n'));
  assert.deepEqual(images.map((i) => [i.repo, i.tag, i.dangling]), [['redis', '7', false], [null, null, true]]);
});

test("only names Docker could have made reach the shell", async () => {
  assert.ok(safe('shop-web-1') && safe('redis:7') && safe('a1b2c3d4e5f6') && safe('ghcr.io/me/app:1.0'));
  assert.ok(!safe('a; rm -rf /') && !safe('$(x)') && !safe('') && !safe('a b') && !safe('-f'));
  const calls = [];
  const docker = createDocker({ run: async (command) => (calls.push(command), { stdout: '', stderr: '' }) });
  await docker.act('stop', ['abc123', 'def456']);
  await docker.remove(['abc123'], { force: true });
  await docker.prune('images');
  assert.deepEqual(calls, ['docker stop abc123 def456', 'docker rm -f abc123', 'docker image prune -f']);
  await assert.rejects(docker.act('stop', ['x; echo hi']), /isn't a container/);
  await assert.rejects(docker.act('rm -rf', ['abc123']), /Unknown action/);
});

test('logs come back with the container\'s stderr after its stdout', async () => {
  const docker = createDocker({ run: async (command) => ({ stdout: 'out\n', stderr: command.includes('--tail 5 ') ? 'err\n' : '' }) });
  assert.equal(await docker.logs('abc123', { tail: 5 }), 'out\nerr\n');
});

test('a missing or stopped Docker is explained', () => {
  assert.match(dockerProblem("'docker' is not recognized as an internal or external command"), /isn't installed/);
  assert.match(dockerProblem('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'), /isn't running/);
  assert.match(dockerProblem('error during connect: open //./pipe/docker_engine: The system cannot find the file specified.'), /isn't running/);
  assert.equal(dockerProblem('No such container: x'), null);
});

test('compose commands run where the project\'s files are, and refuse paths that could end the quoting', async () => {
  const where = { project: 'shop', workingDir: 'C:\srv\my shop', configFiles: 'C:\srv\my shop\compose.yaml,C:\srv\my shop\override.yaml' };
  assert.equal(composeCommand('up', where), 'docker compose -p shop --project-directory "C:\srv\my shop" -f "C:\srv\my shop\compose.yaml" -f "C:\srv\my shop\override.yaml" up -d');
  assert.equal(composeCommand('down', { project: 'shop' }), 'docker compose -p shop down');
  assert.throws(() => composeCommand('up', { project: 'shop', workingDir: 'a"; rm -rf /' }), /isn't a path/);
  assert.throws(() => composeCommand('nuke', where), /Unknown action/);
  assert.throws(() => composeCommand('up', { project: 'a; b' }), /isn't a container/);
  const calls = [];
  const docker = createDocker({ run: async (command, opts) => (calls.push([command, opts.cwd]), { stdout: '', stderr: 'Container shop-web-1 Started\n' }) });
  assert.equal(await docker.compose('up', where), 'Container shop-web-1 Started\n');
  assert.equal(calls[0][1], 'C:\srv\my shop');
  await docker.exec('abc123', 'ls -la /app');
  assert.equal(calls[1][0], 'docker exec abc123 ls -la /app');
});
