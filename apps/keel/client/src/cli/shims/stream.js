import { EventEmitter } from './events.js';

export class Stream extends EventEmitter {}
export class Readable extends Stream {}
export class Writable extends Stream {}
export class PassThrough extends Stream {}
export default { Stream, Readable, Writable, PassThrough };
