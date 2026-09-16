import { Doc, Map as YMap, Text as YText, encodeStateAsUpdate } from '../../src/affine-media/vendor/yjs.mjs';

export function snapshot() {
  const doc = new Doc(), paragraph = new YMap(), database = new YMap();
  doc.getMap('blocks').set('paragraph', paragraph);
  paragraph.set('sys:flavour', 'affine:paragraph');
  paragraph.set('prop:text', new YText('synthetic-private-document'));
  doc.getMap('blocks').set('table', database);
  database.set('sys:flavour', 'affine:database');
  const data = { missing: Buffer.from(encodeStateAsUpdate(doc)).toString('base64'),
    state: 'AA==', timestamp: 12345 };
  doc.destroy(); return data;
}

export class FakeSocket extends EventTarget {
  constructor(options = {}) { super(); this.options = options; this.sent = []; this.closed = false; }
  packet(data) { queueMicrotask(() => { if (!this.closed) this.dispatchEvent(new MessageEvent('message', { data })); }); }
  accept() {
    this.options.onAccept?.(this);
    if (!this.options.stall) this.packet('0' + JSON.stringify({ sid: 'engine-id', upgrades: [], pingInterval: 25000, pingTimeout: 20000 }));
  }
  send(packet) {
    this.sent.push(packet); this.options.onSend?.(packet, this);
    if (packet === '40{}') {
      this.packet('2');
      this.packet('40' + JSON.stringify({ sid: 'namespace-id' }));
    } else if (packet.startsWith('420')) {
      this.packet('430' + JSON.stringify([this.options.join ?? { data: { success: true, clientId: 'namespace-id' } }]));
    } else if (packet.startsWith('421')) {
      this.packet('42' + JSON.stringify(['space:broadcast-doc-updates', { private: 'ignored-event' }]));
      this.packet('431' + JSON.stringify([this.options.load ?? { data: snapshot() }]));
    }
  }
  close() { this.closed = true; }
}
