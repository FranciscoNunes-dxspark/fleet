import { useEffect, useState } from 'react';
import { AlertDialog, Button, RadioGroup, TextArea, TextField } from '@radix-ui/themes';
import { useApi } from './context.js';
import { t } from './i18n.js';
import { Checkbox, Loading, Select, buttonLook } from './ui.jsx';
import { useBackCloses } from './touch.js';

// A pipeline's parameters in the web app's run forms and confirmations: every option of each in view.

/**
 * One parameter of a run: every option it takes in view (a list as radios, or a menu when it's
 * long), a tick for true or false, else a field. Its name shows under its label when they differ.
 */
export function RunParameter({ p, value, onChange }) {
  const id = `run-param-${p.name}`;
  const label = (
    <span className="run-param-label">
      {p.label}{p.label !== p.name && <code className="muted small"> {p.name}</code>}
    </span>
  );
  if (p.type === 'boolean') {
    return <label className="check"><Checkbox checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} /> {label}</label>;
  }
  if (p.options.length > 8) {
    return (
      <label className="field">{label}
        <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={p.label}>
          {!p.options.includes(value) && <option value="">—</option>}
          {p.options.map((o) => <option key={o} value={o}>{o === p.default ? t('{value} (default)', { value: o }) : o}</option>)}
        </Select>
      </label>
    );
  }
  if (p.options.length) {
    return (
      <div className="field" role="group" aria-labelledby={id}>
        <span id={id}>{label}</span>
        <RadioGroup.Root size="1" value={value} onValueChange={onChange}>
          {p.options.map((o) => <RadioGroup.Item key={o} value={o}>{o === p.default ? t('{value} (default)', { value: o }) : o}</RadioGroup.Item>)}
        </RadioGroup.Root>
      </div>
    );
  }
  if (p.type === 'object') {
    return <label className="field">{label}<TextArea className="mono" size="1" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} /></label>;
  }
  return (
    <label className="field">{label}
      <TextField.Root variant="surface" color="gray" type={p.type === 'number' ? 'number' : 'text'} value={value} onChange={(e) => onChange(e.target.value)} required={p.required && p.default == null} spellCheck={false} />
    </label>
  );
}

/** The parameters to send: only those changed from their defaults (the pipeline sets the rest itself). */
export function changedParameters(params, values) {
  return Object.fromEntries((params || [])
    .filter((p) => values[p.name] !== undefined && values[p.name] !== (p.default ?? ''))
    .map((p) => [p.name, values[p.name]]));
}

/**
 * A run button whose confirmation lists the pipeline's parameters on that branch, read when it opens,
 * each with every option it takes and its default picked, or `initial`'s value (Run again: the values
 * the run it repeats was given). `onRun(parameters)` gets those changed from their defaults.
 */
export function RunConfirm({ projectId, definitionId, branch, initial, text, className = 'btn btn-small', onRun, children }) {
  const [open, setOpen] = useState(false);
  useBackCloses(open, () => setOpen(false));
  const path = open && definitionId != null
    ? `/pipelines/${encodeURIComponent(projectId)}/${encodeURIComponent(definitionId)}/parameters${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`
    : null;
  const { data: params, error } = useApi(path);
  const [values, setValues] = useState({});
  // Each time it opens, from the defaults again, or what the earlier run was given (for parameters it still has).
  const given = JSON.stringify(initial || {});
  useEffect(() => {
    if (!open || !params) return;
    const known = new Set(params.map((p) => p.name));
    setValues(Object.fromEntries(Object.entries(JSON.parse(given)).filter(([k]) => known.has(k)).map(([k, v]) => [k, String(v)])));
  }, [open, params, given]);
  const valueOf = (p) => values[p.name] ?? p.default ?? '';
  const missing = (params || []).some((p) => p.required && p.default == null && !String(valueOf(p)).trim());
  const loading = open && !params && !error;
  const reused = !!params?.length && Object.keys(initial || {}).some((k) => params.some((p) => p.name === k));
  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger><Button type="button" {...buttonLook(className)}>{children}</Button></AlertDialog.Trigger>
      <AlertDialog.Content size="1" className="confirm-pop run-pop" aria-describedby={undefined}>
        <AlertDialog.Title size="3" mb="0">{text}</AlertDialog.Title>
        {loading && <Loading label={t('Reading its parameters…')} />}
        {params?.length > 0 && (
          <fieldset className="field run-params">
            <legend>{t('Parameters')}</legend>
            {reused && <span className="muted small">{t('As the run it repeats had them.')}</span>}
            {params.map((p) => <RunParameter key={p.name} p={p} value={valueOf(p)} onChange={(v) => setValues((prev) => ({ ...prev, [p.name]: v }))} />)}
          </fieldset>
        )}
        <span className="confirm-actions">
          <AlertDialog.Cancel><Button size="2" variant="soft" color="gray" type="button">{t('Cancel')}</Button></AlertDialog.Cancel>
          <AlertDialog.Action><Button size="2" variant="solid" color="red" type="button" disabled={loading || missing} onClick={() => onRun(changedParameters(params, values))}>{t('Yes')}</Button></AlertDialog.Action>
        </span>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
