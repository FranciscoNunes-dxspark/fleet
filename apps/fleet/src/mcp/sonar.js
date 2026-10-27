// Sonar's side: Application Insights, through Sonar's own Azure provider (azure/arm.js) and the
// Azure CLI's sign-in (azure/az.js, `az account get-access-token`, as Sonar gets its tokens), and
// Sonar's own queries (insights.js). Only reads: listing subscriptions and components, and the query
// API, which can't change anything; a query that starts with a control command (`.`) is refused too.
import { ToolError } from '@fleet/kit/mcp.js';
import { count, line } from './bound.js';

const SPANS = [
  [1, 'PT1H', 'hour'],
  [24, 'P1D', '24 hours'],
  [168, 'P7D', '7 days'],
  [720, 'P30D', '30 days'],
];
/** The span Sonar offers that covers `hours`: [hours, ISO duration, words]. */
export const spanOf = (hours) => SPANS.find(([h]) => h >= (Number(hours) || 24)) ?? SPANS.at(-1);

/**
 * Sonar's provider, made once per server: the demo's with `demo`, else real Azure. `override` is
 * for the tests.
 */
export function sonarSide({ demo = false, override } = {}) {
  let made = null;
  const provider = async () => {
    if (override) return override;
    if (made) return made;
    if (demo) {
      const { demoAzure } = await import('../../../sonar/src/demo.js');
      return (made = demoAzure());
    }
    const [{ createAzure }, { currentSubscription, token }] = await Promise.all([import('../../../sonar/src/azure/arm.js'), import('../../../sonar/src/azure/az.js')]);
    return (made = { ...createAzure({ token }), currentSubscription });
  };

  // Sign-in trouble says what to do: az login, which Sonar needs as well.
  const azure = async (what, fn) => {
    try {
      return await fn(await provider());
    } catch (e) {
      if (e instanceof ToolError) throw e;
      const msg = String(e.message ?? e);
      if (/az login|not signed in|not installed/i.test(msg)) throw new ToolError(`${msg}. Sign in with az login (or open Sonar once, which says what it needs), then ask again.`);
      throw new ToolError(`${what}: ${msg.split('\n')[0]}`);
    }
  };

  /** The subscription asked for (by id or name), else Sonar's last one (its config), else az's own. */
  const subscriptionOf = (asked) =>
    azure('Finding the subscription', async (p) => {
      if (asked) {
        const subs = await p.subscriptions();
        const a = String(asked).toLowerCase();
        const s = subs.find((x) => x.id.toLowerCase() === a || x.name.toLowerCase() === a);
        if (!s) throw new ToolError(`No subscription called ${asked}. Yours: ${subs.map((x) => `${x.name} (${x.id})`).join(', ')}.`);
        return s;
      }
      if (!demo && !override) {
        const { loadConfig } = await import('../../../sonar/src/config.js');
        const saved = loadConfig().subscription;
        if (saved) return { id: saved, name: saved };
      }
      const current = await p.currentSubscription();
      if (!current) throw new ToolError('No subscription is selected: az account set --subscription <name>, or name one.');
      return current;
    });

  const components = new Map();
  const componentsOf = (sub) => {
    const hit = components.get(sub.id);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.list;
    const list = azure('Listing Application Insights', (p) => p.components(sub.id));
    components.set(sub.id, { at: Date.now(), list });
    list.catch(() => components.delete(sub.id));
    return list;
  };

  const componentOf = async ({ component, subscription }) => {
    const sub = await subscriptionOf(subscription);
    const list = await componentsOf(sub);
    if (!component) {
      if (list.length === 1) return list[0];
      throw new ToolError(`Which Application Insights? ${sub.name} has ${list.map((c) => c.name).join(', ') || 'none'}. sonar_components lists them.`);
    }
    const c = String(component).toLowerCase();
    const found = list.find((x) => x.name.toLowerCase() === c || x.appId?.toLowerCase() === c) ?? list.find((x) => x.name.toLowerCase().includes(c));
    if (!found) throw new ToolError(`No Application Insights called ${component} in ${sub.name}. There: ${list.map((x) => x.name).join(', ') || 'none'}.`);
    return found;
  };

  const query = async (comp, kql, hours) => {
    const [, iso] = spanOf(hours);
    const { columns, rows } = await azure(`Querying ${comp.name}`, (p) => p.query(comp, kql, { timespan: iso }));
    return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i]])));
  };

  const insights = () => import('../../../sonar/src/insights.js');

  const common = {
    component: { type: 'string', description: 'The Application Insights component (its name, from sonar_components; optional when there is one)' },
    subscription: { type: 'string', description: "A subscription's name or id (default: Sonar's last, else az's current)" },
    hours: { type: 'integer', description: 'How far back: 1, 24 (default), 168 or 720 hours' },
  };

  return [
    {
      name: 'sonar_components',
      description: "The Application Insights components in an Azure subscription (Sonar's, else the Azure CLI's current one): what the other sonar tools look at. Also lists the subscriptions you can see.",
      inputSchema: { type: 'object', properties: { subscription: common.subscription } },
      async run({ subscription }) {
        const sub = await subscriptionOf(subscription);
        const list = await componentsOf(sub);
        const subs = await azure('Listing subscriptions', (p) => p.subscriptions()).catch(() => []);
        return [
          `Subscription ${sub.name}${sub.name !== sub.id ? ` (${sub.id})` : ''}: ${list.length} Application Insights component${list.length === 1 ? '' : 's'}`,
          ...list.map((c) => `  ${c.name}  (resource group ${c.resourceGroup || '?'})`),
          ...(subs.length > 1 ? ['', `Other subscriptions: ${subs.filter((s) => s.id !== sub.id).map((s) => s.name).join(', ')}`] : []),
        ].join('\n');
      },
    },
    {
      name: 'sonar_problems',
      description: "Sonar's Problems: the exceptions an Application Insights component recorded, grouped by problem (type and place), most frequent first: count, users affected, first and last seen, the message, the app (role) and the latest operation id.",
      inputSchema: { type: 'object', properties: { ...common, role: { type: 'string', description: 'Only this app (cloud role name)' } } },
      async run(args) {
        const comp = await componentOf(args);
        const { problemsQuery } = await insights();
        const rows = await query(comp, problemsQuery(args.role ?? null), args.hours);
        const [, , words] = spanOf(args.hours);
        if (!rows.length) return `No exceptions in ${comp.name} in the last ${words}.`;
        return [
          `${comp.name}: ${rows.length} problem${rows.length === 1 ? '' : 's'} in the last ${words}`,
          ...rows.map((r) => `${r.count}× (${r.users} user${r.users === 1 ? '' : 's'})  ${r.type}  in ${r.role ?? '?'}  first ${r.first}, last ${r.last}\n    ${line(r.message, 300)}\n    problem_id: ${r.problemId}  operation: ${r.operation}`),
        ].join('\n');
      },
    },
    {
      name: 'sonar_incident',
      description:
        "One problem told whole, as Sonar's incident view does: its latest exception (message, method, stack frames), everything in that occurrence's operation in order (requests, dependencies, traces), and the SQL calls that failed alongside it.",
      inputSchema: { type: 'object', properties: { ...common, problem_id: { type: 'string', description: 'The problem id, from sonar_problems' } }, required: ['problem_id'] },
      async run(args) {
        if (!args.problem_id) throw new ToolError('Which problem? sonar_problems gives each one its problem_id.');
        const comp = await componentOf(args);
        const [{ latestExceptionQuery, operationQuery, sqlDependenciesQuery, cellText }, { framesOf }] = await Promise.all([insights(), import('../../../sonar/src/incident.js')]);
        const [latest] = await query(comp, latestExceptionQuery(args.problem_id), args.hours);
        if (!latest) return `No occurrence of ${args.problem_id} in ${comp.name} in the last ${spanOf(args.hours)[2]}.`;
        const [rows, sql] = await Promise.all([query(comp, operationQuery(latest.operation_Id), args.hours), query(comp, sqlDependenciesQuery(args.problem_id), args.hours).catch(() => [])]);
        const frames = framesOf(latest.details);
        return [
          `${latest.type} at ${latest.timestamp} in ${latest.cloud_RoleName ?? '?'}`,
          line(latest.outerMessage, 1000),
          latest.method ? `method: ${latest.method}` : null,
          '',
          'Stack:',
          ...(frames.length ? frames.slice(0, 40).map((f) => `  ${f.method ?? '?'}  ${f.file}${f.line ? `:${f.line}` : ''}`) : ['  (no frames)']),
          '',
          `The operation ${latest.operation_Id}:`,
          ...rows.slice(0, 200).map((r) => `  ${cellText(r.timestamp, 'datetime').slice(11)}  ${String(r.itemType).padEnd(11)} ${line(r.name, 150)}  ${line(r.detail, 200)}${r.duration != null ? `  ${Math.round(r.duration)} ms` : ''}${r.success === false ? '  FAILED' : ''}`),
          ...(sql.length ? ['', 'SQL that failed in its operations:', ...sql.map((s) => `  ${s.count}×  ${s.target}  result ${s.resultCode}  ${line(s.data, 300)}`)] : []),
        ]
          .filter((x) => x != null)
          .join('\n');
      },
    },
    {
      name: 'sonar_query',
      description: `Runs a KQL query against an Application Insights component (tables: requests, dependencies, exceptions, traces, customEvents, pageViews, availabilityResults…), as Sonar's Logs view does, and returns the rows. Read-only: the query API can't change anything. Keep results small (take, summarize).`,
      inputSchema: {
        type: 'object',
        properties: { ...common, kql: { type: 'string', description: 'The KQL query' }, max_rows: { type: 'integer', description: 'Rows to return (default 100, at most 1000)' } },
        required: ['kql'],
      },
      async run(args) {
        const kql = String(args.kql ?? '').trim();
        if (!kql) throw new ToolError('The query is empty.');
        if (kql.startsWith('.')) throw new ToolError('Control commands are refused: only queries read.');
        const comp = await componentOf(args);
        const { cellText } = await insights();
        const [, iso] = spanOf(args.hours);
        const { columns, rows } = await azure(`Querying ${comp.name}`, (p) => p.query(comp, kql, { timespan: iso }));
        const max = count(args.max_rows, 100, 1000);
        const head = columns.map((c) => c.name).join(' | ');
        const body = rows.slice(0, max).map((r) => r.map((v, i) => line(cellText(v, columns[i].type), 300)).join(' | '));
        return [head, ...body, rows.length > max ? `(first ${max} of ${rows.length} rows)` : `(${rows.length} row${rows.length === 1 ? '' : 's'})`].join('\n');
      },
    },
  ];
}
