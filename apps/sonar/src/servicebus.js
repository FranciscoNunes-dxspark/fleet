// Service Bus: namespaces and their queues, topics and subscriptions with their message counts (ARM),
// and the dead letters themselves (the namespace's own REST API, signed in with Entra): peeked by locking
// and unlocking them, so nothing is lost; resubmitted by sending a copy to the entity and completing the
// dead letter; purged by receiving and deleting. Pure: the provider makes the calls (azure/arm.js,
// demo.js).

const groupOf = (id) => /\/resourceGroups\/([^/]+)/i.exec(id ?? '')?.[1] ?? '';

/** A namespace (Microsoft.ServiceBus/namespaces): its address and tier. */
export function namespaceFrom(n) {
  const p = n.properties ?? {};
  const endpoint = p.serviceBusEndpoint ?? `https://${n.name}.servicebus.windows.net:443/`;
  return {
    type: 'servicebus',
    id: n.id,
    name: n.name,
    resourceGroup: groupOf(n.id),
    location: n.location,
    state: p.status ?? p.provisioningState ?? 'Unknown',
    sku: n.sku?.name ?? '',
    host: endpoint.replace(/^https?:\/\//, '').replace(/[:/].*$/, ''),
  };
}

/** A queue, topic or subscription (ARM's, with countDetails) as { kind, name, path, active, deadLetter, scheduled, … }. */
export function entityFrom(kind, e, topic = null) {
  const p = e.properties ?? {};
  const c = p.countDetails ?? {};
  return {
    kind,
    name: kind === 'subscription' ? `${topic}/${e.name}` : e.name,
    topic,
    // Where its messages are: a queue's name, or topic/subscriptions/name (a topic has none of its own).
    path: kind === 'subscription' ? `${topic}/subscriptions/${e.name}` : e.name,
    active: Number(c.activeMessageCount ?? (kind === 'topic' ? 0 : p.messageCount ?? 0)),
    deadLetter: Number(c.deadLetterMessageCount ?? 0),
    scheduled: Number(c.scheduledMessageCount ?? 0),
    transfer: Number(c.transferMessageCount ?? 0) + Number(c.transferDeadLetterMessageCount ?? 0),
    status: p.status ?? '',
    maxDelivery: p.maxDeliveryCount ?? null,
    subscriptions: kind === 'topic' ? Number(p.subscriptionCount ?? 0) : null,
  };
}

/** Where a dead letter queue's messages are read: <path>/$DeadLetterQueue. */
export const deadLetterPath = (entity) => `${entity.path}/$DeadLetterQueue`;

/** Where a resubmitted message goes: the queue itself, or the topic a subscription hangs off (its other subscriptions get it too). */
export const resubmitPath = (entity) => (entity.kind === 'subscription' ? entity.topic : entity.path);

// Headers every answer has, which aren't the message's own properties.
const NOT_PROPERTIES = new Set(['brokerproperties', 'content-type', 'content-length', 'location', 'date', 'server', 'transfer-encoding', 'strict-transport-security', 'connection', 'x-ms-request-id', 'request-context', 'cache-control', 'expires', 'pragma']);

/** A custom property's value as the REST API writes it: "quoted" strings, bare numbers and booleans. */
const propertyValue = (v) => {
  const s = String(v ?? '');
  if (/^".*"$/.test(s)) return s.slice(1, -1).replace(/\\"/g, '"');
  return s;
};

/** A peek-locked message ({ status, headers, text }) as { id, sequence, enqueued, deliveryCount, reason, description, label, contentType, properties, body, lock }. */
export function messageFrom({ headers, text }) {
  let broker = {};
  try {
    broker = JSON.parse(headers.get('brokerproperties') ?? '{}');
  } catch {}
  const properties = {};
  for (const [k, v] of headers) if (!NOT_PROPERTIES.has(k.toLowerCase())) properties[k] = propertyValue(v);
  const take = (name) => {
    const k = Object.keys(properties).find((x) => x.toLowerCase() === name.toLowerCase());
    return k ? properties[k] : '';
  };
  return {
    id: broker.MessageId ?? '',
    sequence: broker.SequenceNumber ?? null,
    enqueued: broker.EnqueuedTimeUtc ? new Date(broker.EnqueuedTimeUtc).toISOString() : null,
    deliveryCount: broker.DeliveryCount ?? null,
    label: broker.Label ?? '',
    correlationId: broker.CorrelationId ?? '',
    sessionId: broker.SessionId ?? '',
    contentType: headers.get('content-type') ?? '',
    reason: take('DeadLetterReason'),
    description: take('DeadLetterErrorDescription'),
    source: broker.DeadLetterSource ?? '',
    properties,
    body: text ?? '',
    broker,
    lock: headers.get('location') ?? null,
  };
}

/** The headers a resubmitted copy carries: its own broker properties (id, label, correlation, session…) and its custom properties, without the dead-lettering's. */
export function resendHeaders(m) {
  const keep = ['MessageId', 'Label', 'CorrelationId', 'SessionId', 'ReplyTo', 'ReplyToSessionId', 'To', 'PartitionKey', 'TimeToLive'];
  const broker = Object.fromEntries(keep.filter((k) => m.broker?.[k] != null && m.broker[k] !== '').map((k) => [k, m.broker[k]]));
  const props = Object.fromEntries(Object.entries(m.properties ?? {}).filter(([k]) => !/^DeadLetter(Reason|ErrorDescription)$/i.test(k)).map(([k, v]) => [k, /^-?\d+(\.\d+)?$|^(true|false)$/i.test(v) ? v : `"${String(v).replace(/"/g, '\\"')}"`]));
  return { ...(Object.keys(broker).length ? { BrokerProperties: JSON.stringify(broker) } : {}), ...(m.contentType ? { 'Content-Type': m.contentType } : {}), ...props };
}

/** Whether a body looks like it holds a secret (a key, a password, a token), so it's hidden until asked for. */
export const secretBody = (body) => /AccountKey=|SharedAccessSignature|Password=|"(password|secret|token|apiKey|api_key|accessKey|clientSecret)"\s*:|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(String(body ?? ''));

/** A body in one line for the list, at most `n` characters. */
export const bodyPreview = (body, n = 80) => {
  const s = String(body ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** What a namespace's entities hold in all: { active, deadLetter, scheduled }. */
export const totals = (entities) => (entities ?? []).reduce((t, e) => ({ active: t.active + e.active, deadLetter: t.deadLetter + e.deadLetter, scheduled: t.scheduled + e.scheduled }), { active: 0, deadLetter: 0, scheduled: 0 });

/** The data-plane role a 401/403 asks for, in words. */
export const busRoleNeeded = (ns, what) => `${what}: you need Azure Service Bus Data Owner (or Data Receiver to peek) on ${ns.name}; ARM's own roles don't reach messages`;
