/* RadDeck — minimal zip reader (stored + deflate) using the platform DecompressionStream.
 * openZip(ArrayBuffer | Uint8Array) -> { names: string[], has(name), read(name): Promise<Uint8Array> }
 */
(function (root) {
  "use strict";

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function openZip(input) {
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dec = new TextDecoder();

    // End of central directory record
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a zip file.");
    let count = dv.getUint16(eocd + 10, true);
    let cdOffset = dv.getUint32(eocd + 16, true);

    // Zip64 (large packages)
    if (count === 0xffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
        const z64 = Number(dv.getBigUint64(loc + 8, true));
        count = Number(dv.getBigUint64(z64 + 32, true));
        cdOffset = Number(dv.getBigUint64(z64 + 48, true));
      }
    }

    const entries = new Map();
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt zip directory.");
      const method = dv.getUint16(p + 10, true);
      let csize = dv.getUint32(p + 20, true);
      let usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      let offset = dv.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
      // zip64 extra field
      if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) {
        let q = p + 46 + nlen;
        const end = q + elen;
        while (q + 4 <= end) {
          const id = dv.getUint16(q, true), sz = dv.getUint16(q + 2, true);
          if (id === 0x0001) {
            let r = q + 4;
            if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(r, true)); r += 8; }
            if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(r, true)); r += 8; }
            if (offset === 0xffffffff) { offset = Number(dv.getBigUint64(r, true)); r += 8; }
          }
          q += 4 + sz;
        }
      }
      entries.set(name, { method, csize, usize, offset });
      p += 46 + nlen + elen + clen;
    }

    async function read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`No "${name}" in zip`);
      if (dv.getUint32(e.offset, true) !== 0x04034b50) throw new Error("Corrupt zip entry.");
      const nlen = dv.getUint16(e.offset + 26, true);
      const elen = dv.getUint16(e.offset + 28, true);
      const start = e.offset + 30 + nlen + elen;
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) return inflateRaw(data);
      throw new Error(`Unsupported zip compression method ${e.method}`);
    }

    return { names: [...entries.keys()], has: (n) => entries.has(n), read, size: (n) => (entries.get(n) || {}).usize };
  }

  root.openZip = openZip;
})(typeof window !== "undefined" ? window : globalThis);
