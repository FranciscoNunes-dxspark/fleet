// Claude proposes, the person presses ↵: `propose` is the one tool of `fleet mcp` that writes, and what
// it writes changes nothing by itself. It leaves a line for one app's prompt in the family's folder
// (../proposals.js), which Fleet shows in its bar and its proposals panel (the prefix and P); ↵ there
// types the line into the app's prompt, and only the person's own ↵ in the app runs it.
// `proposal_status` says what became of one.
import { APP_NAMES, FAMILY } from '@fleet/kit/family.js';
import { ToolError } from '@fleet/kit/mcp.js';
import { stamp } from './bound.js';
import { MAX_AGE, MAX_LINE, checkProposal, readProposal, writeProposal } from '../proposals.js';

const minutes = Math.round(MAX_AGE / 60_000);

export const proposalTools = [
  {
    name: 'propose',
    description: `Proposes one line for an app's prompt, for the person to hand over in Fleet: it shows in Fleet's bar and its proposals panel (ctrl+b P), where ↵ types the line into that app's prompt (switching to it, starting it if need be) and the person's own ↵ there runs it. Nothing runs by itself, and the person may dismiss it. The line is a slash command of that app (${MAX_LINE} characters at most, one line, never a ! shell, SQL or git command); \`why\` is what the person reads before they decide. Secrets are masked. A proposal not acted on drops off after ${minutes} minutes. Returns its id, for proposal_status.`,
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', enum: FAMILY, description: 'The app whose prompt the line is for' },
        line: { type: 'string', description: 'The slash command, as typed into that app (it starts with /)' },
        why: { type: 'string', description: 'Why: one or two sentences the person reads first' },
      },
      required: ['app', 'line', 'why'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run(args) {
      const checked = checkProposal(args);
      if (!checked.ok) throw new ToolError(checked.error);
      const p = writeProposal(checked.proposal);
      return [
        `Proposed to ${APP_NAMES[p.app] ?? p.app}: ${p.line}`,
        `id: ${p.id}`,
        `It waits in Fleet (ctrl+b P) for the person to hand it over or dismiss it; nothing has run. proposal_status { id } says which.`,
      ].join('\n');
    },
  },
  {
    name: 'proposal_status',
    description: `What became of a proposal (from propose): still pending, handed to its app (typed into its prompt, for the person to run) or dismissed, and when. Proposals drop off after ${minutes} minutes.`,
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: "The proposal's id, as propose returned it" } }, required: ['id'] },
    annotations: { openWorldHint: false },
    run({ id }) {
      const p = readProposal(String(id ?? '').trim());
      if (!p) throw new ToolError(`No proposal ${id ?? ''}: the id is wrong, or it dropped off (after ${minutes} minutes).`);
      const status =
        p.status === 'handed'
          ? `handed to ${APP_NAMES[p.app] ?? p.app} at ${stamp(p.decidedAt)}: typed into its prompt, where the person runs it with ↵ (or doesn't)`
          : p.status === 'dismissed'
            ? `dismissed at ${stamp(p.decidedAt)}`
            : Date.now() - p.at > MAX_AGE
              ? 'dropped off: nobody acted on it in time'
              : 'pending: waiting in Fleet for the person';
      return [`Proposal ${p.id} for ${APP_NAMES[p.app] ?? p.app}, proposed ${stamp(p.at)}`, `line: ${p.line}`, `why: ${p.why}`, `status: ${status}`].join('\n');
    },
  },
];
