export async function writeAll(
  writer: { write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }> },
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await writer.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("write made no progress");
    offset += bytesWritten;
  }
}
