const DATA_PREFIX = 'data: ';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const { [key]: value } = record;
  return typeof value === 'string' ? value : undefined;
}

export function getNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const { [key]: value } = record;
  return typeof value === 'number' ? value : undefined;
}

export function getRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const { [key]: value } = record;
  return isRecord(value) ? value : undefined;
}

export function getRecords(
  record: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const { [key]: value } = record;
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is Record<string, unknown> => isRecord(item));
}

export async function* streamSsePayloads(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  yield* readSsePayloadChunks(reader, decoder, '');
}

async function* readSsePayloadChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: string,
): AsyncIterable<string> {
  const { done, value } = await reader.read();
  if (done) {
    return;
  }

  const nextBuffer = buffer + decoder.decode(value, { stream: true });
  const lines = nextBuffer.split('\n');
  const pendingBuffer = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(DATA_PREFIX)) {
      continue;
    }

    yield trimmed.slice(DATA_PREFIX.length);
  }

  yield* readSsePayloadChunks(reader, decoder, pendingBuffer);
}
