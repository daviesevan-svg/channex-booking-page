// Minimal single-entry ZIP writer — no dependencies. Google requires the list
// feeds delivered as a .zip URL; Workers have no zip library, but a one-file
// archive is just: [local file header][deflated data][central directory][EOCD].
// Deflate comes from the native CompressionStream; CRC-32 is the standard
// reflected polynomial (0xEDB88320) over the UNCOMPRESSED bytes.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Current time as MS-DOS date/time fields (what ZIP headers store). */
function dosDateTime(): { time: number; date: number } {
  const d = new Date();
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** Build a ZIP archive containing a single deflated file. */
export async function zipSingleFile(name: string, data: Uint8Array): Promise<Uint8Array> {
  const nameBytes = new TextEncoder().encode(name);
  const crc = crc32(data);
  const comp = await deflateRaw(data);
  const { time, date } = dosDateTime();

  const out = new Uint8Array(30 + nameBytes.length + comp.length + 46 + nameBytes.length + 22);
  const view = new DataView(out.buffer);
  let p = 0;
  const u16 = (v: number) => { view.setUint16(p, v, true); p += 2; };
  const u32 = (v: number) => { view.setUint32(p, v >>> 0, true); p += 4; };
  const bytes = (b: Uint8Array) => { out.set(b, p); p += b.length; };

  // Local file header
  u32(0x04034b50);
  u16(20); // version needed: 2.0 (deflate)
  u16(0); // flags
  u16(8); // method: deflate
  u16(time); u16(date);
  u32(crc);
  u32(comp.length);
  u32(data.length);
  u16(nameBytes.length);
  u16(0); // extra len
  bytes(nameBytes);
  bytes(comp);

  // Central directory
  const cdOffset = p;
  u32(0x02014b50);
  u16(20); // version made by
  u16(20); // version needed
  u16(0); u16(8); u16(time); u16(date);
  u32(crc);
  u32(comp.length);
  u32(data.length);
  u16(nameBytes.length);
  u16(0); u16(0); // extra, comment
  u16(0); // disk number
  u16(0); // internal attrs
  u32(0); // external attrs
  u32(0); // local header offset
  bytes(nameBytes);
  const cdSize = p - cdOffset;

  // End of central directory
  u32(0x06054b50);
  u16(0); u16(0); // disk numbers
  u16(1); u16(1); // entries (this disk / total)
  u32(cdSize);
  u32(cdOffset);
  u16(0); // comment len

  return out;
}
