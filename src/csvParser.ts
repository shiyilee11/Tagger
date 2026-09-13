import type { ParsedData } from "./types";

export function parseDelimited(text: string, delimiter: string): ParsedData {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (!quoted && char === delimiter) {
      row.push(value);
      value = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value);
      value = "";
      if (row.some((cell) => cell.length > 0) || rows.length > 0)
        rows.push(row);
      row = [];
    } else value += char;
  }
  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return normalizeRows(rows);
}

function normalizeRows(rows: string[][]): ParsedData {
  const normalized = rows.length ? rows : [[""]];
  const headers = normalized[0].map(
    (header, index) => header.trim() || `Column ${index + 1}`,
  );
  const dataRows = normalized
    .slice(1)
    .map((cells) => headers.map((_, index) => cells[index] ?? ""));
  return {
    headers,
    rows: dataRows,
    rowCount: dataRows.length,
    columnCount: headers.length,
  };
}

export async function parseDelimitedFile(
  file: File,
  delimiter: string,
  onProgress?: (progress: number) => void,
): Promise<ParsedData> {
  if (!file.stream) return parseDelimited(await file.text(), delimiter);
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  let skipLineFeed = false;
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let lastYield = 0;

  const consume = (chunk: string) => {
    for (let index = 0; index < chunk.length; index += 1) {
      const char = chunk[index];
      const next = chunk[index + 1];
      if (skipLineFeed) {
        skipLineFeed = false;
        if (char === "\n") continue;
      }
      if (char === '"') {
        if (quoted && next === '"') {
          value += '"';
          index += 1;
        } else quoted = !quoted;
      } else if (!quoted && char === delimiter) {
        row.push(value);
        value = "";
      } else if (!quoted && (char === "\n" || char === "\r")) {
        row.push(value);
        value = "";
        if (char === "\r") skipLineFeed = true;
        if (row.some((cell) => cell.length > 0) || rows.length > 0)
          rows.push(row);
        row = [];
      } else value += char;
    }
  };

  onProgress?.(0);
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    bytesRead += chunk.byteLength;
    consume(decoder.decode(chunk, { stream: true }));
    if (bytesRead - lastYield >= 512 * 1024) {
      lastYield = bytesRead;
      onProgress?.(file.size ? Math.round((bytesRead / file.size) * 100) : 0);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  consume(decoder.decode());
  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  onProgress?.(100);
  return normalizeRows(rows);
}
