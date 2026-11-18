import { parse } from 'yaml';

/**
 * A manual run's parameters, from the pipeline's own YAML: Azure DevOps' runtime `parameters:`
 * at the top of the file, or a GitHub workflow's `on.workflow_dispatch.inputs`. Each comes as
 * `{ name, label, type, default, options, required }`: `type` is string, number, boolean or
 * object (an object's value is YAML text), and `options` every value it may take, in the
 * file's order ([] when any value goes; a boolean's are true and false). Parameters a run
 * can't set by hand (steps, jobs, stages and their lists) are left out, as Azure DevOps' own
 * run form leaves them out. Text that isn't YAML, or has no parameters, gives [].
 */
export function pipelineParameters(text) {
  const doc = read(text);
  if (!doc) return [];
  // YAML 1.1 reads a bare `on:` as true; the yaml package keeps it as the string "on".
  const on = doc.on ?? doc.true;
  if (on && typeof on === 'object' && !Array.isArray(on)) return workflowInputs(on.workflow_dispatch?.inputs);
  return runtimeParameters(doc.parameters);
}

const SETTABLE = new Set(['string', 'number', 'boolean', 'object']);

function runtimeParameters(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p === 'object' && typeof p.name === 'string' && p.name)
    .map((p) => ({ ...p, type: String(p.type || 'string').toLowerCase() }))
    .filter((p) => SETTABLE.has(p.type))
    .map((p) => ({
      name: p.name,
      label: p.displayName ? String(p.displayName) : p.name,
      type: p.type,
      default: p.default === undefined ? null : text(p.default, p.type),
      options: p.type === 'boolean' ? ['true', 'false'] : Array.isArray(p.values) ? p.values.map((v) => text(v, p.type)) : [],
      // Azure DevOps asks for a value only when the parameter has no default.
      required: p.default === undefined,
    }));
}

function workflowInputs(inputs) {
  if (!inputs || typeof inputs !== 'object') return [];
  return Object.entries(inputs).map(([name, i]) => {
    const spec = i && typeof i === 'object' ? i : {};
    const kind = String(spec.type || 'string').toLowerCase();
    const type = kind === 'boolean' || kind === 'number' ? kind : 'string';
    return {
      name,
      label: spec.description ? String(spec.description) : name,
      type,
      default: spec.default === undefined ? null : text(spec.default, type),
      options: type === 'boolean' ? ['true', 'false'] : kind === 'choice' && Array.isArray(spec.options) ? spec.options.map((v) => text(v, type)) : [],
      required: spec.required === true,
    };
  });
}

function read(source) {
  if (typeof source !== 'string' || !source.trim()) return null;
  try {
    const doc = parse(source, { uniqueKeys: false });
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** A value as the run form shows it and the run sends it: text, an object's as YAML (JSON is YAML too). */
function text(v, type) {
  if (type === 'object' && v && typeof v === 'object') return JSON.stringify(v);
  return v == null ? '' : String(v);
}

/**
 * The parameters to send with a manual run, checked against the pipeline's: each a name it has
 * (any case), a value among its options when it lists them, true or false for a boolean, a number
 * for a number. Values left at their default aren't sent (the pipeline uses its default anyway).
 * Throws, naming the options, on anything else.
 */
export function parameterValues(params, given) {
  if (!given || typeof given !== 'object') return {};
  const out = {};
  for (const [name, raw] of Object.entries(given)) {
    if (raw == null) continue;
    const p = params.find((x) => x.name === name) || params.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (!p) {
      const names = params.map((x) => x.name).join(', ');
      throw bad(`This pipeline has no parameter "${name}". ${names ? `Its parameters: ${names}.` : 'It has no parameters.'}`);
    }
    let value = typeof raw === 'string' ? raw : String(raw);
    if (p.type === 'boolean') {
      const v = value.trim().toLowerCase();
      if (!['true', 'false'].includes(v)) throw bad(`${p.name} is true or false, not "${value}".`);
      value = v;
    } else if (p.type === 'number' && (value.trim() === '' || !Number.isFinite(Number(value)))) {
      throw bad(`${p.name} is a number, not "${value}".`);
    }
    if (p.options.length && p.type !== 'boolean') {
      const match = p.options.find((o) => o === value) ?? p.options.find((o) => o.toLowerCase() === value.toLowerCase());
      if (match === undefined) throw bad(`${p.name} can't be "${value}". Its options: ${p.options.join(', ')}.`);
      value = match;
    }
    if (value === p.default) continue;
    out[p.name] = value;
  }
  for (const p of params) {
    if (p.required && p.default == null && !(p.name in out)) throw bad(`${p.name} needs a value${p.options.length ? `: one of ${p.options.join(', ')}` : ''}.`);
  }
  return out;
}

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}
