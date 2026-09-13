export interface Tag {
  name: string;
  definition: string;
  color: string;
  shortcut: string;
}

export interface Annotations {
  rows: Record<string, string[]>;
  cells: Record<string, Record<string, string[]>>;
  columns: Record<string, string[]>;
  dataset: string[];
}

export interface ParsedData {
  headers: string[];
  rows: string[][];
  rowCount: number;
  columnCount: number;
}