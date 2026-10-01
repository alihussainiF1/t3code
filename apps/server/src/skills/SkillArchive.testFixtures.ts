/** Builds tar archives for skill install tests. */
const encoder = new TextEncoder();

export type TestEntry = {
  readonly path: string;
  readonly content?: string;
  readonly type?: "0" | "2" | "5";
  readonly link?: string;
  readonly mode?: number;
};

function header(name: string, size: number, type: string, link = "", mode = 0o644) {
  const block = new Uint8Array(512);
  const write = (value: string, offset: number) => block.set(encoder.encode(value), offset);
  write(name, 0);
  write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  write(type, 156);
  write(link, 157);
  write("ustar\0", 257);
  write("00", 263);
  write("        ", 148);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function padded(data: Uint8Array) {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
}

/** A ustar archive; paths over 100 bytes get a pax header like GitHub's. */
export function makeTar(entries: ReadonlyArray<TestEntry>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    if (entry.path.length > 100) {
      const record = ` path=${entry.path}\n`;
      let length = record.length + 2;
      while (`${length}${record}`.length !== length) length += 1;
      const pax = encoder.encode(`${length}${record}`);
      blocks.push(header("PaxHeader", pax.length, "x"), padded(pax));
    }
    const data = encoder.encode(entry.content ?? "");
    const type = entry.type ?? "0";
    blocks.push(
      header(
        entry.path.slice(0, 100),
        type === "0" ? data.length : 0,
        type,
        entry.link,
        entry.mode,
      ),
    );
    if (type === "0") blocks.push(padded(data));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return archive;
}
