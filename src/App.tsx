import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { basename } from "@tauri-apps/api/path";
import {
  open as openNativeFileDialog,
  save as saveNativeFileDialog,
} from "@tauri-apps/plugin-dialog";
import {
  readFile,
  readTextFile,
  stat,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import type { Annotations, ParsedData, Tag } from "./types";
import { parseDelimited, parseDelimitedFile as parseDelimitedFileOnMain } from "./csvParser";
import "./App.css";

type Scope = "cell" | "range" | "row" | "column" | "dataset";
type Theme = "light" | "dark";
type MarkStyle = "fill" | "dot";
type ExportOption = "both" | "csv" | "tags";
type TagDraft = Tag & { originalName?: string };
type CellRange = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};
type ColumnValueFilterMode = "include" | "exclude";
type WorkspaceFilters = {
  hiddenColumns: number[];
  columnFilters: Record<string, string>;
  columnValueSelections: Record<string, string[]>;
  columnValueFilterModes: Record<string, ColumnValueFilterMode>;
  columnTagFilters: Record<string, string>;
};
type ArchiveSlot = {
  fileName: string;
  filePath: string | null;
  delimiter: string;
  sizeBytes?: number;
  data: ParsedData;
  tags: Record<string, Tag>;
  annotations: Annotations;
  filters: WorkspaceFilters;
  updatedAt: number;
};
type WorkspaceSnapshot = {
  data: ParsedData;
  tags: Record<string, Tag>;
  annotations: Annotations;
  filters: WorkspaceFilters;
};
type WorkspaceState = Pick<WorkspaceSnapshot, "tags" | "annotations" | "filters">;
type ArchiveImportPair = {
  fileName: string;
  file?: File;
  path?: string;
  data?: ParsedData;
  content?: string;
  tagContent?: string;
  sizeBytes: number;
};
type ParsedTagImport = {
  tags: Record<string, Tag>;
  annotations: Annotations;
  hasAnnotations: boolean;
};
type ArchiveImportMode = "new" | "restore";
type EditorMode = "tagger" | "edit";
type TagPanelDock = "left" | "right" | "top" | "bottom" | "floating";
type TagPanelResizeAxis = "x" | "y";

const TAG_COLORS = [
  "#2457ff",
  "#ef765b",
  "#14a77a",
  "#e2a227",
  "#9457d8",
  "#327d9b",
  "#dc4c84",
  "#66717a",
];
const EMPTY_ANNOTATIONS: Annotations = {
  rows: {},
  cells: {},
  columns: {},
  dataset: [],
};
const ARCHIVE_KEY = "tagger-archives-v1";
const ARCHIVE_IDB_MARKER = "tagger-archives-idb-v1";
const ARCHIVE_DB_NAME = "tagger-storage-v1";
const ARCHIVE_STORE_NAME = "archives";
const MARK_STYLE_KEY = "tagger-mark-style-v1";
const TAG_DRAFT_SHORTCUT = "__tag_draft__";
const BROWSER_FILE_LIMIT_BYTES = 3 * 1024 * 1024;
const TABLE_ROW_HEIGHT = 38;
const TABLE_OVERSCAN = 8;
const TAG_TEMPLATE = `{
  "schema": "tagger.tags/v1",
  "version": 1,
  "tags": [
    {
      "name": "keep",
      "definition": "保留：满足当前筛选或研究条件的数据。",
      "color": "#2457ff",
      "shortcut": "1"
    },
    {
      "name": "review",
      "definition": "复核：需要人工再次确认的数据。",
      "color": "#e2a227",
      "shortcut": "2"
    }
  ],
  "annotations": {
    "rows": {},
    "cells": {},
    "columns": {},
    "dataset": []
  }
}`;

const isDesktop = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const makeEmptyAnnotations = (): Annotations => ({
  rows: {},
  cells: {},
  columns: {},
  dataset: [],
});
const makeEmptyFilters = (): WorkspaceFilters => ({
  hiddenColumns: [],
  columnFilters: {},
  columnValueSelections: {},
  columnValueFilterModes: {},
  columnTagFilters: {},
});

function normalizeFilters(value: unknown): WorkspaceFilters {
  if (!value || typeof value !== "object") return makeEmptyFilters();
  const source = value as Record<string, unknown>;
  const toStringMap = (item: unknown) => {
    if (!item || typeof item !== "object") return {};
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).flatMap(([key, entry]) =>
        typeof entry === "string" ? [[key, entry]] : [],
      ),
    );
  };
  const toStringListMap = (item: unknown) => {
    if (!item || typeof item !== "object") return {};
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).flatMap(([key, entry]) =>
        Array.isArray(entry)
          ? [[key, entry.filter((part): part is string => typeof part === "string")]]
          : [],
      ),
    );
  };
  const rawHiddenColumns = Array.isArray(source.hiddenColumns)
    ? source.hiddenColumns
        .filter((column): column is number => Number.isInteger(column) && column >= 0)
    : [];
  const modes = toStringMap(source.columnValueFilterModes);
  const columnValueFilterModes = Object.fromEntries(
    Object.entries(modes).flatMap(([key, mode]) =>
      mode === "exclude" || mode === "include" ? [[key, mode]] : [],
    ),
  ) as Record<string, ColumnValueFilterMode>;
  return {
    hiddenColumns: Array.from(new Set(rawHiddenColumns)),
    columnFilters: toStringMap(source.columnFilters),
    columnValueSelections: toStringListMap(source.columnValueSelections),
    columnValueFilterModes,
    columnTagFilters: toStringMap(source.columnTagFilters),
  };
}

function cloneFilters(source: WorkspaceFilters | null | undefined) {
  const normalized = normalizeFilters(source);
  return {
    hiddenColumns: [...normalized.hiddenColumns],
    columnFilters: { ...normalized.columnFilters },
    columnValueSelections: Object.fromEntries(
      Object.entries(normalized.columnValueSelections).map(([key, values]) => [
        key,
        [...values],
      ]),
    ),
    columnValueFilterModes: { ...normalized.columnValueFilterModes },
    columnTagFilters: { ...normalized.columnTagFilters },
  };
}

function initialArchives(): Array<ArchiveSlot | null> {
  if (typeof window === "undefined") return Array(10).fill(null);
  try {
    const parsed = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "null");
    if (Array.isArray(parsed))
      return Array.from({ length: 10 }, (_, index) => {
        const slot = parsed[index] ?? null;
        if (
          slot?.fileName === "example.csv" &&
          slot.filePath === null &&
          slot.data?.headers?.[0] === "record_id" &&
          slot.data?.rows?.[0]?.[0] === "R-001"
        )
          return null;
        return slot;
      });
  } catch {
    /* ignore invalid local archive data */
  }
  return Array(10).fill(null);
}

function openArchiveDatabase() {
  if (typeof indexedDB === "undefined") return Promise.resolve<IDBDatabase | null>(null);
  return new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open(ARCHIVE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ARCHIVE_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function readIndexedArchives() {
  const database = await openArchiveDatabase();
  if (!database) return null;
  return new Promise<Array<ArchiveSlot | null> | null>((resolve) => {
    const transaction = database.transaction(ARCHIVE_STORE_NAME, "readonly");
    const request = transaction.objectStore(ARCHIVE_STORE_NAME).get("all");
    request.onsuccess = () => {
      database.close();
      resolve(Array.isArray(request.result) ? request.result : null);
    };
    request.onerror = () => {
      database.close();
      resolve(null);
    };
  });
}

async function writeIndexedArchives(archives: Array<ArchiveSlot | null>) {
  const database = await openArchiveDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(ARCHIVE_STORE_NAME, "readwrite");
    transaction.objectStore(ARCHIVE_STORE_NAME).put(archives, "all");
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      resolve();
    };
  });
}

async function parseFileInWorker(
  file: File,
  delimiter: string,
  onProgress?: (progress: number) => void,
): Promise<ParsedData> {
  if (typeof Worker === "undefined")
    return parseDelimitedFileOnMain(file, delimiter, onProgress);
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./csvParser.worker.ts", import.meta.url),
      { type: "module" },
    );
    const finish = () => worker.terminate();
    worker.onmessage = (event: MessageEvent) => {
      if (event.data.type === "progress") onProgress?.(event.data.progress);
      else if (event.data.type === "complete") {
        finish();
        resolve(event.data.data as ParsedData);
      } else if (event.data.type === "error") {
        finish();
        reject(new Error(event.data.message));
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "CSV worker failed"));
    };
    worker.postMessage({ file, delimiter });
  });
}

function parseDelimitedFile(
  file: File,
  delimiter: string,
  onProgress?: (progress: number) => void,
) {
  return parseFileInWorker(file, delimiter, onProgress);
}

function serializeDelimited(data: ParsedData, delimiter: string) {
  const escape = (value: string) => {
    const text = String(value ?? "");
    return /["\n\r\t,;]/.test(text) || text.includes(delimiter)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  };
  return [data.headers, ...data.rows]
    .map((row) => row.map(escape).join(delimiter))
    .join("\n");
}

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadFile(name: string, content: string, type: string) {
  downloadBlob(name, new Blob([content], { type }));
}

async function exportFile(
  name: string,
  content: string | Uint8Array,
  type: string,
  extension: string,
) {
  if (!isDesktop()) {
    const browserContent =
      typeof content === "string"
        ? content
        : (content.buffer.slice(
            content.byteOffset,
            content.byteOffset + content.byteLength,
          ) as ArrayBuffer);
    downloadBlob(
      name,
      new Blob([browserContent], {
        type,
      }),
    );
    return true;
  }
  const target = await saveNativeFileDialog({
    title: "导出文件",
    defaultPath: name,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
  if (!target) return false;
  if (typeof content === "string") await writeTextFile(target, content);
  else await writeFile(target, content);
  return true;
}

function serializeTagsExport(
  sourceFileName: string | null,
  delimiter: string,
  tags: Record<string, Tag>,
  annotations: Annotations,
) {
  return JSON.stringify(
    {
      schema: "tagger.tags/v1",
      version: 1,
      source: {
        file: sourceFileName,
        delimiter: delimiter === "\t" ? "tab" : "comma",
      },
      tags,
      annotations,
    },
    null,
    2,
  );
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(files: Array<{ name: string; content: string }>) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  const write16 = (view: DataView, offset: number, value: number) =>
    view.setUint16(offset, value, true);
  const write32 = (view: DataView, offset: number, value: number) =>
    view.setUint32(offset, value, true);

  files.forEach((file) => {
    const name = encoder.encode(file.name);
    const content = encoder.encode(file.content);
    const checksum = crc32(content);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write16(localView, 8, 0);
    write32(localView, 14, checksum);
    write32(localView, 18, content.length);
    write32(localView, 22, content.length);
    write16(localView, 26, name.length);
    local.set(name, 30);
    localParts.push(local, content);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    write32(centralView, 0, 0x02014b50);
    write16(centralView, 4, 20);
    write16(centralView, 6, 20);
    write32(centralView, 16, checksum);
    write32(centralView, 20, content.length);
    write32(centralView, 24, content.length);
    write16(centralView, 28, name.length);
    write32(centralView, 42, localOffset);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length + content.length;
  });

  const centralOffset = localOffset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  write32(endView, 0, 0x06054b50);
  write16(endView, 8, files.length);
  write16(endView, 10, files.length);
  write32(endView, 12, centralSize);
  write32(endView, 16, centralOffset);
  const blobParts = [...localParts, ...centralParts, end].map(
    (part) => part.buffer as ArrayBuffer,
  );
  return new Blob(blobParts, {
    type: "application/zip",
  });
}

function safeBundleName(name: string) {
  return (
    name
      .replace(/\.(csv|tsv)$/i, "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .trim()
      .slice(0, 80) || "data"
  );
}

function createArchiveBundle(slots: ArchiveSlot[]) {
  const files = slots.flatMap((slot, index) => {
    const base = safeBundleName(slot.fileName);
    const folder = `${String(index + 1).padStart(2, "0")}-${base}`;
    const tableName = `${base}${slot.delimiter === "\t" ? ".tsv" : ".csv"}`;
    return [
      {
        name: `${folder}/${tableName}`,
        content: serializeDelimited(slot.data, slot.delimiter),
      },
      {
        name: `${folder}/${base}.tags.json`,
        content: serializeTagsExport(
          slot.fileName,
          slot.delimiter,
          slot.tags,
          slot.annotations,
        ),
      },
      {
        name: `${folder}/tagger-tags-template.json`,
        content: TAG_TEMPLATE,
      },
    ];
  });
  return createStoredZip(files);
}

function cloneAnnotations(source: Annotations): Annotations {
  return {
    rows: Object.fromEntries(
      Object.entries(source.rows).map(([key, value]) => [key, [...value]]),
    ),
    cells: Object.fromEntries(
      Object.entries(source.cells).map(([row, cells]) => [
        row,
        Object.fromEntries(
          Object.entries(cells).map(([column, value]) => [column, [...value]]),
        ),
      ]),
    ),
    columns: Object.fromEntries(
      Object.entries(source.columns).map(([key, value]) => [key, [...value]]),
    ),
    dataset: [...source.dataset],
  };
}

function cloneData(source: ParsedData): ParsedData {
  return {
    ...source,
    headers: [...source.headers],
    rows: source.rows.map((row) => [...row]),
  };
}

function cloneTags(source: Record<string, Tag>): Record<string, Tag> {
  return Object.fromEntries(
    Object.entries(source).map(([name, tag]) => [name, { ...tag }]),
  );
}

function normalizeAnnotations(value: unknown): Annotations {
  if (!value || typeof value !== "object") return makeEmptyAnnotations();
  const source = value as Record<string, unknown>;
  const toList = (item: unknown) =>
    Array.isArray(item)
      ? item.filter((tag): tag is string => typeof tag === "string")
      : [];
  const toMap = (item: unknown) => {
    if (!item || typeof item !== "object") return {};
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).map(([key, tags]) => [
        key,
        toList(tags),
      ]),
    );
  };
  const cells =
    source.cells && typeof source.cells === "object"
      ? Object.fromEntries(
          Object.entries(source.cells as Record<string, unknown>).map(
            ([row, columns]) => [row, toMap(columns)],
          ),
        )
      : {};
  return {
    rows: toMap(source.rows),
    cells,
    columns: toMap(source.columns),
    dataset: toList(source.dataset),
  };
}

function parseTagExportContent(content: string): ParsedTagImport {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const raw = parsed.tags ?? parsed.tag_definitions ?? parsed;
  const imported: Record<string, Tag> = {};
  const addTag = (name: string, value: unknown) => {
    const tag =
      typeof value === "string"
        ? { definition: value }
        : value && typeof value === "object"
          ? (value as Partial<Tag>)
          : {};
    imported[name] = {
      name,
      definition: tag.definition ?? "",
      color:
        tag.color ?? TAG_COLORS[Object.keys(imported).length % TAG_COLORS.length],
      shortcut: tag.shortcut ?? "",
    };
  };
  if (Array.isArray(raw))
    raw.forEach((tag) => {
      if (tag && typeof tag === "object" && "name" in tag) {
        const name = String((tag as { name: unknown }).name).trim();
        if (name) addTag(name, tag);
      }
    });
  else if (raw && typeof raw === "object")
    Object.entries(raw as Record<string, unknown>).forEach(([name, value]) => {
      if (name !== "schema" && name !== "version" && name !== "source")
        addTag(name, value);
    });
  if (!Object.keys(imported).length) throw new Error("没有找到标签");
  const hasAnnotations =
    !!parsed.annotations && typeof parsed.annotations === "object";
  return {
    tags: imported,
    annotations: hasAnnotations
      ? normalizeAnnotations(parsed.annotations)
      : makeEmptyAnnotations(),
    hasAnnotations,
  };
}

function isTableFileName(name: string) {
  return /\.(csv|tsv)$/i.test(name);
}

function isTagFileName(name: string) {
  return /\.tags\.json$/i.test(name) || /\.json$/i.test(name);
}

function tableBaseName(name: string) {
  return name
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(csv|tsv)$/i, "")
    .toLowerCase();
}

function tagBaseName(name: string) {
  return name
    .split(/[\\/]/)
    .pop()!
    .replace(/\.tags\.json$/i, "")
    .replace(/\.json$/i, "")
    .toLowerCase();
}

function readStoredZipBytes(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries: Array<{ name: string; content: string }> = [];
  let offset = 0;
  while (offset + 4 <= bytes.byteLength) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50 || offset + 30 > bytes.byteLength)
      throw new Error("只支持 Tagger 导出的 ZIP 文件");
    const flags = view.getUint16(offset + 6, true);
    const compression = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (flags & 0x08 || compression !== 0)
      throw new Error("ZIP 需要使用 Tagger 导出的未压缩格式");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) throw new Error("ZIP 文件不完整");
    entries.push({
      name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      content: decoder.decode(bytes.subarray(dataStart, dataEnd)),
    });
    offset = dataEnd;
  }
  if (!entries.length) throw new Error("ZIP 中没有可导入的表格");
  return entries;
}

async function readStoredZip(file: File) {
  return readStoredZipBytes(new Uint8Array(await file.arrayBuffer()));
}

function toggleTag(list: string[], name: string, remove: boolean) {
  return remove
    ? list.filter((item) => item !== name)
    : list.includes(name)
      ? list
      : [...list, name];
}

const shortcutAliases: Record<string, string> = {
  command: "Cmd",
  cmd: "Cmd",
  meta: "Cmd",
  control: "Ctrl",
  ctrl: "Ctrl",
  option: "Alt",
  alt: "Alt",
  shift: "Shift",
  space: "Space",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  escape: "Escape",
  esc: "Escape",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
};
const shortcutModifierOrder = ["Cmd", "Ctrl", "Alt", "Shift"];

function keyName(key: string) {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return shortcutAliases[key.toLowerCase()] ?? key;
}

function normalizeShortcut(shortcut: string) {
  const parts = shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => shortcutAliases[part.toLowerCase()] ?? keyName(part));
  const modifiers = shortcutModifierOrder.filter((modifier) =>
    parts.includes(modifier),
  );
  const key = parts.find((part) => !shortcutModifierOrder.includes(part));
  return [...modifiers, ...(key ? [key] : [])].join("+");
}

function shortcutFromEvent(event: KeyboardEvent) {
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return "";
  const modifiers = [
    event.metaKey ? "Cmd" : "",
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
  ].filter(Boolean);
  return [...modifiers, keyName(event.key)].join("+");
}

function displayShortcut(shortcut: string) {
  const labels: Record<string, string> = {
    Cmd: "⌘",
    Ctrl: "Ctrl",
    Alt: "⌥",
    Shift: "⇧",
    Space: "Space",
    Enter: "↵",
    Tab: "Tab",
    Backspace: "⌫",
    Delete: "Del",
    Up: "↑",
    Down: "↓",
    Left: "←",
    Right: "→",
    Escape: "Esc",
  };
  return normalizeShortcut(shortcut)
    .split("+")
    .map((part) => labels[part] ?? part)
    .join("+");
}

function shortcutMatches(
  event: KeyboardEvent,
  shortcut: string,
  allowShiftRemoval = false,
) {
  const current = normalizeShortcut(shortcutFromEvent(event));
  const saved = normalizeShortcut(shortcut);
  if (current === saved) return true;
  if (
    allowShiftRemoval &&
    event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  )
    return normalizeShortcut(current.replace(/^Shift\+/, "")) === saved;
  return false;
}

function App() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [delimiter, setDelimiter] = useState(",");
  const [fileSizeBytes, setFileSizeBytes] = useState(0);
  const [data, setData] = useState<ParsedData | null>(null);
  const [tags, setTags] = useState<Record<string, Tag>>({});
  const [annotations, setAnnotations] =
    useState<Annotations>(makeEmptyAnnotations);
  const [archives, setArchives] =
    useState<Array<ArchiveSlot | null>>(initialArchives);
  const [archivesReady, setArchivesReady] = useState(false);
  const [archiveScreen, setArchiveScreen] = useState(false);
  const [archiveImportMode, setArchiveImportMode] =
    useState<ArchiveImportMode>("new");
  const [archiveSlot, setArchiveSlot] = useState<number | null>(null);
  const [selectedArchiveSlots, setSelectedArchiveSlots] = useState<Set<number>>(
    new Set(),
  );
  const [showArchiveExportMenu, setShowArchiveExportMenu] = useState(false);
  const [pendingSlot, setPendingSlot] = useState<number | null>(null);
  const [isArchiveDragActive, setIsArchiveDragActive] = useState(false);
  const [importProgress, setImportProgress] = useState<number | null>(null);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [archiveDeleteTarget, setArchiveDeleteTarget] = useState<number | null>(
    null,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [selectedColumns, setSelectedColumns] = useState<Set<number>>(
    new Set(),
  );
  const [selectedRange, setSelectedRange] = useState<CellRange | null>(null);
  const [globalValue, setGlobalValue] = useState("");
  const [hiddenColumns, setHiddenColumns] = useState<Set<number>>(new Set());
  const [showColumnVisibility, setShowColumnVisibility] = useState(false);
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>(
    {},
  );
  const [columnValueSelections, setColumnValueSelections] = useState<
    Record<string, string[]>
  >({});
  const [columnValueFilterModes, setColumnValueFilterModes] = useState<
    Record<string, ColumnValueFilterMode>
  >({});
  const [openColumnFilter, setOpenColumnFilter] = useState<string | null>(null);
  const [activeFilterTab, setActiveFilterTab] = useState<"value" | "tag">(
    "value",
  );
  const [columnTagFilters, setColumnTagFilters] = useState<
    Record<string, string>
  >({});
  const [theme, setTheme] = useState<Theme>(() =>
    typeof window !== "undefined" &&
    localStorage.getItem("tagger-theme") === "dark"
      ? "dark"
      : "light",
  );
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("tagger");
  const [tagPanelDock, setTagPanelDock] = useState<TagPanelDock>("right");
  const [tagPanelSize, setTagPanelSize] = useState({ width: 290, height: 260 });
  const [tagPanelPosition, setTagPanelPosition] = useState({ left: 0, top: 72 });
  const [isTagPanelDragging, setIsTagPanelDragging] = useState(false);
  const [tagPanelResizeAxis, setTagPanelResizeAxis] =
    useState<TagPanelResizeAxis | null>(null);
  const [tagPanelDockTarget, setTagPanelDockTarget] =
    useState<Exclude<TagPanelDock, "floating"> | null>(null);
  const [markStyle, setMarkStyle] = useState<MarkStyle>(() =>
    typeof window !== "undefined" &&
    localStorage.getItem(MARK_STYLE_KEY) === "dot"
      ? "dot"
      : "fill",
  );
  const [showTagDialog, setShowTagDialog] = useState(false);
  const [tagDraft, setTagDraft] = useState<TagDraft>({
    name: "",
    definition: "",
    color: TAG_COLORS[0],
    shortcut: "1",
  });
  const [editingCell, setEditingCell] = useState<{
    row: number;
    col: number;
  } | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [capturingShortcut, setCapturingShortcut] = useState<string | null>(
    null,
  );
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({});
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tagFileInputRef = useRef<HTMLInputElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [tableViewport, setTableViewport] = useState({ top: 0, height: 600 });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const tagPanelRef = useRef<HTMLElement>(null);
  const tagPanelDragRef = useRef<{
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  } | null>(null);
  const tagPanelResizeRef = useRef<{
    axis: TagPanelResizeAxis;
    edge: Exclude<TagPanelDock, "floating">;
    startX: number;
    startY: number;
    startSize: number;
  } | null>(null);
  const tagPanelDockTargetRef = useRef<Exclude<TagPanelDock, "floating"> | null>(
    null,
  );
  const draggingRef = useRef(false);
  const resizingRef = useRef<{
    column: number;
    startX: number;
    startWidth: number;
    pointerId: number;
  } | null>(null);
  const historyRef = useRef<WorkspaceSnapshot[]>([]);
  const futureRef = useRef<WorkspaceSnapshot[]>([]);
  const savedSnapshotRef = useRef<WorkspaceSnapshot | null>(null);
  const desktopWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const workspaceRevisionRef = useRef(0);
  const isSavingRef = useRef(false);
  const tableScrollRestoreRef = useRef<{ top: number; left: number } | null>(
    null,
  );

  const enqueueDesktopWrite = useCallback(
    <T,>(operation: () => Promise<T>) => {
      const next = desktopWriteQueueRef.current.then(operation, operation);
      desktopWriteQueueRef.current = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    [],
  );

  const tagList = useMemo(() => Object.values(tags), [tags]);
  const storageKey = fileName ? `tagger-workspace:${fileName}` : "";
  const getCurrentFilters = useCallback(
    (): WorkspaceFilters => ({
      hiddenColumns: Array.from(hiddenColumns).sort((a, b) => a - b),
      columnFilters: { ...columnFilters },
      columnValueSelections: Object.fromEntries(
        Object.entries(columnValueSelections).map(([key, values]) => [
          key,
          [...values],
        ]),
      ),
      columnValueFilterModes: { ...columnValueFilterModes },
      columnTagFilters: { ...columnTagFilters },
    }),
    [
      columnFilters,
      columnTagFilters,
      columnValueFilterModes,
      columnValueSelections,
      hiddenColumns,
    ],
  );
  const persistBrowserState = useCallback(
    (
      nextTags: Record<string, Tag>,
      nextAnnotations: Annotations,
      nextFilters: WorkspaceFilters = getCurrentFilters(),
    ) => {
      if (storageKey)
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            tags: nextTags,
            annotations: nextAnnotations,
            filters: cloneFilters(nextFilters),
          }),
        );
    },
    [
      columnFilters,
      columnTagFilters,
      columnValueFilterModes,
      columnValueSelections,
      getCurrentFilters,
      hiddenColumns,
      storageKey,
    ],
  );
  const persistArchives = useCallback(
    (next: Array<ArchiveSlot | null>) => {
      const hasLargeFile = next.some(
        (slot) => (slot?.sizeBytes ?? 0) > 4 * 1024 * 1024,
      );
      if (hasLargeFile) {
        try {
          localStorage.setItem(ARCHIVE_IDB_MARKER, "1");
        } catch {
          /* IndexedDB is still attempted when the marker cannot be written. */
        }
        void writeIndexedArchives(next);
        return;
      }
      try {
        localStorage.setItem(ARCHIVE_KEY, JSON.stringify(next));
        localStorage.removeItem(ARCHIVE_IDB_MARKER);
      } catch {
        try {
          localStorage.setItem(ARCHIVE_IDB_MARKER, "1");
        } catch {
          /* IndexedDB remains the persistence fallback when storage is full. */
        }
        void writeIndexedArchives(next);
      }
    },
    [],
  );
  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2200);
  }, []);
  const persistDesktopWorkspace = useCallback(
    async (
      nextTags: Record<string, Tag>,
      nextAnnotations: Annotations,
      failureMessage: string,
    ) => {
      if (!isDesktop() || !filePath) return;
      try {
        await enqueueDesktopWrite(() =>
          invoke("save_workspace", {
            csvPath: filePath,
            tags: nextTags,
            annotations: nextAnnotations,
          }),
        );
      } catch (error) {
        showNotice(`${failureMessage}：${String(error)}`);
      }
    },
    [enqueueDesktopWrite, filePath, showNotice],
  );
  const deleteDesktopTag = useCallback(
    async (name: string) => {
      if (!isDesktop() || !filePath) return;
      try {
        await enqueueDesktopWrite(() =>
          invoke("delete_tag", { csvPath: filePath, name }),
        );
      } catch (error) {
        showNotice(`删除标签失败：${String(error)}`);
      }
    },
    [enqueueDesktopWrite, filePath, showNotice],
  );

  const beginTagPanelDrag = (event: React.MouseEvent) => {
    if ((event.target as Element).closest("button")) return;
    const panel = tagPanelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const width = rect.width || tagPanelSize.width;
    const height =
      tagPanelDock === "left" || tagPanelDock === "right"
        ? Math.max(300, tagPanelSize.height)
        : rect.height || tagPanelSize.height;
    event.preventDefault();
    tagPanelDragRef.current = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width,
      height,
    };
    setTagPanelSize((previous) => ({
      width,
      height,
    }));
    tagPanelDockTargetRef.current = null;
    setIsTagPanelDragging(true);
    setTagPanelDockTarget(null);
  };

  const beginTagPanelResize = (
    event: React.MouseEvent,
    edge: Exclude<TagPanelDock, "floating">,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const axis: TagPanelResizeAxis =
      edge === "left" || edge === "right" ? "x" : "y";
    tagPanelResizeRef.current = {
      axis,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      startSize: axis === "x" ? tagPanelSize.width : tagPanelSize.height,
    };
    setTagPanelResizeAxis(axis);
  };

  useEffect(() => {
    if (localStorage.getItem(ARCHIVE_IDB_MARKER) !== "1") {
      setArchivesReady(true);
      return;
    }
    let active = true;
    void readIndexedArchives().then((saved) => {
      if (!active) return;
      if (saved) setArchives(saved);
      setArchivesReady(true);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!archivesReady) return undefined;
    const timer = window.setTimeout(() => persistArchives(archives), 220);
    return () => window.clearTimeout(timer);
  }, [archives, archivesReady, persistArchives]);
  useEffect(() => {
    localStorage.setItem("tagger-theme", theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem(MARK_STYLE_KEY, markStyle);
  }, [markStyle]);

  useEffect(() => {
    const mouseMove = (event: MouseEvent) => {
      const resize = tagPanelResizeRef.current;
      if (resize) {
        const delta =
          resize.axis === "x"
            ? event.clientX - resize.startX
            : event.clientY - resize.startY;
        const signedDelta =
          resize.edge === "left" || resize.edge === "top" ? delta : -delta;
        const minSize = resize.axis === "x" ? 220 : 180;
        const viewportLimit =
          resize.axis === "x"
            ? Math.min(window.innerWidth * 0.65, window.innerWidth - 100)
            : Math.min(window.innerHeight * 0.65, window.innerHeight - 140);
        const maxSize = Math.max(minSize, resize.startSize, viewportLimit);
        const nextSize = Math.max(
          minSize,
          Math.min(maxSize, resize.startSize + signedDelta),
        );
        setTagPanelSize((previous) =>
          resize.axis === "x"
            ? { ...previous, width: nextSize }
            : { ...previous, height: nextSize },
        );
        return;
      }
      const drag = tagPanelDragRef.current;
      if (!drag) return;
      const { width, height } = drag;
      const maxLeft = Math.max(10, window.innerWidth - width - 10);
      const maxTop = Math.max(58, window.innerHeight - height - 10);
      const nextLeft = Math.max(
        10,
        Math.min(maxLeft, event.clientX - drag.offsetX),
      );
      const nextTop = Math.max(
        58,
        Math.min(maxTop, event.clientY - drag.offsetY),
      );
      const edgeSize = 72;
      const panelLeft = event.clientX - drag.offsetX;
      const panelTop = event.clientY - drag.offsetY;
      const panelRight = panelLeft + width;
      const panelBottom = panelTop + height;
      const edgeDistances: Array<{
        dock: Exclude<TagPanelDock, "floating">;
        distance: number;
      }> = [
        { dock: "left", distance: Math.max(0, panelLeft) },
        { dock: "right", distance: Math.max(0, window.innerWidth - panelRight) },
        { dock: "top", distance: Math.max(0, panelTop - 52) },
        { dock: "bottom", distance: Math.max(0, window.innerHeight - panelBottom) },
      ];
      const nearDock = edgeDistances
        .filter(({ distance }) => distance <= edgeSize)
        .sort((left, right) => left.distance - right.distance)[0]?.dock ?? null;
      tagPanelDockTargetRef.current = nearDock;
      setTagPanelDock("floating");
      setTagPanelPosition({ left: nextLeft, top: nextTop });
      setTagPanelDockTarget(nearDock);
    };
    const mouseUp = () => {
      if (tagPanelResizeRef.current) {
        tagPanelResizeRef.current = null;
        setTagPanelResizeAxis(null);
        return;
      }
      if (!tagPanelDragRef.current) return;
      if (tagPanelDockTargetRef.current)
        setTagPanelDock(tagPanelDockTargetRef.current);
      tagPanelDragRef.current = null;
      tagPanelDockTargetRef.current = null;
      setIsTagPanelDragging(false);
      setTagPanelDockTarget(null);
    };
    window.addEventListener("mousemove", mouseMove);
    window.addEventListener("mouseup", mouseUp);
    window.addEventListener("blur", mouseUp);
    return () => {
      window.removeEventListener("mousemove", mouseMove);
      window.removeEventListener("mouseup", mouseUp);
      window.removeEventListener("blur", mouseUp);
    };
  }, []);

  useEffect(() => {
    if (tagPanelDock !== "floating") return undefined;
    const panel = tagPanelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      const rect = panel.getBoundingClientRect();
      setTagPanelSize((previous) =>
        Math.abs(previous.width - rect.width) < 1 &&
        Math.abs(previous.height - rect.height) < 1
          ? previous
          : { width: rect.width, height: rect.height },
      );
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [tagPanelDock]);

  const loadWorkspaceState = useCallback(
    async (name: string, path: string | null): Promise<WorkspaceState> => {
      if (isDesktop() && path) {
        const loadedTags: Tag[] = await invoke("get_tags", { csvPath: path });
        const loadedAnnotations: Annotations = await invoke("get_annotations", {
          csvPath: path,
        });
        const nextTags = Object.fromEntries(
          loadedTags.map((tag) => [tag.name, tag]),
        );
        setTags(nextTags);
        setAnnotations(loadedAnnotations);
        return {
          tags: nextTags,
          annotations: loadedAnnotations,
          filters: makeEmptyFilters(),
        };
      }
      const saved = localStorage.getItem(`tagger-workspace:${name}`);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          const nextTags = parsed.tags ?? {};
          const nextAnnotations = parsed.annotations ?? makeEmptyAnnotations();
          const nextFilters = normalizeFilters(parsed.filters);
          setTags(nextTags);
          setAnnotations(nextAnnotations);
          return {
            tags: nextTags,
            annotations: nextAnnotations,
            filters: nextFilters,
          };
        } catch {
          localStorage.removeItem(`tagger-workspace:${name}`);
        }
      }
      const nextTags = {};
      const nextAnnotations = makeEmptyAnnotations();
      setTags(nextTags);
      setAnnotations(nextAnnotations);
      return { tags: nextTags, annotations: nextAnnotations, filters: makeEmptyFilters() };
    },
    [],
  );

  const openData = useCallback(
    async (
      nextData: ParsedData,
      name: string,
      path: string | null,
      nextDelimiter: string,
      slot: number | null,
      sizeBytes = 0,
    ) => {
      workspaceRevisionRef.current = 0;
      setWorkspaceLoaded(false);
      setIsDirty(false);
      setShowSaveDialog(false);
      historyRef.current = [];
      futureRef.current = [];
      setData(nextData);
      setFileName(name);
      setFilePath(path);
      setDelimiter(nextDelimiter);
      setFileSizeBytes(sizeBytes);
      setArchiveSlot(slot);
      setSelectedArchiveSlots(new Set());
      setShowArchiveExportMenu(false);
      setEditorMode("tagger");
      setSelectedRows(new Set());
      setSelectedColumns(new Set());
      setSelectedRange(null);
      setGlobalValue("");
      setHiddenColumns(new Set());
      setShowColumnVisibility(false);
      setColumnFilters({});
      setColumnValueSelections({});
      setColumnValueFilterModes({});
      setColumnTagFilters({});
      setOpenColumnFilter(null);
      setColumnWidths({});
      const loadedState = await loadWorkspaceState(name, path);
      const loadedFilters = cloneFilters(loadedState.filters);
      setHiddenColumns(new Set(loadedFilters.hiddenColumns));
      setColumnFilters(loadedFilters.columnFilters);
      setColumnValueSelections(loadedFilters.columnValueSelections);
      setColumnValueFilterModes(loadedFilters.columnValueFilterModes);
      setColumnTagFilters(loadedFilters.columnTagFilters);
      savedSnapshotRef.current = {
        data: cloneData(nextData),
        tags: cloneTags(loadedState.tags),
        annotations: cloneAnnotations(loadedState.annotations),
        filters: loadedFilters,
      };
      setWorkspaceLoaded(true);
      setArchiveScreen(false);
    },
    [loadWorkspaceState],
  );

  const handleOpen = () => {
    setShowExportMenu(false);
    setShowArchiveExportMenu(false);
    setSelectedArchiveSlots(new Set());
    setArchiveScreen(true);
  };

  const toggleArchiveSelection = (slot: number) => {
    setSelectedArchiveSlots((previous) => {
      const next = new Set(previous);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
  };

  const readDesktopTablePair = async (
    path: string,
    tagPath?: string,
  ): Promise<ArchiveImportPair> => {
    const parsed = await invoke<{
      headers: string[];
      rows: string[][];
      row_count: number;
      column_count: number;
    }>("open_csv", { path });
    const fileInfo = await stat(path).catch(() => null);
    const fileName = await basename(path);
    return {
      fileName,
      path,
      data: {
        headers: parsed.headers,
        rows: parsed.rows,
        rowCount: parsed.row_count,
        columnCount: parsed.column_count,
      },
      tagContent: tagPath ? await readTextFile(tagPath) : undefined,
      sizeBytes: fileInfo?.size ?? 0,
    };
  };

  const importArchivePairs = async (
    pairs: ArchiveImportPair[],
    skippedCount = 0,
    targetSlot: number | null = null,
  ) => {
    if (!pairs.length) {
      showNotice(
        skippedCount
          ? "浏览器模式仅支持小于 3 MB 的文件，请使用安装版打开大文件"
          : "请选择 CSV/TSV 和对应的标签 JSON",
      );
      setPendingSlot(null);
      return;
    }
    const nextArchives = [...archives];
    let cursor = targetSlot ?? pendingSlot ?? 0;
    let imported = 0;
    let restored = 0;
    setImportProgress(0);
    try {
      for (const pair of pairs) {
        while (cursor < nextArchives.length && nextArchives[cursor]) cursor += 1;
        if (cursor >= nextArchives.length) break;
        const nextDelimiter = pair.fileName.toLowerCase().endsWith(".tsv")
          ? "\t"
          : ",";
        try {
          const importedTags = pair.tagContent
            ? parseTagExportContent(pair.tagContent)
            : null;
          const importedData =
            pair.data ??
            (await parseDelimitedFile(
              pair.file ??
                new File([pair.content ?? ""], pair.fileName, {
                  type: "text/plain",
                }),
              nextDelimiter,
              setImportProgress,
            ));
          nextArchives[cursor] = {
            fileName: pair.fileName,
            filePath: pair.path ?? null,
            delimiter: nextDelimiter,
            sizeBytes: pair.sizeBytes,
            data: importedData,
            tags: importedTags?.tags ?? {},
            annotations: importedTags?.annotations ?? makeEmptyAnnotations(),
            filters: makeEmptyFilters(),
            updatedAt: Date.now(),
          };
          imported += 1;
          if (importedTags) restored += 1;
          cursor += 1;
        } catch (error) {
          showNotice(`${pair.fileName} 读取失败：${String(error)}`);
        }
      }
      if (imported) {
        setArchives(nextArchives);
        persistArchives(nextArchives);
        const restoredText = restored ? `，恢复 ${restored} 份标签` : "";
        const skippedText = skippedCount ? `，跳过 ${skippedCount} 个超限文件` : "";
        showNotice(`已导入 ${imported} 个文件${restoredText}${skippedText}`);
      } else {
        showNotice(
          skippedCount
            ? "没有可用存档位；浏览器仅支持小于 3 MB 的文件"
            : "没有可用存档位",
        );
      }
    } finally {
      setImportProgress(null);
      setPendingSlot(null);
    }
  };

  const importDesktopPaths = async (
    mode: ArchiveImportMode,
    targetSlot: number | null = null,
  ) => {
    const selected = await openNativeFileDialog({
      title: mode === "restore" ? "恢复 CSV 与标签" : "导入 CSV / TSV",
      multiple: true,
      filters: [
        {
          name: "Tagger 文件",
          extensions: ["csv", "tsv", "json", "zip"],
        },
      ],
    });
    if (!selected) {
      setPendingSlot(null);
      return;
    }
    const paths = Array.isArray(selected) ? selected : [selected];
    try {
      if (mode === "new") {
        const tablePaths = paths.filter(isTableFileName);
        await importArchivePairs(
          await Promise.all(tablePaths.map((path) => readDesktopTablePair(path))),
          0,
          targetSlot,
        );
        return;
      }

      const pairs: ArchiveImportPair[] = [];
      const zipPaths = paths.filter((path) => /\.zip$/i.test(path));
      for (const zipPath of zipPaths) {
        const entries = readStoredZipBytes(await readFile(zipPath));
        const fileInfo = await stat(zipPath).catch(() => null);
        entries
          .filter((entry) => isTableFileName(entry.name))
          .forEach((entry) => {
            const tagEntry = entries.find(
              (candidate) =>
                isTagFileName(candidate.name) &&
                tagBaseName(candidate.name) === tableBaseName(entry.name),
            );
            pairs.push({
              fileName: entry.name.split(/[\\/]/).pop() || entry.name,
              content: entry.content,
              tagContent: tagEntry?.content,
              sizeBytes: fileInfo?.size ?? 0,
            });
          });
      }

      const tablePaths = paths.filter(isTableFileName);
      const tagPaths = paths.filter(
        (path) => isTagFileName(path) && !isTableFileName(path),
      );
      for (const tablePath of tablePaths) {
        const exactTag = tagPaths.find(
          (tagPath) => tagBaseName(tagPath) === tableBaseName(tablePath),
        );
        const fallbackTag =
          tablePaths.length === 1 && tagPaths.length === 1 ? tagPaths[0] : undefined;
        pairs.push(
          await readDesktopTablePair(tablePath, exactTag ?? fallbackTag),
        );
      }
      await importArchivePairs(pairs, 0, targetSlot);
    } catch (error) {
      showNotice(`文件读取失败：${String(error)}`);
      setPendingSlot(null);
    }
  };

  const importArchiveFiles = async (files: File[]) => {
    if (!files.length) return;
    const tableFiles = files.filter((file) => isTableFileName(file.name));
    if (!tableFiles.length) {
      showNotice("新建标注请选择 CSV/TSV 文件；已有标签请使用恢复入口");
      setPendingSlot(null);
      return;
    }
    const oversizedFiles = isDesktop()
      ? []
      : tableFiles.filter((file) => file.size >= BROWSER_FILE_LIMIT_BYTES);
    const importableFiles = tableFiles.filter(
      (file) => !oversizedFiles.includes(file),
    );
    await importArchivePairs(
      importableFiles.map((file) => ({
        fileName: file.name,
        file,
        sizeBytes: file.size,
      })),
      oversizedFiles.length,
    );
  };

  const importArchiveBundleFiles = async (files: File[]) => {
    if (!files.length) return;
    try {
      const pairs: ArchiveImportPair[] = [];
      const tableFiles = files.filter((file) => isTableFileName(file.name));
      const tagFiles = files.filter(
        (file) => isTagFileName(file.name) && !isTableFileName(file.name),
      );
      const oversizedZipFiles = isDesktop()
        ? []
        : files.filter(
            (file) =>
              /\.zip$/i.test(file.name) &&
              file.size >= BROWSER_FILE_LIMIT_BYTES,
          );
      for (const file of files.filter(
        (item) =>
          /\.zip$/i.test(item.name) && !oversizedZipFiles.includes(item),
      )) {
        const entries = await readStoredZip(file);
        const tableEntries = entries.filter((entry) => isTableFileName(entry.name));
        tableEntries.forEach((entry) => {
          const tagEntry = entries.find(
            (candidate) =>
              isTagFileName(candidate.name) &&
              tagBaseName(candidate.name) === tableBaseName(entry.name),
          );
          pairs.push({
            fileName: entry.name.split(/[\\/]/).pop() || entry.name,
            content: entry.content,
            tagContent: tagEntry?.content,
            sizeBytes: file.size,
          });
        });
      }
      tableFiles.forEach((file) => {
        pairs.push({
          fileName: file.name,
          file,
          sizeBytes: file.size,
        });
      });
      for (const pair of pairs.filter((item) => item.file)) {
        const tableFile = pair.file!;
        const exactTag = tagFiles.find(
          (candidate) => tagBaseName(candidate.name) === tableBaseName(tableFile.name),
        );
        const fallbackTag =
          tableFiles.length === 1 && tagFiles.length === 1 ? tagFiles[0] : undefined;
        if (exactTag || fallbackTag) {
          pair.tagContent = await (exactTag ?? fallbackTag)!.text();
        }
      }
      const oversizedPairs = isDesktop()
        ? []
        : pairs.filter((pair) => pair.sizeBytes >= BROWSER_FILE_LIMIT_BYTES);
      const importablePairs = pairs.filter(
        (pair) => !oversizedPairs.includes(pair),
      );
      await importArchivePairs(
        importablePairs,
        oversizedPairs.length + oversizedZipFiles.length,
      );
    } catch (error) {
      showNotice(`标签包读取失败：${String(error)}`);
      setPendingSlot(null);
    }
  };

  const handleArchiveFileInput = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files ?? []);
    if (archiveImportMode === "restore")
      await importArchiveBundleFiles(files);
    else await importArchiveFiles(files);
    event.target.value = "";
  };

  const openArchiveImport = (mode: ArchiveImportMode) => {
    setArchiveImportMode(mode);
    if (isDesktop()) {
      void importDesktopPaths(mode);
      return;
    }
    archiveInputRef.current?.click();
  };

  const handleArchiveDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsArchiveDragActive(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.some((file) => isTagFileName(file.name) || /\.zip$/i.test(file.name)))
      void importArchiveBundleFiles(files);
    else void importArchiveFiles(files);
  };

  const handleFileInput = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!isDesktop() && file.size >= BROWSER_FILE_LIMIT_BYTES) {
      showNotice("浏览器模式仅支持小于 3 MB 的文件，请使用安装版打开大文件");
      setPendingSlot(null);
      event.target.value = "";
      return;
    }
    const slot = pendingSlot ?? archives.findIndex((item) => !item);
    if (slot < 0) {
      showNotice("10 个存档位已满");
      event.target.value = "";
      return;
    }
    const nextDelimiter = file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",";
    setImportProgress(0);
    try {
      await openData(
        await parseDelimitedFile(file, nextDelimiter, setImportProgress),
        file.name,
        null,
        nextDelimiter,
        slot,
        file.size,
      );
    } catch (error) {
      showNotice(`读取失败：${String(error)}`);
    } finally {
      setImportProgress(null);
    }
    setPendingSlot(null);
    event.target.value = "";
  };

  const openArchive = (slot: number) => {
    const saved = archives[slot];
    if (saved) {
      workspaceRevisionRef.current = 0;
      setIsDirty(false);
      setShowSaveDialog(false);
      historyRef.current = [];
      futureRef.current = [];
      setData(saved.data);
      setFileName(saved.fileName);
      setFilePath(saved.filePath);
      setDelimiter(saved.delimiter);
      setFileSizeBytes(saved.sizeBytes ?? 0);
      setTags(saved.tags);
      setAnnotations(saved.annotations);
      setEditorMode("tagger");
      setCapturingShortcut(null);
      setGlobalValue("");
      const savedFilters = cloneFilters(saved.filters);
      setHiddenColumns(new Set(savedFilters.hiddenColumns));
      setShowColumnVisibility(false);
      setColumnFilters(savedFilters.columnFilters);
      setColumnValueSelections(savedFilters.columnValueSelections);
      setColumnValueFilterModes(savedFilters.columnValueFilterModes);
      setColumnTagFilters(savedFilters.columnTagFilters);
      setOpenColumnFilter(null);
      setSelectedRows(new Set());
      setSelectedColumns(new Set());
      setSelectedRange(null);
      savedSnapshotRef.current = {
        data: cloneData(saved.data),
        tags: cloneTags(saved.tags),
        annotations: cloneAnnotations(saved.annotations),
        filters: savedFilters,
      };
      setArchiveSlot(slot);
      setWorkspaceLoaded(true);
      setArchiveScreen(false);
      return;
    }
    setPendingSlot(slot);
    if (isDesktop()) void importDesktopPaths("new", slot);
    else fileInputRef.current?.click();
  };

  const requestDeleteArchive = (slot: number) => {
    if (!archives[slot]) return;
    setArchiveDeleteTarget(slot);
  };

  const confirmDeleteArchive = () => {
    if (archiveDeleteTarget === null || !archives[archiveDeleteTarget]) {
      setArchiveDeleteTarget(null);
      return;
    }
    const nextArchives = archives.map((item, index) =>
      index === archiveDeleteTarget ? null : item,
    );
    setArchives(nextArchives);
    persistArchives(nextArchives);
    setSelectedArchiveSlots((previous) => {
      const next = new Set(previous);
      next.delete(archiveDeleteTarget);
      return next;
    });
    if (archiveSlot === archiveDeleteTarget) setArchiveSlot(null);
    setArchiveDeleteTarget(null);
  };

  const currentSnapshot = (): WorkspaceSnapshot | null =>
    data
      ? {
          // Data updates are immutable, so history can share this large table safely.
          data,
          tags: cloneTags(tags),
          annotations: cloneAnnotations(annotations),
          filters: cloneFilters(getCurrentFilters()),
        }
      : null;
  const rememberChange = () => {
    const snapshot = currentSnapshot();
    if (!snapshot) return;
    historyRef.current = [...historyRef.current, snapshot].slice(-100);
    futureRef.current = [];
    workspaceRevisionRef.current += 1;
  };

  const commitEditing = (): ParsedData | null => {
    if (!data || !editingCell) return data;
    const currentValue = data.rows[editingCell.row][editingCell.col];
    if (currentValue === editingValue) {
      setEditingCell(null);
      return data;
    }
    const rows = data.rows.map((row) => [...row]);
    rows[editingCell.row][editingCell.col] = editingValue;
    const nextData = { ...data, rows };
    rememberChange();
    setData(nextData);
    setIsDirty(true);
    setEditingCell(null);
    return nextData;
  };

  const saveWorkspace = useCallback(
    async (dataOverride?: ParsedData) => {
      const dataToSave = dataOverride ?? data;
      if (!dataToSave || !fileName) return true;
      if (isSavingRef.current) return false;
      const revisionAtStart = workspaceRevisionRef.current;
      const tagsToSave = cloneTags(tags);
      const annotationsToSave = cloneAnnotations(annotations);
      setIsSaving(true);
      isSavingRef.current = true;
      try {
        let targetPath = filePath;
        let targetFileName = fileName;
        if (isDesktop() && !targetPath) {
          const extension = delimiter === "\t" ? "tsv" : "csv";
          targetPath = await saveNativeFileDialog({
            title: "保存 CSV / TSV",
            defaultPath: fileName,
            filters: [
              {
                name: extension.toUpperCase(),
                extensions: [extension],
              },
            ],
          });
          if (!targetPath) return false;
          targetFileName = await basename(targetPath);
        }
        const filtersToSave = cloneFilters(getCurrentFilters());
        if (isDesktop() && targetPath) {
          await enqueueDesktopWrite(async () => {
            await invoke("save_csv", {
              csvPath: targetPath,
              headers: dataToSave.headers,
              rows: dataToSave.rows,
              delimiter,
            });
            await invoke("save_workspace", {
              csvPath: targetPath,
              tags: tagsToSave,
              annotations: annotationsToSave,
            });
          });
        }
        if (targetPath !== filePath) setFilePath(targetPath);
        if (targetFileName !== fileName) setFileName(targetFileName);
        const hasNewerChanges = workspaceRevisionRef.current !== revisionAtStart;
        if (!hasNewerChanges) {
          const snapshot: ArchiveSlot = {
            fileName: targetFileName,
            filePath: targetPath,
            delimiter,
            sizeBytes: fileSizeBytes || undefined,
            data: dataToSave,
            tags: tagsToSave,
            annotations: annotationsToSave,
            filters: filtersToSave,
            updatedAt: Date.now(),
          };
          if (archiveSlot !== null) {
            const nextArchives = archives.map((item, index) =>
              index === archiveSlot ? snapshot : item,
            );
            setArchives(nextArchives);
            persistArchives(nextArchives);
          }
          persistBrowserState(tagsToSave, annotationsToSave, filtersToSave);
          savedSnapshotRef.current = {
            data: cloneData(dataToSave),
            tags: tagsToSave,
            annotations: annotationsToSave,
            filters: filtersToSave,
          };
          setIsDirty(false);
        }
        showNotice(
          hasNewerChanges
            ? "已保存当前状态，仍有新修改"
            : isDesktop() && targetPath
              ? `已保存：${targetPath}`
              : "已保存",
        );
        return true;
      } catch (error) {
        showNotice(`保存失败：${String(error)}`);
        return false;
      } finally {
        isSavingRef.current = false;
        setIsSaving(false);
      }
    },
    [
      annotations,
      archiveSlot,
      archives,
      data,
      delimiter,
      fileName,
      fileSizeBytes,
      filePath,
      getCurrentFilters,
      enqueueDesktopWrite,
      persistArchives,
      persistBrowserState,
      showNotice,
      tags,
    ],
  );

  const saveWorkspaceAs = async () => {
    if (!data || !fileName || !isDesktop() || isSavingRef.current) return false;
    const revisionAtStart = workspaceRevisionRef.current;
    const dataToSave = data;
    const tagsToSave = cloneTags(tags);
    const annotationsToSave = cloneAnnotations(annotations);
    const extension = delimiter === "\t" ? "tsv" : "csv";
    let target: string | null;
    try {
      target = await saveNativeFileDialog({
        title: "另存为 CSV / TSV",
        defaultPath: fileName,
        filters: [
          {
            name: extension.toUpperCase(),
            extensions: [extension],
          },
        ],
      });
    } catch (error) {
      showNotice(`保存失败：${String(error)}`);
      return false;
    }
    if (!target) return false;

    setIsSaving(true);
    isSavingRef.current = true;
    try {
      const nextFileName = await basename(target);
      const filtersToSave = cloneFilters(getCurrentFilters());
      await enqueueDesktopWrite(async () => {
        await invoke("save_csv", {
          csvPath: target,
          headers: data.headers,
          rows: data.rows,
          delimiter,
        });
        await invoke("save_workspace", {
          csvPath: target,
          tags: tagsToSave,
          annotations: annotationsToSave,
        });
      });

      setFileName(nextFileName);
      setFilePath(target);
      const hasNewerChanges = workspaceRevisionRef.current !== revisionAtStart;
      if (!hasNewerChanges) {
        const snapshot: ArchiveSlot = {
          fileName: nextFileName,
          filePath: target,
          delimiter,
          sizeBytes: fileSizeBytes || undefined,
          data: dataToSave,
          tags: tagsToSave,
          annotations: annotationsToSave,
          filters: filtersToSave,
          updatedAt: Date.now(),
        };
        if (archiveSlot !== null) {
          const nextArchives = archives.map((item, index) =>
            index === archiveSlot ? snapshot : item,
          );
          setArchives(nextArchives);
          persistArchives(nextArchives);
        }
        persistBrowserState(tagsToSave, annotationsToSave, filtersToSave);
        savedSnapshotRef.current = {
          data: cloneData(dataToSave),
          tags: tagsToSave,
          annotations: annotationsToSave,
          filters: filtersToSave,
        };
        setIsDirty(false);
      }
      showNotice(
        hasNewerChanges ? "已保存当前状态，仍有新修改" : `已保存：${target}`,
      );
      return true;
    } catch (error) {
      showNotice(`保存失败：${String(error)}`);
      return false;
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  };

  const leaveWorkspace = () => {
    setArchiveScreen(false);
    setData(null);
    setFileName(null);
    setFilePath(null);
    setFileSizeBytes(0);
    setArchiveSlot(null);
    setWorkspaceLoaded(false);
    setSelectedRows(new Set());
    setSelectedColumns(new Set());
    setSelectedRange(null);
    setIsDirty(false);
    savedSnapshotRef.current = null;
  };

  const returnHome = () => {
    const pendingData = commitEditing();
    const hasPendingEdit = !!editingCell && !!data && pendingData !== data;
    if (isDirty || hasPendingEdit) {
      setShowSaveDialog(true);
      return;
    }
    leaveWorkspace();
  };

  const discardAndLeave = async () => {
    const saved = savedSnapshotRef.current;
    if (saved && archiveSlot !== null && fileName) {
      const snapshot: ArchiveSlot = {
        fileName,
        filePath,
        delimiter,
        sizeBytes: fileSizeBytes || undefined,
        data: saved.data,
        tags: saved.tags,
        annotations: saved.annotations,
        filters: cloneFilters(saved.filters),
        updatedAt: Date.now(),
      };
      const nextArchives = archives.map((item, index) =>
        index === archiveSlot ? snapshot : item,
      );
      setArchives(nextArchives);
      persistArchives(nextArchives);
      persistBrowserState(saved.tags, saved.annotations, saved.filters);
      if (isDesktop() && filePath) {
        try {
          await enqueueDesktopWrite(async () => {
            await invoke("save_csv", {
              csvPath: filePath,
              headers: saved.data.headers,
              rows: saved.data.rows,
              delimiter,
            });
            await invoke("save_workspace", {
              csvPath: filePath,
              tags: saved.tags,
              annotations: saved.annotations,
            });
          });
        } catch (error) {
          showNotice(`恢复失败：${String(error)}`);
          return;
        }
      }
    }
    setShowSaveDialog(false);
    leaveWorkspace();
  };

  const saveAndLeave = async () => {
    if (await saveWorkspace()) {
      setShowSaveDialog(false);
      leaveWorkspace();
    }
  };

  useEffect(() => {
    if (!workspaceLoaded || archiveSlot === null || !data || !fileName) return;
    const snapshot: ArchiveSlot = {
      fileName,
      filePath,
      delimiter,
      sizeBytes: fileSizeBytes || undefined,
      data,
      tags,
      annotations,
      filters: cloneFilters(getCurrentFilters()),
      updatedAt: Date.now(),
    };
    setArchives((previous) =>
      previous.map((item, index) => (index === archiveSlot ? snapshot : item)),
    );
    persistBrowserState(tags, annotations, snapshot.filters);
  }, [
    annotations,
    archiveSlot,
    data,
    delimiter,
    fileName,
    fileSizeBytes,
    filePath,
    getCurrentFilters,
    persistBrowserState,
    tags,
    workspaceLoaded,
  ]);

  const clearSelection = useCallback(() => {
    setSelectedRows(new Set());
    setSelectedColumns(new Set());
    setSelectedRange(null);
  }, []);
  const clearAllFilters = () => {
    const current = getCurrentFilters();
    const next = {
      ...current,
      columnFilters: {},
      columnValueSelections: {},
      columnValueFilterModes: {},
      columnTagFilters: {},
    };
    setGlobalValue("");
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      rememberChange();
      setColumnFilters(next.columnFilters);
      setColumnValueSelections(next.columnValueSelections);
      setColumnValueFilterModes(next.columnValueFilterModes);
      setColumnTagFilters(next.columnTagFilters);
      setIsDirty(true);
    }
    setOpenColumnFilter(null);
  };
  const rangeBounds = selectedRange
    ? {
        top: Math.min(selectedRange.startRow, selectedRange.endRow),
        bottom: Math.max(selectedRange.startRow, selectedRange.endRow),
        left: Math.min(selectedRange.startCol, selectedRange.endCol),
        right: Math.max(selectedRange.startCol, selectedRange.endCol),
      }
    : null;
  const rangeSize = rangeBounds
    ? (rangeBounds.bottom - rangeBounds.top + 1) *
      (rangeBounds.right - rangeBounds.left + 1)
    : 0;
  const currentScope: Scope = selectedRange
    ? rangeSize === 1
      ? "cell"
      : "range"
    : selectedColumns.size
      ? "column"
      : selectedRows.size
        ? "row"
        : "dataset";
  const scopeLabel = {
    cell: "单元格",
    range: "范围",
    row: "行",
    column: "列",
    dataset: "表格",
  }[currentScope];

  const getRowTags = (row: number) => annotations.rows[`row-${row}`] ?? [];
  const getCellTags = (row: number, column: string) =>
    annotations.cells[`row-${row}`]?.[column] ?? [];
  const getColumnTags = (column: string) => annotations.columns[column] ?? [];
  const getEffectiveCellTags = (row: number, column: string) =>
    Array.from(
      new Set([
        ...annotations.dataset,
        ...getColumnTags(column),
        ...getRowTags(row),
        ...getCellTags(row, column),
      ]),
    );

  const columnUniqueValues = useMemo(() => {
    if (!data || !openColumnFilter) return {} as Record<string, string[]>;
    const column = data.headers.indexOf(openColumnFilter);
    if (column < 0) return {} as Record<string, string[]>;
    return {
      [openColumnFilter]: Array.from(
        new Set(data.rows.map((row) => row[column] ?? "")),
      ).sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
      ),
    };
  }, [data, openColumnFilter]);

  const invokeAnnotation = async (
    scope: Scope,
    tagName: string,
    remove: boolean,
  ) => {
    if (!isDesktop() || !filePath || !data) return;
    const calls: Promise<unknown>[] = [];
    const cell = (row: number, column: number) =>
        calls.push(
        enqueueDesktopWrite(() =>
          invoke(
          remove ? "remove_annotation" : "annotate_cell",
          remove
            ? {
                csvPath: filePath,
                annotationType: "cell",
                target: `row-${row}:${data.headers[column]}`,
                tagName,
              }
            : {
                csvPath: filePath,
                rowId: `row-${row}`,
                column: data.headers[column],
                tagName,
              },
          ),
        ),
      );
    if (scope === "cell" && selectedRange)
      cell(selectedRange.startRow, selectedRange.startCol);
    if (scope === "range" && rangeBounds)
      for (let row = rangeBounds.top; row <= rangeBounds.bottom; row += 1)
        for (
          let column = rangeBounds.left;
          column <= rangeBounds.right;
          column += 1
        )
          cell(row, column);
    if (scope === "row")
      selectedRows.forEach((row) =>
        calls.push(
          enqueueDesktopWrite(() =>
            invoke(
            remove ? "remove_annotation" : "annotate_row",
            remove
              ? {
                  csvPath: filePath,
                  annotationType: "row",
                  target: `row-${row}`,
                  tagName,
                }
              : { csvPath: filePath, rowId: `row-${row}`, tagName },
            ),
          ),
        ),
      );
    if (scope === "column")
      selectedColumns.forEach((column) =>
        calls.push(
          enqueueDesktopWrite(() =>
            invoke(
            remove ? "remove_annotation" : "annotate_column",
            remove
              ? {
                  csvPath: filePath,
                  annotationType: "column",
                  target: data.headers[column],
                  tagName,
                }
              : { csvPath: filePath, column: data.headers[column], tagName },
            ),
          ),
        ),
      );
    if (scope === "dataset")
      calls.push(
        enqueueDesktopWrite(() =>
          invoke(
          remove ? "remove_annotation" : "annotate_dataset",
          remove
            ? {
                csvPath: filePath,
                annotationType: "dataset",
                target: "dataset",
                tagName,
              }
            : { csvPath: filePath, tagName },
          ),
        ),
      );
    await Promise.all(calls);
  };

  const applyTag = useCallback(
    async (tagName: string, remove = false) => {
      if (!data) return;
      const next = cloneAnnotations(annotations);
      const applyCell = (row: number, column: number) => {
        const id = `row-${row}`;
        const header = data.headers[column];
        next.cells[id] ??= {};
        next.cells[id][header] = toggleTag(
          next.cells[id][header] ?? [],
          tagName,
          remove,
        );
      };
      if ((currentScope === "cell" || currentScope === "range") && rangeBounds)
        for (let row = rangeBounds.top; row <= rangeBounds.bottom; row += 1)
          for (
            let column = rangeBounds.left;
            column <= rangeBounds.right;
            column += 1
          )
            applyCell(row, column);
      else if (currentScope === "row")
        selectedRows.forEach((row) => {
          next.rows[`row-${row}`] = toggleTag(
            next.rows[`row-${row}`] ?? [],
            tagName,
            remove,
          );
        });
      else if (currentScope === "column")
        selectedColumns.forEach((column) => {
          const header = data.headers[column];
          next.columns[header] = toggleTag(
            next.columns[header] ?? [],
            tagName,
            remove,
          );
        });
      else next.dataset = toggleTag(next.dataset, tagName, remove);
      rememberChange();
      setAnnotations(next);
      setIsDirty(true);
      persistBrowserState(tags, next);
      try {
        await invokeAnnotation(currentScope, tagName, remove);
      } catch (error) {
        showNotice(`保存失败：${String(error)}`);
      }
    },
    [
      annotations,
      currentScope,
      data,
      persistBrowserState,
      rangeBounds,
      selectedColumns,
      selectedRows,
      showNotice,
      tags,
      enqueueDesktopWrite,
    ],
  );

  const handleCreateTag = () => {
    const name = tagDraft.name.trim();
    if (!name) return;
    const originalName = tagDraft.originalName;
    const nextTag: Tag = {
      name,
      definition: tagDraft.definition.trim(),
      color: tagDraft.color,
      shortcut:
        tagDraft.shortcut.trim() || String(Math.min(tagList.length + 1, 9)),
    };
    const nextTags = { ...tags };
    let nextAnnotations = annotations;
    if (originalName && originalName !== name) {
      delete nextTags[originalName];
      const replace = (items: string[]) =>
        items.map((item) => (item === originalName ? name : item));
      nextAnnotations = cloneAnnotations(annotations);
      nextAnnotations.dataset = replace(nextAnnotations.dataset);
      Object.keys(nextAnnotations.rows).forEach((key) => {
        nextAnnotations.rows[key] = replace(nextAnnotations.rows[key]);
      });
      Object.keys(nextAnnotations.columns).forEach((key) => {
        nextAnnotations.columns[key] = replace(nextAnnotations.columns[key]);
      });
      Object.keys(nextAnnotations.cells).forEach((row) =>
        Object.keys(nextAnnotations.cells[row]).forEach((column) => {
          nextAnnotations.cells[row][column] = replace(
            nextAnnotations.cells[row][column],
          );
        }),
      );
      setAnnotations(nextAnnotations);
    }
    nextTags[name] = nextTag;
    rememberChange();
    setTags(nextTags);
    setIsDirty(true);
    persistBrowserState(nextTags, nextAnnotations);
    setShowTagDialog(false);
    setCapturingShortcut(null);
    setTagDraft({
      name: "",
      definition: "",
      color: TAG_COLORS[tagList.length % TAG_COLORS.length],
      shortcut: String(Math.min(tagList.length + 1, 9)),
    });
    void persistDesktopWorkspace(nextTags, nextAnnotations, "标签保存失败");
  };

  const handleDeleteTag = (name: string) => {
    const nextTags = { ...tags };
    delete nextTags[name];
    const nextAnnotations = cloneAnnotations(annotations);
    nextAnnotations.dataset = nextAnnotations.dataset.filter(
      (item) => item !== name,
    );
    Object.keys(nextAnnotations.rows).forEach((key) => {
      nextAnnotations.rows[key] = nextAnnotations.rows[key].filter(
        (item) => item !== name,
      );
    });
    Object.keys(nextAnnotations.columns).forEach((key) => {
      nextAnnotations.columns[key] = nextAnnotations.columns[key].filter(
        (item) => item !== name,
      );
    });
    Object.keys(nextAnnotations.cells).forEach((row) =>
      Object.keys(nextAnnotations.cells[row]).forEach((column) => {
        nextAnnotations.cells[row][column] = nextAnnotations.cells[row][
          column
        ].filter((item) => item !== name);
      }),
    );
    rememberChange();
    setTags(nextTags);
    setAnnotations(nextAnnotations);
    setIsDirty(true);
    persistBrowserState(nextTags, nextAnnotations);
    setShowTagDialog(false);
    setCapturingShortcut(null);
    setTagDraft({
      name: "",
      definition: "",
      color: TAG_COLORS[tagList.length % TAG_COLORS.length],
      shortcut: String(Math.min(tagList.length + 1, 9)),
    });
    void deleteDesktopTag(name);
  };

  const updateShortcut = useCallback(
    async (tagName: string, shortcut: string) => {
      const tag = tags[tagName];
      if (!tag) return;
      const nextTag = { ...tag, shortcut };
      const nextTags = { ...tags, [tagName]: nextTag };
      rememberChange();
      setTags(nextTags);
      setIsDirty(true);
      persistBrowserState(nextTags, annotations);
      await persistDesktopWorkspace(nextTags, annotations, "快捷键保存失败");
    },
    [
      annotations,
      persistDesktopWorkspace,
      persistBrowserState,
      showNotice,
      tags,
    ],
  );

  useEffect(() => {
    if (!capturingShortcut) return undefined;
    const capture = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCapturingShortcut(null);
        return;
      }
      if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return;
      const shortcut = shortcutFromEvent(event);
      if (!shortcut) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (capturingShortcut === TAG_DRAFT_SHORTCUT)
        setTagDraft((previous) => ({ ...previous, shortcut }));
      else void updateShortcut(capturingShortcut, shortcut);
      setCapturingShortcut(null);
    };
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [capturingShortcut, updateShortcut]);

  useEffect(() => {
    if (!openColumnFilter) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(".column-filter-menu") ||
          target.closest(".column-filter-button"))
      )
        return;
      setOpenColumnFilter(null);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [openColumnFilter]);

  useEffect(() => {
    if (!showGuide) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".guide-wrap")) return;
      setShowGuide(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [showGuide]);

  useEffect(() => {
    if (!showColumnVisibility) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".column-visibility-wrap")
      )
        return;
      setShowColumnVisibility(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [showColumnVisibility]);

  const handleTagFileInput = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = parseTagExportContent(await file.text());
      const nextTags = { ...tags, ...imported.tags };
      const nextAnnotations = imported.hasAnnotations
        ? imported.annotations
        : annotations;
      rememberChange();
      setTags(nextTags);
      setAnnotations(nextAnnotations);
      setIsDirty(true);
      persistBrowserState(nextTags, nextAnnotations);
      if (isDesktop() && filePath) {
        await enqueueDesktopWrite(async () => {
          if (imported.hasAnnotations)
            await invoke("save_workspace", {
              csvPath: filePath,
              tags: nextTags,
              annotations: nextAnnotations,
            });
          else
            for (const tag of Object.values(imported.tags))
              await invoke("create_tag", { csvPath: filePath, ...tag });
        });
      }
    } catch (error) {
      showNotice(`标签文件无效：${String(error)}`);
    }
    event.target.value = "";
  };

  const copyTagTemplate = async () => {
    try {
      await navigator.clipboard.writeText(TAG_TEMPLATE);
      showNotice("已复制标签样例 JSON");
    } catch {
      downloadFile(
        "tagger-tags-template.json",
        TAG_TEMPLATE,
        "application/json",
      );
      showNotice("已下载标签样例 JSON");
    }
  };

  const tagCount = (name: string) => {
    let count = annotations.dataset.includes(name) ? 1 : 0;
    count += Object.values(annotations.rows).filter((list) =>
      list.includes(name),
    ).length;
    count += Object.values(annotations.columns).filter((list) =>
      list.includes(name),
    ).length;
    count += Object.values(annotations.cells)
      .flatMap((cells) => Object.values(cells))
      .filter((list) => list.includes(name)).length;
    return count;
  };

  const activeColumnFilters = useMemo(
    () => Object.entries(columnFilters).filter(([, value]) => value.trim()),
    [columnFilters],
  );
  const activeColumnTagFilters = useMemo(
    () => Object.entries(columnTagFilters).filter(([, value]) => value.trim()),
    [columnTagFilters],
  );
  const activeColumnValueFilters = useMemo(
    () => Object.entries(columnValueSelections),
    [columnValueSelections],
  );
  const hasColumnValueFilter = (header: string) =>
    Object.prototype.hasOwnProperty.call(columnValueSelections, header);
  const visibleRows = useMemo(() => {
    if (!data) return [];
    const search = globalValue.trim().toLowerCase();
    return data.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row, index }) => {
        const globalMatch =
          !search ||
          row.some((cell) => cell.toLowerCase().includes(search));
        const valueMatch = activeColumnFilters.every(([header, value]) =>
          row[data.headers.indexOf(header)]
            ?.toLowerCase()
            .includes(value.trim().toLowerCase()),
        );
        const selectedValueMatch = activeColumnValueFilters.every(
          ([header, values]) => {
            const value = row[data.headers.indexOf(header)] ?? "";
            return columnValueFilterModes[header] === "exclude"
              ? !values.includes(value)
              : values.includes(value);
          },
        );
        const tagMatch = activeColumnTagFilters.every(
          ([header, tag]) =>
            getEffectiveCellTags(index, header).includes(tag),
        );
        return globalMatch && valueMatch && selectedValueMatch && tagMatch;
      });
  }, [
    activeColumnFilters,
    activeColumnValueFilters,
    activeColumnTagFilters,
    columnValueFilterModes,
    data,
    globalValue,
    annotations,
  ]);

  useEffect(() => {
    const element = tableWrapRef.current;
    if (!element) return undefined;
    const updateViewport = () =>
      setTableViewport({ top: element.scrollTop, height: element.clientHeight });
    updateViewport();
    element.addEventListener("scroll", updateViewport, { passive: true });
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updateViewport)
        : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", updateViewport);
      observer?.disconnect();
    };
  }, [data, editorMode, tagPanelDock]);

  useEffect(() => {
    const element = tableWrapRef.current;
    if (!element) return;
    const restore = tableScrollRestoreRef.current;
    tableScrollRestoreRef.current = null;
    if (restore) {
      const frame = window.requestAnimationFrame(() => {
        element.scrollTop = Math.min(
          restore.top,
          Math.max(0, element.scrollHeight - element.clientHeight),
        );
        element.scrollLeft = restore.left;
        setTableViewport({ top: element.scrollTop, height: element.clientHeight });
      });
      return () => window.cancelAnimationFrame(frame);
    }
    element.scrollTop = 0;
    element.scrollLeft = 0;
    setTableViewport({ top: 0, height: element.clientHeight });
  }, [
    data,
    globalValue,
    columnFilters,
    columnValueSelections,
    columnValueFilterModes,
    columnTagFilters,
  ]);

  const virtualRows = useMemo(() => {
    if (!visibleRows.length)
      return { rows: [] as Array<{ row: string[]; index: number }>, top: 0, bottom: 0 };
    const viewportRows = Math.ceil(Math.max(tableViewport.height, 300) / TABLE_ROW_HEIGHT);
    const firstRow = Math.floor(tableViewport.top / TABLE_ROW_HEIGHT);
    const start = Math.max(
      0,
      Math.min(visibleRows.length - 1, firstRow - TABLE_OVERSCAN),
    );
    const end = Math.min(
      visibleRows.length,
      start + viewportRows + TABLE_OVERSCAN * 2,
    );
    return {
      rows: visibleRows.slice(start, end),
      top: start * TABLE_ROW_HEIGHT,
      bottom: (visibleRows.length - end) * TABLE_ROW_HEIGHT,
    };
  }, [tableViewport, visibleRows]);

  const startEdit = (row: number, column: number) => {
    if (data && editorMode === "edit") {
      setEditingCell({ row, col: column });
      setEditingValue(data.rows[row][column]);
    }
  };
  const finishEdit = () => {
    commitEditing();
  };
  const selectAllCells = () => {
    if (!data || data.rows.length === 0) return;
    setSelectedRows(new Set());
    setSelectedColumns(new Set());
    setSelectedRange({
      startRow: 0,
      startCol: 0,
      endRow: data.rows.length - 1,
      endCol: data.headers.length - 1,
    });
  };
  const moveSelection = (
    rowDelta: number,
    columnDelta: number,
    extend = false,
  ) => {
    if (!data || data.rows.length === 0 || data.headers.length === 0) return;
    const row =
      selectedRange?.endRow ??
      (selectedRows.size ? Math.min(...selectedRows) : 0);
    const column =
      selectedRange?.endCol ??
      (selectedColumns.size ? Math.min(...selectedColumns) : 0);
    const nextRow = Math.max(0, Math.min(data.rows.length - 1, row + rowDelta));
    const nextColumn = Math.max(
      0,
      Math.min(data.headers.length - 1, column + columnDelta),
    );
    setSelectedRows(new Set());
    setSelectedColumns(new Set());
    setSelectedRange((previous) =>
      extend && previous
        ? { ...previous, endRow: nextRow, endCol: nextColumn }
        : {
            startRow: nextRow,
            startCol: nextColumn,
            endRow: nextRow,
            endCol: nextColumn,
          },
    );
  };
  const clearSelectedAnnotations = async () => {
    if (
      !data ||
      editorMode !== "tagger" ||
      (!rangeBounds && selectedRows.size === 0 && selectedColumns.size === 0)
    )
      return;
    const next = cloneAnnotations(annotations);
    let changed = false;
    const clearCell = (row: number, column: number) => {
      const id = `row-${row}`;
      const header = data.headers[column];
      if (next.cells[id]?.[header]?.length) {
        next.cells[id][header] = [];
        changed = true;
      }
    };
    if (rangeBounds)
      for (let row = rangeBounds.top; row <= rangeBounds.bottom; row += 1)
        for (
          let column = rangeBounds.left;
          column <= rangeBounds.right;
          column += 1
        )
          clearCell(row, column);
    else if (selectedRows.size)
      selectedRows.forEach((row) => {
        const id = `row-${row}`;
        if (next.rows[id]?.length) {
          next.rows[id] = [];
          changed = true;
        }
      });
    else if (selectedColumns.size)
      selectedColumns.forEach((column) => {
        const header = data.headers[column];
        if (next.columns[header]?.length) {
          next.columns[header] = [];
          changed = true;
        }
      });
    if (!changed) return;
    rememberChange();
    setAnnotations(next);
    setIsDirty(true);
    persistBrowserState(tags, next);
    try {
      await Promise.all(
        tagList.map((tag) => invokeAnnotation(currentScope, tag.name, true)),
      );
    } catch (error) {
      showNotice(`保存失败：${String(error)}`);
    }
  };

  const clearSelectedCells = () => {
    if (editorMode === "tagger") {
      void clearSelectedAnnotations();
      return;
    }
    if (
      !data ||
      (!rangeBounds && selectedRows.size === 0 && selectedColumns.size === 0)
    )
      return;
    let changed = false;
    const rows = data.rows.map((row, rowIndex) =>
      row.map((cell, columnIndex) => {
        const selected = rangeBounds
          ? rowIndex >= rangeBounds.top &&
            rowIndex <= rangeBounds.bottom &&
            columnIndex >= rangeBounds.left &&
            columnIndex <= rangeBounds.right
          : selectedRows.has(rowIndex) || selectedColumns.has(columnIndex);
        if (selected && cell !== "") changed = true;
        return selected ? "" : cell;
      }),
    );
    if (!changed) return;
    rememberChange();
    setData({ ...data, rows });
    setIsDirty(true);
  };
  const copySelection = async () => {
    if (!data || !rangeBounds || !navigator.clipboard) return;
    const text = data.rows
      .slice(rangeBounds.top, rangeBounds.bottom + 1)
      .map((row) =>
        row.slice(rangeBounds.left, rangeBounds.right + 1).join("\t"),
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      showNotice("已复制");
    } catch (error) {
      showNotice(`复制失败：${String(error)}`);
    }
  };
  const pasteSelection = async () => {
    if (editorMode !== "edit" || !data || !navigator.clipboard) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const pastedRows = text
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n")
        .filter((row, index, all) => row.length > 0 || index < all.length - 1)
        .map((row) => row.split("\t"));
      const startRow =
        rangeBounds?.top ?? (selectedRows.size ? Math.min(...selectedRows) : 0);
      const startColumn =
        rangeBounds?.left ??
        (selectedColumns.size ? Math.min(...selectedColumns) : 0);
      const rows = data.rows.map((row) => [...row]);
      let changed = false;
      pastedRows.forEach((pastedRow, rowOffset) =>
        pastedRow.forEach((value, columnOffset) => {
          const rowIndex = startRow + rowOffset;
          const columnIndex = startColumn + columnOffset;
          if (
            rowIndex < rows.length &&
            columnIndex < data.headers.length &&
            rows[rowIndex][columnIndex] !== value
          ) {
            rows[rowIndex][columnIndex] = value;
            changed = true;
          }
        }),
      );
      if (!changed) return;
      rememberChange();
      setData({ ...data, rows });
      setIsDirty(true);
    } catch (error) {
      showNotice(`粘贴失败：${String(error)}`);
    }
  };
  const undoWorkspace = () => {
    const previous = historyRef.current.pop();
    const current = currentSnapshot();
    if (!previous || !current) return;
    const element = tableWrapRef.current;
    if (element)
      tableScrollRestoreRef.current = {
        top: element.scrollTop,
        left: element.scrollLeft,
      };
    futureRef.current = [...futureRef.current, current].slice(-100);
    workspaceRevisionRef.current += 1;
    setData(previous.data);
    setTags(previous.tags);
    setAnnotations(previous.annotations);
    setHiddenColumns(new Set(previous.filters.hiddenColumns));
    setColumnFilters(previous.filters.columnFilters);
    setColumnValueSelections(previous.filters.columnValueSelections);
    setColumnValueFilterModes(previous.filters.columnValueFilterModes);
    setColumnTagFilters(previous.filters.columnTagFilters);
    setOpenColumnFilter(null);
    setEditingCell(null);
    setIsDirty(true);
  };
  const redoWorkspace = () => {
    const next = futureRef.current.pop();
    const current = currentSnapshot();
    if (!next || !current) return;
    const element = tableWrapRef.current;
    if (element)
      tableScrollRestoreRef.current = {
        top: element.scrollTop,
        left: element.scrollLeft,
      };
    historyRef.current = [...historyRef.current, current].slice(-100);
    workspaceRevisionRef.current += 1;
    setData(next.data);
    setTags(next.tags);
    setAnnotations(next.annotations);
    setHiddenColumns(new Set(next.filters.hiddenColumns));
    setColumnFilters(next.filters.columnFilters);
    setColumnValueSelections(next.filters.columnValueSelections);
    setColumnValueFilterModes(next.filters.columnValueFilterModes);
    setColumnTagFilters(next.filters.columnTagFilters);
    setOpenColumnFilter(null);
    setEditingCell(null);
    setIsDirty(true);
  };
  const selectRow = (row: number, event: React.MouseEvent) => {
    setSelectedRange(null);
    setSelectedColumns(new Set());
    setSelectedRows((previous) => {
      if (event.shiftKey && previous.size) {
        const start = Math.min(...previous);
        const end = Math.max(...previous, row);
        return new Set(
          Array.from({ length: end - start + 1 }, (_, index) => start + index),
        );
      }
      if (event.metaKey || event.ctrlKey) {
        const next = new Set(previous);
        next.has(row) ? next.delete(row) : next.add(row);
        return next;
      }
      return new Set([row]);
    });
  };
  const selectColumn = (column: number, event: React.MouseEvent) => {
    setSelectedRange(null);
    setSelectedRows(new Set());
    setSelectedColumns((previous) => {
      if (event.shiftKey && previous.size) {
        const start = Math.min(...previous);
        const end = Math.max(...previous, column);
        return new Set(
          Array.from({ length: end - start + 1 }, (_, index) => start + index),
        );
      }
      if (event.metaKey || event.ctrlKey) {
        const next = new Set(previous);
        next.has(column) ? next.delete(column) : next.add(column);
        return next;
      }
      return new Set([column]);
    });
  };
  const startCellSelection = (
    row: number,
    column: number,
    event: React.MouseEvent,
  ) => {
    if (event.button !== 0) return;
    setSelectedRows(new Set());
    setSelectedColumns(new Set());
    const start =
      event.shiftKey && selectedRange
        ? { row: selectedRange.startRow, column: selectedRange.startCol }
        : { row, column };
    setSelectedRange({
      startRow: start.row,
      startCol: start.column,
      endRow: row,
      endCol: column,
    });
    draggingRef.current = true;
  };
  const extendCellSelection = (row: number, column: number) => {
    if (draggingRef.current)
      setSelectedRange((previous) =>
        previous ? { ...previous, endRow: row, endCol: column } : previous,
      );
  };
  const beginResize = (event: React.PointerEvent<HTMLElement>, column: number) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizingRef.current = {
      column,
      startX: event.clientX,
      startWidth: columnWidths[column] ?? 180,
      pointerId: event.pointerId,
    };
  };

  useEffect(() => {
    const pointerMove = (event: PointerEvent) => {
      if (resizingRef.current) {
        const { column, startX, startWidth } = resizingRef.current;
        setColumnWidths((previous) => ({
          ...previous,
          [column]: Math.max(36, startWidth + event.clientX - startX),
        }));
      }
    };
    const pointerUp = (event: PointerEvent) => {
      if (
        resizingRef.current &&
        event.pointerId !== resizingRef.current.pointerId
      )
        return;
      draggingRef.current = false;
      resizingRef.current = null;
    };
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    return () => {
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
    };
  }, []);

  const updateColumnValueFilter = (header: string, value: string) => {
    if (columnFilters[header] === value) return;
    rememberChange();
    setColumnFilters((previous) => ({ ...previous, [header]: value }));
    setIsDirty(true);
  };
  const updateColumnTagFilter = (header: string, value: string) => {
    if (columnTagFilters[header] === value) return;
    rememberChange();
    setColumnTagFilters((previous) => ({ ...previous, [header]: value }));
    setIsDirty(true);
  };
  const setColumnValueMode = (
    header: string,
    mode: ColumnValueFilterMode,
  ) => {
    if ((columnValueFilterModes[header] ?? "include") === mode) return;
    rememberChange();
    setColumnValueFilterModes((previous) => ({ ...previous, [header]: mode }));
    setIsDirty(true);
  };
  const toggleColumnValue = (header: string, value: string) => {
    const allValues = columnUniqueValues[header] ?? [];
    const hasSelection = Object.prototype.hasOwnProperty.call(
      columnValueSelections,
      header,
    );
    const current = hasSelection
      ? columnValueSelections[header]
      : columnValueFilterModes[header] === "exclude"
        ? []
        : allValues;
    const nextValues = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    const next = { ...columnValueSelections };
    const mode = columnValueFilterModes[header] ?? "include";
    const noFilter =
      mode === "exclude"
        ? nextValues.length === 0
        : nextValues.length === allValues.length;
    if (noFilter) delete next[header];
    else next[header] = nextValues;
    if (JSON.stringify(next) === JSON.stringify(columnValueSelections)) return;
    rememberChange();
    setColumnValueSelections(next);
    setIsDirty(true);
  };
  const updateVisibleColumnValues = (
    header: string,
    values: string[],
    mode: "select" | "clear" | "invert",
  ) => {
    if (!values.length) return;
    const allValues = columnUniqueValues[header] ?? [];
    const hasSelection = Object.prototype.hasOwnProperty.call(
      columnValueSelections,
      header,
    );
    const selected = new Set(
      hasSelection
        ? columnValueSelections[header]
        : columnValueFilterModes[header] === "exclude"
          ? []
          : allValues,
    );
    values.forEach((value) => {
      if (mode === "select") selected.add(value);
      else if (mode === "clear") selected.delete(value);
      else if (selected.has(value)) selected.delete(value);
      else selected.add(value);
    });
    const nextValues = allValues.filter((value) => selected.has(value));
    const next = { ...columnValueSelections };
    const filterMode = columnValueFilterModes[header] ?? "include";
    const noFilter =
      filterMode === "exclude"
        ? nextValues.length === 0
        : nextValues.length === allValues.length;
    if (noFilter) delete next[header];
    else next[header] = nextValues;
    if (JSON.stringify(next) === JSON.stringify(columnValueSelections)) return;
    rememberChange();
    setColumnValueSelections(next);
    setIsDirty(true);
  };
  const clearColumnFilters = (header: string) => {
    const current = getCurrentFilters();
    const next = cloneFilters(current);
    delete next.columnFilters[header];
    delete next.columnTagFilters[header];
    delete next.columnValueSelections[header];
    delete next.columnValueFilterModes[header];
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    rememberChange();
    setColumnFilters(next.columnFilters);
    setColumnTagFilters(next.columnTagFilters);
    setColumnValueSelections(next.columnValueSelections);
    setColumnValueFilterModes(next.columnValueFilterModes);
    setIsDirty(true);
  };

  const toggleColumnVisibility = (column: number) => {
    const next = new Set(hiddenColumns);
    if (next.has(column)) next.delete(column);
    else next.add(column);
    rememberChange();
    setHiddenColumns(next);
    setIsDirty(true);
  };
  const invertColumnVisibility = () => {
    if (!data) return;
    const next = new Set<number>();
    data.headers.forEach((_, column) => {
      if (!hiddenColumns.has(column)) next.add(column);
    });
    if (next.size === hiddenColumns.size && [...next].every((column) => hiddenColumns.has(column)))
      return;
    rememberChange();
    setHiddenColumns(next);
    setIsDirty(true);
  };
  const showAllColumns = () => {
    if (!hiddenColumns.size) return;
    rememberChange();
    setHiddenColumns(new Set());
    setIsDirty(true);
  };

  const createTagsExport = () =>
    serializeTagsExport(fileName, delimiter, tags, annotations);
  const baseFileName = (fileName || "data").replace(/\.(csv|tsv)$/i, "");
  const cleanCurrentArchive = () => {
    if (archiveSlot === null) return;
    setArchives((previous) =>
      previous.map((item, index) => (index === archiveSlot ? null : item)),
    );
    setArchiveSlot(null);
  };
  const exportChoice = async (choice: ExportOption) => {
    if (!data || !fileName) return;
    let exported = false;
    try {
      if (choice === "both") {
        const blob = createArchiveBundle([
          {
            fileName,
            filePath,
            delimiter,
            data,
            tags,
            annotations,
            filters: cloneFilters(getCurrentFilters()),
            updatedAt: Date.now(),
          },
        ]);
        exported = await exportFile(
          `${fileName}.zip`,
          new Uint8Array(await blob.arrayBuffer()),
          "application/zip",
          "zip",
        );
      } else if (choice === "csv") {
        const extension = delimiter === "\t" ? "tsv" : "csv";
        exported = await exportFile(
          `${baseFileName}.${extension}`,
          serializeDelimited(data, delimiter),
          "text/plain;charset=utf-8",
          extension,
        );
      } else {
        exported = await exportFile(
          `${baseFileName}.tags.json`,
          createTagsExport(),
          "application/json",
          "json",
        );
      }
    } catch (error) {
      showNotice(`导出失败：${String(error)}`);
    }
    setShowExportMenu(false);
    if (
      exported &&
      (choice === "csv" || choice === "both") &&
      archiveSlot !== null &&
      window.confirm("表格已导出，是否清理当前存档？")
    )
      cleanCurrentArchive();
  };
  const exportArchiveChoice = async (choice: ExportOption) => {
    const selected = Array.from(selectedArchiveSlots)
      .sort((a, b) => a - b)
      .map((index) => archives[index])
      .filter((slot): slot is ArchiveSlot => !!slot);
    if (!selected.length) {
      showNotice("请先选择要导出的存档");
      setShowArchiveExportMenu(false);
      return;
    }
    let exportedCount = 0;
    try {
      if (choice === "both") {
        const exported = await exportFile(
          `tagger-export-${selected.length}.zip`,
          new Uint8Array(await createArchiveBundle(selected).arrayBuffer()),
          "application/zip",
          "zip",
        );
        exportedCount = exported ? selected.length : 0;
      } else {
        for (const slot of selected) {
          const base = slot.fileName.replace(/\.(csv|tsv)$/i, "");
          const extension = choice === "csv"
            ? slot.delimiter === "\t" ? "tsv" : "csv"
            : "json";
          const exported = await exportFile(
            choice === "csv" ? `${base}.${extension}` : `${base}.tags.json`,
            choice === "csv"
              ? serializeDelimited(slot.data, slot.delimiter)
              : serializeTagsExport(
                  slot.fileName,
                  slot.delimiter,
                  slot.tags,
                  slot.annotations,
                ),
            choice === "csv" ? "text/plain;charset=utf-8" : "application/json",
            extension,
          );
          if (!exported) break;
          exportedCount += 1;
        }
      }
    } catch (error) {
      showNotice(`导出失败：${String(error)}`);
    }
    setShowArchiveExportMenu(false);
    if (exportedCount) showNotice(`已导出 ${exportedCount} 个存档`);
  };
  const downloadData = () => {
    if (!data) return;
    downloadFile(
      `${baseFileName}${delimiter === "\t" ? ".tsv" : ".csv"}`,
      serializeDelimited(data, delimiter),
      "text/plain;charset=utf-8",
    );
  };

  const toggleEditorMode = useCallback(() => {
    setEditorMode((previous) => {
      const next = previous === "tagger" ? "edit" : "tagger";
      showNotice(next === "tagger" ? "标注模式" : "编辑模式");
      return next;
    });
    setEditingCell(null);
    setOpenColumnFilter(null);
    setShowExportMenu(false);
  }, [showNotice]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (capturingShortcut) return;
      const commandKey = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement;
      const isFormField = target?.matches(
        'input, textarea, select, [contenteditable="true"]',
      );
      if (commandKey && event.key.toLowerCase() === "s" && data) {
        event.preventDefault();
        const nextData = editingCell ? commitEditing() : undefined;
        void saveWorkspace(nextData ?? undefined);
        return;
      }
      if (archiveDeleteTarget !== null) {
        if (event.key === "Escape") {
          event.preventDefault();
          setArchiveDeleteTarget(null);
        }
        return;
      }
      if (showGuide) {
        if (event.key === "Escape") {
          event.preventDefault();
          setShowGuide(false);
        }
        return;
      }
      if (showColumnVisibility && event.key === "Escape") {
        event.preventDefault();
        setShowColumnVisibility(false);
        return;
      }
      if (showArchiveExportMenu && event.key === "Escape") {
        event.preventDefault();
        setShowArchiveExportMenu(false);
        return;
      }
      if (commandKey && event.key.toLowerCase() === "k" && data) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (isFormField) return;
      if (event.shiftKey && event.key.toLowerCase() === "l" && data) {
        event.preventDefault();
        toggleEditorMode();
        return;
      }
      if (commandKey && event.key.toLowerCase() === "f" && data) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (commandKey && event.key.toLowerCase() === "c" && data) {
        event.preventDefault();
        void copySelection();
        return;
      }
      if (
        commandKey &&
        event.key.toLowerCase() === "v" &&
        data &&
        editorMode === "edit"
      ) {
        event.preventDefault();
        void pasteSelection();
        return;
      }
      if (commandKey && event.key.toLowerCase() === "z" && data) {
        event.preventDefault();
        event.shiftKey ? redoWorkspace() : undoWorkspace();
        return;
      }
      if (commandKey && event.key.toLowerCase() === "y" && data) {
        event.preventDefault();
        redoWorkspace();
        return;
      }
      if (commandKey && event.key.toLowerCase() === "a" && data) {
        event.preventDefault();
        selectAllCells();
        return;
      }
      if (commandKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        handleOpen();
        return;
      }
      if (event.key === "Escape") {
        setOpenColumnFilter(null);
        setShowExportMenu(false);
        setEditingCell(null);
        clearSelection();
        return;
      }
      if ((event.key === "Backspace" || event.key === "Delete") && data) {
        event.preventDefault();
        clearSelectedCells();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1, 0, event.shiftKey);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1, 0, event.shiftKey);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveSelection(0, -1, event.shiftKey);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        moveSelection(0, 1, event.shiftKey);
        return;
      }
      if (event.key === "Tab" && selectedRange) {
        event.preventDefault();
        moveSelection(0, event.shiftKey ? -1 : 1);
        return;
      }
      if (
        editorMode === "edit" &&
        event.key === "Enter" &&
        selectedRange &&
        rangeSize === 1
      ) {
        event.preventDefault();
        startEdit(selectedRange.startRow, selectedRange.startCol);
        return;
      }
      if (event.key.toLowerCase() === "t" && editorMode === "tagger") {
        event.preventDefault();
        document.querySelector<HTMLElement>("[data-tag-list]")?.focus();
        return;
      }
      if (editorMode !== "tagger") return;
      const tag = tagList.find((item) =>
        shortcutMatches(event, item.shortcut, true),
      );
      if (tag) {
        event.preventDefault();
        const remove =
          event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !normalizeShortcut(tag.shortcut).startsWith("Shift+");
        void applyTag(tag.name, remove);
      }
    },
    [
      applyTag,
      archiveDeleteTarget,
      capturingShortcut,
      clearSelectedCells,
      clearSelection,
      commitEditing,
      copySelection,
      data,
      editingCell,
      editorMode,
      handleOpen,
      moveSelection,
      pasteSelection,
      redoWorkspace,
      saveWorkspace,
      selectAllCells,
      selectedRange,
      showArchiveExportMenu,
      showColumnVisibility,
      showGuide,
      startEdit,
      tagList,
      toggleEditorMode,
      undoWorkspace,
    ],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const isCellSelected = (row: number, column: number) =>
    !!rangeBounds &&
    row >= rangeBounds.top &&
    row <= rangeBounds.bottom &&
    column >= rangeBounds.left &&
    column <= rangeBounds.right;

  const filterValues = openColumnFilter
    ? columnUniqueValues[openColumnFilter] ?? []
    : [];
  const filterColumnIndex =
    data && openColumnFilter ? data.headers.indexOf(openColumnFilter) : -1;
  const filterValueCounts = data && openColumnFilter
    ? data.rows.reduce<Record<string, number>>((counts, row) => {
        const value = row[filterColumnIndex] ?? "";
        counts[value] = (counts[value] ?? 0) + 1;
        return counts;
      }, {}) ?? {}
    : {};
  const filterSearch = openColumnFilter
    ? (columnFilters[openColumnFilter] ?? "").trim().toLowerCase()
    : "";
  const visibleFilterValues = filterValues.filter((value) =>
    value.toLowerCase().includes(filterSearch),
  );
  const hasExplicitValueSelection =
    !!openColumnFilter &&
    Object.prototype.hasOwnProperty.call(
      columnValueSelections,
      openColumnFilter,
    );
  const activeValueFilterMode: ColumnValueFilterMode = openColumnFilter
    ? columnValueFilterModes[openColumnFilter] ?? "include"
    : "include";
  const selectedFilterValues = new Set(
    hasExplicitValueSelection && openColumnFilter
      ? columnValueSelections[openColumnFilter]
      : activeValueFilterMode === "exclude"
        ? []
        : filterValues,
  );
  const allVisibleValuesSelected =
    visibleFilterValues.length > 0 &&
    visibleFilterValues.every((value) => selectedFilterValues.has(value));
  const visibleColumnIndexes = data
    ? data.headers.map((_, index) => index).filter((index) => !hiddenColumns.has(index))
    : [];
  const selectedCellPreview =
    data && selectedRange && rangeSize === 1
      ? {
          header: data.headers[selectedRange.startCol],
          value: data.rows[selectedRange.startRow][selectedRange.startCol] ?? "",
        }
      : null;

  return (
    <div className={`app-shell theme-${theme} mode-${editorMode}`}>
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept=".csv,.tsv,text/csv,text/tab-separated-values"
        onChange={handleFileInput}
      />
      <input
        ref={archiveInputRef}
        className="visually-hidden"
        type="file"
        multiple
        accept=".csv,.tsv,.json,.zip,text/csv,text/tab-separated-values,application/json,application/zip"
        onChange={handleArchiveFileInput}
      />
      <input
        ref={tagFileInputRef}
        className="visually-hidden"
        type="file"
        accept=".json,application/json"
        onChange={handleTagFileInput}
      />
      <header className="topbar">
        <div className="brand-lockup">
          <img className="brand-mark" src="/tagger-icon.svg" alt="" />
          <strong>Tagger</strong>
        </div>
        <div className="topbar-actions">
          {data && !archiveScreen && (
            <div
              className="export-wrap"
              onMouseEnter={() => setShowExportMenu(true)}
              onMouseLeave={() => setShowExportMenu(false)}
              onFocus={() => setShowExportMenu(true)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setShowExportMenu(false);
              }}
            >
              <button
                className="topbar-button primary"
                onClick={() => setShowExportMenu(true)}
                aria-expanded={showExportMenu}
              >
                导出
              </button>
              {showExportMenu && (
                <div className="export-menu">
                  <div className="export-menu-title">选择导出</div>
                  <button
                    className="export-option default"
                    onClick={() => exportChoice("both")}
                  >
                    <span>CSV + 标签</span>
                    <small>默认</small>
                  </button>
                  <button
                    className="export-option"
                    onClick={() => exportChoice("csv")}
                  >
                    只导出 CSV
                  </button>
                  <button
                    className="export-option"
                    onClick={() => exportChoice("tags")}
                  >
                    只导出标签
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="guide-wrap">
            <button
              className="topbar-button"
              onClick={() => setShowGuide((previous) => !previous)}
              aria-expanded={showGuide}
              aria-label="操作指南"
            >
              指南
            </button>
            {showGuide && (
              <div className="guide-popover" role="dialog" aria-label="操作指南">
                <div className="guide-popover-head">
                  <strong>操作指南</strong>
                  <button
                    className="guide-close"
                    onClick={() => setShowGuide(false)}
                    aria-label="关闭操作指南"
                  >
                    ×
                  </button>
                </div>
                <div className="guide-scroll">
                  <section>
                    <h3>导入</h3>
                    <p>浏览器支持小于 3 MB 的文件；大文件请使用安装版。</p>
                    <p>存档页的“导入 ZIP”用于同时恢复表格和标签，也可选择单个 CSV/TSV 与标签 JSON。</p>
                    <p>本地开发：浏览器执行 <code>npm run dev</code>；桌面执行 <code>npm run tauri dev</code>。</p>
                  </section>
                  <section>
                    <h3>存档与保存</h3>
                    <p>每个文件占一个存档位；编辑中的内容会同步到当前存档，<kbd>⌘/Ctrl+S</kbd> 可立即保存。</p>
                    <p><b>浏览器</b> 使用当前网站的浏览器存储（localStorage / IndexedDB）。刷新通常会保留；清除网站数据、无痕窗口关闭、换浏览器或换设备可能丢失，请导出 ZIP 备份。</p>
                    <p><b>桌面</b> “保存”或 <kbd>⌘/Ctrl+S</kbd> 会写回当前 CSV/TSV，并在同目录生成 <code>文件名.tags.json</code>；“另存为”可选择新位置，成功后会显示完整路径。存档槽仍保存在应用本地数据中；清除应用数据会清空存档槽，但不会替你删除原文件。</p>
                    <p>桌面拖入文件或从 ZIP 恢复的是存档副本，需通过导出得到文件；要保存回原 CSV，请使用导入按钮选择它。</p>
                  </section>
                  <section>
                    <h3>模式</h3>
                    <p><kbd>⇧+L</kbd> 在标注模式与编辑模式之间切换。</p>
                    <p>标注模式只处理标签，右侧显示标签栏，表格内容锁定。</p>
                    <p>编辑模式隐藏标签栏，只编辑表格内容。</p>
                    <p>拖动标签标题可移出侧栏；靠近左、右、上、下边缘出现蓝线时松开即可吸附。</p>
                    <p>吸附后拖动边界可调整宽度或高度；浮动时可从右下角自由缩放。</p>
                  </section>
                  <section>
                    <h3>标注显示</h3>
                    <p><b>填充</b> 使用主标签颜色填充单元格，醒目，适合单标签。</p>
                    <p><b>圆点</b> 并列显示每个标签颜色，适合多标签。</p>
                  </section>
                  <section>
                    <h3>选择</h3>
                    <p>单击或拖动选择单元格；单击行号选行，单击表头选列。</p>
                    <p><kbd>⌘/Ctrl+A</kbd> 选择整张表，<kbd>Delete</kbd> 在标注模式移除选区标签。</p>
                  </section>
                  <section>
                    <h3>筛选与列</h3>
                    <p>表头下拉可按值筛选或按标签筛选，多个列条件会叠加。</p>
                    <p>顶部“列”可选择要显示的参考列；“清除筛选”恢复全部行。</p>
                  </section>
                  <section>
                    <h3>常用</h3>
                    <p><kbd>⌘/Ctrl+S</kbd> 保存，<kbd>⌘/Ctrl+Z</kbd> 撤销，<kbd>⌘/Ctrl+Shift+Z</kbd> 重做。</p>
                    <p>点击标签快捷键后，按下新的组合键即可修改。</p>
                  </section>
                </div>
              </div>
            )}
          </div>
          <button
            className="icon-button"
            onClick={() =>
              setTheme((previous) => (previous === "light" ? "dark" : "light"))
            }
            title="切换亮暗"
          >
            {theme === "light" ? "☾" : "☀"}
          </button>
        </div>
      </header>

      {archiveScreen ? (
        <main
          className={`archive-screen ${isArchiveDragActive ? "is-dragging" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsArchiveDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              setIsArchiveDragActive(false);
          }}
          onDrop={handleArchiveDrop}
        >
          <div className="archive-heading">
            <button className="back-button" onClick={returnHome}>
              ‹ 主页
            </button>
            <div>
              <h1>存档</h1>
              <span>10 个位置</span>
            </div>
            <div
              className="export-wrap archive-export-wrap"
              onMouseEnter={() => {
                if (selectedArchiveSlots.size) setShowArchiveExportMenu(true);
              }}
              onMouseLeave={() => setShowArchiveExportMenu(false)}
              onFocus={() => {
                if (selectedArchiveSlots.size) setShowArchiveExportMenu(true);
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setShowArchiveExportMenu(false);
              }}
            >
              <button
                className="topbar-button primary archive-export-button"
                disabled={!selectedArchiveSlots.size}
                onClick={() => setShowArchiveExportMenu(true)}
                aria-expanded={showArchiveExportMenu}
              >
                导出{selectedArchiveSlots.size ? ` · ${selectedArchiveSlots.size}` : ""}
              </button>
              {showArchiveExportMenu && selectedArchiveSlots.size > 0 && (
                <div className="export-menu">
                  <div className="export-menu-title">导出所选存档</div>
                  <button
                    className="export-option default"
                    onClick={() => exportArchiveChoice("both")}
                  >
                    <span>CSV + 标签 JSON</span>
                    <small>默认</small>
                  </button>
                  <button
                    className="export-option"
                    onClick={() => exportArchiveChoice("csv")}
                  >
                    只导出 CSV
                  </button>
                  <button
                    className="export-option"
                    onClick={() => exportArchiveChoice("tags")}
                  >
                    只导出标签 JSON
                  </button>
                </div>
              )}
            </div>
          </div>
          <div
            className={`archive-dropzone ${importProgress !== null ? "is-importing" : ""}`}
            onClick={() => {
              if (importProgress === null) openArchiveImport("new");
            }}
          >
            <div className="archive-drop-copy">
              <strong>
                {importProgress !== null
                  ? `读取中 ${importProgress}%`
                  : isArchiveDragActive
                    ? "松开导入"
                    : "导入 CSV / TSV"}
              </strong>
              <span>
                {importProgress !== null
                  ? "读取在后台进行"
                  : isDesktop()
                    ? "拖入或点击选择文件"
                    : "拖入或点击选择文件 · 浏览器支持 < 3 MB"}
              </span>
            </div>
            {importProgress === null && (
              <div
                className="archive-import-actions"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="archive-import-action"
                  onClick={() => openArchiveImport("new")}
                >
                  新建标注
                </button>
                <button
                  type="button"
                  className="archive-import-action primary"
                  onClick={() => openArchiveImport("restore")}
                  title="导入 ZIP（包含 CSV/TSV 和标签 JSON）"
                >
                  导入 ZIP
                </button>
                <small className="archive-import-hint">
                  ZIP 内含 CSV + 标签 JSON
                </small>
              </div>
            )}
          </div>
          <div className="archive-grid">
            {archives.map((slot, index) => (
              <div
                key={index}
                className={`archive-card ${slot ? "occupied" : "empty"}`}
              >
                <button
                  className="archive-open"
                  onClick={() => openArchive(index)}
                >
                  <span className="archive-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {slot ? (
                    <strong>{slot.fileName}</strong>
                  ) : (
                    <strong>空存档</strong>
                  )}
                  {slot ? (
                    <small>
                      {slot.data.rowCount} 行 ·{" "}
                      {new Date(slot.updatedAt).toLocaleDateString()}
                    </small>
                  ) : (
                    <small>点击导入文件</small>
                  )}
                  {slot && <em>继续</em>}
                </button>
                {slot && (
                  <label
                    className="archive-select"
                    onClick={(event) => event.stopPropagation()}
                    title="选择导出"
                  >
                    <input
                      type="checkbox"
                      checked={selectedArchiveSlots.has(index)}
                      onChange={() => toggleArchiveSelection(index)}
                      aria-label={`选择导出 ${slot.fileName}`}
                    />
                  </label>
                )}
                {slot && (
                    <button
                      className="archive-delete"
                      onClick={(event) => {
                        event.stopPropagation();
                        requestDeleteArchive(index);
                      }}
                      aria-label={`删除存档 ${index + 1}`}
                      title="删除存档"
                    >
                      ×
                    </button>
                )}
              </div>
            ))}
          </div>
        </main>
      ) : !data ? (
        <main className="empty-state">
          <div className="empty-panel">
            <img className="empty-brand-mark" src="/tagger-icon.svg" alt="Tagger" />
            <h1>Tagger</h1>
            <div className="empty-actions">
              <button className="primary-button" onClick={handleOpen}>
                导入 CSV / TSV
              </button>
            </div>
          </div>
        </main>
      ) : (
        <main
          className={`workspace ${tagPanelDock === "floating" ? "panel-floating" : `panel-${tagPanelDock}`} ${tagPanelResizeAxis ? `panel-resizing-${tagPanelResizeAxis}` : ""}`}
          style={
            editorMode === "tagger" && tagPanelDock !== "floating"
              ? ({
                  "--tag-panel-width": `${tagPanelSize.width}px`,
                  "--tag-panel-height": `${tagPanelSize.height}px`,
                } as React.CSSProperties)
              : undefined
          }
        >
          {editorMode === "tagger" && isTagPanelDragging && (
            <div
              className={`dock-indicator ${tagPanelDockTarget ? `active dock-${tagPanelDockTarget}` : ""}`}
              aria-hidden="true"
            />
          )}
          <section className="data-pane">
            <div className="workspace-bar">
              <div className="file-title">
                <button
                  className="back-button"
                  onClick={returnHome}
                  title="返回主页"
                >
                  ‹
                </button>
                <div>
                  <strong>{fileName}</strong>
                  <span>
                    {data.rowCount} 行 · {data.columnCount} 列
                  </span>
                </div>
              </div>
              <div className="bar-actions">
                <button
                  className="mode-switch"
                  onClick={toggleEditorMode}
                  title="Shift + L 切换模式"
                >
                  {editorMode === "tagger" ? "标注模式" : "编辑模式"}
                  <kbd>⇧+L</kbd>
                </button>
                <button
                  className="save-button"
                  onClick={() => void saveWorkspace()}
                  disabled={isSaving}
                  title="保存当前工作区（⌘/Ctrl+S）"
                >
                  {isSaving ? "保存中…" : "保存"}
                  <kbd>⌘S</kbd>
                </button>
                {isDesktop() && (
                  <button
                    className="small-button"
                    onClick={() => void saveWorkspaceAs()}
                    disabled={isSaving}
                    title="选择新的保存位置"
                  >
                    另存为
                  </button>
                )}
                <label className="search-box">
                  <span>⌕</span>
                  <input
                    ref={searchInputRef}
                    value={globalValue}
                    onChange={(event) => setGlobalValue(event.target.value)}
                    placeholder="筛选"
                    aria-label="全局筛选"
                  />
                  <kbd>⌘K</kbd>
                </label>
                <div className="column-visibility-wrap">
                  <button
                    className={`small-button ${hiddenColumns.size ? "active" : ""}`}
                    onClick={() => setShowColumnVisibility((previous) => !previous)}
                    aria-expanded={showColumnVisibility}
                  >
                    列{hiddenColumns.size ? ` · ${hiddenColumns.size}` : ""}
                  </button>
                  {showColumnVisibility && (
                    <div
                      className="column-visibility-menu"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="column-visibility-head">
                        <strong>显示列</strong>
                        <div className="column-visibility-actions">
                          <button
                            className="value-filter-link"
                            onClick={invertColumnVisibility}
                          >
                            反选
                          </button>
                          <button
                            className="value-filter-link"
                            onClick={showAllColumns}
                          >
                            全部显示
                          </button>
                        </div>
                      </div>
                      <div className="column-visibility-list">
                        {data.headers.map((header, column) => (
                          <label key={header + column}>
                            <input
                              type="checkbox"
                              checked={!hiddenColumns.has(column)}
                              onChange={() => toggleColumnVisibility(column)}
                            />
                            <span>{header}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <button className="small-button" onClick={clearAllFilters}>
                  清除筛选
                </button>
              </div>
            </div>
            <div
              className={`cell-preview ${selectedCellPreview ? "has-selection" : ""}`}
              title={selectedCellPreview?.value}
              aria-live="polite"
            >
              <span>{selectedCellPreview?.header}</span>
              <div>{selectedCellPreview?.value || (selectedCellPreview ? "空白" : "")}</div>
            </div>
            <div className="table-wrap" ref={tableWrapRef}>
              <table className="data-table">
                <colgroup>
                  <col className="index-col" />
                  {visibleColumnIndexes.map((index) => (
                    <col
                      key={data.headers[index] + index}
                      style={{ width: `${columnWidths[index] ?? 180}px` }}
                    />
                  ))}
                  <col className="tags-col-width" />
                </colgroup>
                <thead>
                  <tr>
                    <th className="row-index-head">#</th>
                    {visibleColumnIndexes.map((column) => {
                      const header = data.headers[column];
                      return (
                      <th
                        key={header + column}
                        className={`${selectedColumns.has(column) ? "column-selected" : ""} ${columnFilters[header] || columnTagFilters[header] || hasColumnValueFilter(header) ? "filter-active" : ""}`}
                        style={{ width: `${columnWidths[column] ?? 180}px` }}
                        onClick={(event) => selectColumn(column, event)}
                        title="选择整列"
                      >
                        <span>{header}</span>
                        <button
                          className="column-filter-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpenColumnFilter((previous) =>
                              previous === header ? null : header,
                            );
                            setActiveFilterTab(
                              columnTagFilters[header] ? "tag" : "value",
                            );
                          }}
                          title="筛选这一列"
                        >
                          ⌄
                        </button>
                        {(columnFilters[header] ||
                          columnTagFilters[header] ||
                          hasColumnValueFilter(header)) && (
                          <i className="filter-dot" />
                        )}
                        {getColumnTags(header).map((tag) => (
                          <span
                            key={tag}
                            className="column-mark"
                            style={{ backgroundColor: tags[tag]?.color }}
                          >
                            {tag}
                          </span>
                        ))}
                        <span
                          className="resize-handle"
                          onPointerDown={(event) => beginResize(event, column)}
                        />
                        {openColumnFilter === header && (
                          <div
                            className="column-filter-menu"
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                setOpenColumnFilter(null);
                              }
                            }}
                          >
                            <div className="column-menu-title">
                              筛选 · {header}
                            </div>
                            <div className="column-filter-tabs">
                              <button
                                className={
                                  activeFilterTab === "value" ? "active" : ""
                                }
                                onClick={() => setActiveFilterTab("value")}
                              >
                                按值筛选
                              </button>
                              <button
                                className={
                                  activeFilterTab === "tag" ? "active" : ""
                                }
                                onClick={() => setActiveFilterTab("tag")}
                              >
                                按标签筛选
                              </button>
                            </div>
                            {activeFilterTab === "value" ? (
                              <div className="column-filter-content">
                                <input
                                  autoFocus
                                  value={columnFilters[header] ?? ""}
                                  onChange={(event) =>
                                    updateColumnValueFilter(
                                      header,
                                      event.target.value,
                                    )
                                  }
                                  placeholder="搜索这一列的值"
                                />
                                <div
                                  className="value-filter-mode"
                                  role="group"
                                  aria-label="值筛选方式"
                                >
                                  <button
                                    type="button"
                                    className={
                                      activeValueFilterMode === "include"
                                        ? "active"
                                        : ""
                                    }
                                    aria-pressed={
                                      activeValueFilterMode === "include"
                                    }
                                    title="只显示勾选的值"
                                    onClick={() =>
                                      setColumnValueMode(header, "include")
                                    }
                                  >
                                    正选
                                  </button>
                                  <button
                                    type="button"
                                    className={
                                      activeValueFilterMode === "exclude"
                                        ? "active"
                                        : ""
                                    }
                                    aria-pressed={
                                      activeValueFilterMode === "exclude"
                                    }
                                    title="隐藏勾选的值"
                                    onClick={() =>
                                      setColumnValueMode(header, "exclude")
                                    }
                                  >
                                    反选
                                  </button>
                                </div>
                                <small className="value-filter-mode-hint">
                                  {activeValueFilterMode === "include"
                                    ? "只显示勾选值"
                                    : "隐藏勾选值"}
                                </small>
                                <div className="value-filter-actions">
                                  <label className="value-filter-select-all">
                                    <input
                                      type="checkbox"
                                      checked={allVisibleValuesSelected}
                                      onChange={() =>
                                        updateVisibleColumnValues(
                                          header,
                                          visibleFilterValues,
                                          allVisibleValuesSelected
                                            ? "clear"
                                            : "select",
                                        )
                                      }
                                    />
                                    <span>全选</span>
                                  </label>
                                  <button
                                    type="button"
                                    className="value-filter-link"
                                    onClick={() =>
                                      updateVisibleColumnValues(
                                        header,
                                        visibleFilterValues,
                                        "clear",
                                      )
                                    }
                                  >
                                    全不选
                                  </button>
                                  <button
                                    type="button"
                                    className="value-filter-link"
                                    onClick={() =>
                                      updateVisibleColumnValues(
                                        header,
                                        visibleFilterValues,
                                        "invert",
                                      )
                                    }
                                  >
                                    反转勾选
                                  </button>
                                  <small>
                                    {activeValueFilterMode === "exclude"
                                      ? "排除"
                                      : "保留"}{" "}
                                    {selectedFilterValues.size} / {filterValues.length}
                                  </small>
                                </div>
                                <div className="value-filter-list">
                                  {visibleFilterValues.length ? (
                                    visibleFilterValues.map((value) => (
                                      <label
                                        className="value-filter-option"
                                        key={`${value || "__blank__"}`}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={selectedFilterValues.has(value)}
                                          onChange={() =>
                                            toggleColumnValue(header, value)
                                          }
                                        />
                                        <span className={value ? "" : "value-filter-empty"}>
                                          {value || "(空白)"}
                                        </span>
                                        <small>{filterValueCounts[value] ?? 0}</small>
                                      </label>
                                    ))
                                  ) : (
                                    <div className="value-filter-empty-state">
                                      没有匹配的值
                                    </div>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <div className="column-filter-content">
                                <select
                                  autoFocus
                                  value={columnTagFilters[header] ?? ""}
                                  onChange={(event) => {
                                    updateColumnTagFilter(
                                      header,
                                      event.target.value,
                                    );
                                    setOpenColumnFilter(null);
                                  }}
                                >
                                  <option value="">所有标签</option>
                                  {tagList.map((tag) => (
                                    <option key={tag.name} value={tag.name}>
                                      {tag.name}
                                    </option>
                                  ))}
                                </select>
                                <small>匹配这一列的单元格或行标签</small>
                              </div>
                            )}
                            <button
                              className="column-filter-clear"
                              onClick={() => clearColumnFilters(header)}
                            >
                              清除这一列
                            </button>
                          </div>
                        )}
                      </th>
                      );
                    })}
                    <th className="tags-head">标签</th>
                  </tr>
                </thead>
                <tbody>
                  {virtualRows.top > 0 && (
                    <tr className="virtual-spacer" aria-hidden="true">
                      <td colSpan={visibleColumnIndexes.length + 2} style={{ height: `${virtualRows.top}px` }} />
                    </tr>
                  )}
                  {virtualRows.rows.map(({ row, index }) => (
                    <tr
                      key={index}
                      className={selectedRows.has(index) ? "row-selected" : ""}
                    >
                      <td
                        className="row-index"
                        onClick={(event) => selectRow(index, event)}
                      >
                        {String(index + 1).padStart(2, "0")}
                      </td>
                      {row.map((cell, column) => {
                        if (hiddenColumns.has(column)) return null;
                        const selected = isCellSelected(index, column);
                        const single = selectedRange && rangeSize === 1;
                        const cellTags = getEffectiveCellTags(
                          index,
                          data.headers[column],
                        );
                        const isEditing =
                          editingCell?.row === index &&
                          editingCell.col === column;
                        return (
                          <td
                            key={data.headers[column] + column}
                            className={`${selected ? "range-selected" : ""} ${single && selected ? "cell-selected" : ""} ${cellTags.length ? `cell-marked cell-mark-${markStyle}` : ""}`}
                            onMouseDown={(event) =>
                              startCellSelection(index, column, event)
                            }
                            onMouseEnter={() =>
                              extendCellSelection(index, column)
                            }
                            onDoubleClick={() => {
                              if (editorMode === "edit") startEdit(index, column);
                            }}
                            style={{
                              width: `${columnWidths[column] ?? 180}px`,
                              "--cell-mark-color":
                                tags[cellTags[0]]?.color ?? "#2457ff",
                            } as React.CSSProperties}
                            title={cellTags.length ? `标签：${cellTags.join("、")}` : "拖动选择，双击编辑"}
                          >
                            {isEditing ? (
                              <input
                                autoFocus
                                value={editingValue}
                                onChange={(event) =>
                                  setEditingValue(event.target.value)
                                }
                                onBlur={finishEdit}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") finishEdit();
                                  if (event.key === "Escape")
                                    setEditingCell(null);
                                }}
                              />
                            ) : (
                              <span className="cell-value">
                                {cell || <span className="empty-cell">—</span>}
                              </span>
                            )}
                            {markStyle === "dot" && cellTags.map((tag) => (
                              <i
                                key={tag}
                                className="cell-mark"
                                style={{
                                  backgroundColor: tags[tag]?.color,
                                  color: tags[tag]?.color,
                                }}
                                title={tag}
                              />
                            ))}
                            {markStyle === "fill" && cellTags.length > 1 && (
                              <span
                                className="cell-mark-overview"
                                title={`多个标签：${cellTags.join("、")}`}
                              >
                                {cellTags.map((tag) => (
                                  <i
                                    key={tag}
                                    style={{
                                      backgroundColor:
                                        tags[tag]?.color ?? "#8c8c92",
                                    }}
                                  />
                                ))}
                              </span>
                            )}
                          </td>
                        );
                      })}
                      <td className="row-tags">
                        {getRowTags(index).map((tag) => (
                          <span
                            key={tag}
                            className="tag-chip"
                            style={
                              {
                                "--tag-color": tags[tag]?.color,
                              } as React.CSSProperties
                            }
                          >
                            {tag}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                  {virtualRows.bottom > 0 && (
                    <tr className="virtual-spacer" aria-hidden="true">
                      <td colSpan={visibleColumnIndexes.length + 2} style={{ height: `${virtualRows.bottom}px` }} />
                    </tr>
                  )}
                </tbody>
              </table>
              {!visibleRows.length && (
                <div className="no-results">没有匹配结果</div>
              )}
            </div>
            <footer className="data-footer">
              <span>
                {scopeLabel}
                {rangeSize > 1 ? ` · ${rangeSize} 个单元格` : ""}
              </span>
              <span>
                {visibleRows.length} / {data.rowCount}
              </span>
              <span>{editorMode === "edit" ? "双击或 Enter 编辑" : "快捷键或标签栏标注"}</span>
            </footer>
          </section>
          {editorMode === "tagger" && (
          <aside
            ref={tagPanelRef}
            className={`annotation-sidebar ${tagPanelDock === "floating" ? "is-floating" : ""}`}
            style={
              tagPanelDock === "floating"
                ? {
                    left: `${tagPanelPosition.left}px`,
                    top: `${tagPanelPosition.top}px`,
                    width: `${tagPanelSize.width}px`,
                    height: `${tagPanelSize.height}px`,
                  }
                : undefined
            }
          >
            {tagPanelDock !== "floating" && (
              <span
                className={`docked-resize-handle dock-resize-${tagPanelDock}`}
                role="separator"
                aria-label="调整标签栏大小"
                aria-orientation={
                  tagPanelDock === "left" || tagPanelDock === "right"
                    ? "vertical"
                    : "horizontal"
                }
                onMouseDown={(event) =>
                  beginTagPanelResize(
                    event,
                    tagPanelDock as Exclude<TagPanelDock, "floating">,
                  )
                }
                title="拖动调整标签栏大小"
              />
            )}
            <div className="sidebar-head">
              <div className="sidebar-title" onMouseDown={beginTagPanelDrag}>
                <span className="sidebar-drag-handle" aria-hidden="true">⋮⋮</span>
                <h2>标签</h2>
              </div>
              <div>
                <button
                  className="sidebar-icon"
                  onClick={() => tagFileInputRef.current?.click()}
                  title="导入标签"
                >
                  ⇩
                </button>
                <button
                  className="sidebar-icon"
                  onClick={() => {
                    setTagDraft({
                      name: "",
                      definition: "",
                      color: TAG_COLORS[tagList.length % TAG_COLORS.length],
                      shortcut: String(Math.min(tagList.length + 1, 9)),
                    });
                    setCapturingShortcut(null);
                    setShowTagDialog(true);
                  }}
                  title="新建标签"
                >
                  ＋
                </button>
              </div>
            </div>
            <div className="scope-box">
              <span className={`scope-dot scope-${currentScope}`} />
              <strong>{scopeLabel}</strong>
              <span>
                {selectedRange
                  ? `${rangeSize} 个单元格`
                  : selectedRows.size
                    ? `${selectedRows.size} 行`
                    : selectedColumns.size
                      ? `${selectedColumns.size} 列`
                      : "未选择"}
              </span>
            </div>
            <div className="mark-style-control">
              <span>标注显示</span>
              <div className="mark-style-segmented" role="group" aria-label="标注显示方式">
                <button
                  className={markStyle === "fill" ? "active" : ""}
                  onClick={() => setMarkStyle("fill")}
                  title="使用填充色显示标签"
                >
                  填充
                </button>
                <button
                  className={markStyle === "dot" ? "active" : ""}
                  onClick={() => setMarkStyle("dot")}
                  title="使用圆点显示标签"
                >
                  <span className="mark-style-dot" />
                  圆点
                </button>
              </div>
            </div>
            <div className="tag-list" data-tag-list tabIndex={-1}>
              {tagList.map((tag, index) => (
                <div
                  key={tag.name}
                  className="tag-row"
                  onClick={() => {
                    if (editorMode === "tagger") void applyTag(tag.name);
                  }}
                  aria-disabled={editorMode !== "tagger"}
                >
                  <span
                    className="tag-swatch"
                    style={{ backgroundColor: tag.color }}
                  />
                  <div className="tag-copy">
                    <strong>{tag.name}</strong>
                    <span title={tag.definition}>{tag.definition || "—"}</span>
                  </div>
                  <span className="tag-count">{tagCount(tag.name)}</span>
                  <button
                    className={`shortcut-key ${capturingShortcut === tag.name ? "capturing" : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setCapturingShortcut(tag.name);
                    }}
                    title="点击后按下新的快捷键"
                  >
                    {capturingShortcut === tag.name
                      ? "按键…"
                      : displayShortcut(tag.shortcut || String(index + 1))}
                  </button>
                  <button
                    className="tag-edit"
                    onClick={(event) => {
                      event.stopPropagation();
                      setTagDraft({ ...tag, originalName: tag.name });
                      setCapturingShortcut(null);
                      setShowTagDialog(true);
                    }}
                    title="编辑标签"
                  >
                    ···
                  </button>
                </div>
              ))}
            </div>
            <button
              className="secondary-button full-button"
              onClick={() => {
                setTagDraft({
                  name: "",
                  definition: "",
                  color: TAG_COLORS[tagList.length % TAG_COLORS.length],
                  shortcut: String(Math.min(tagList.length + 1, 9)),
                });
                setCapturingShortcut(null);
                setShowTagDialog(true);
              }}
            >
              ＋ 新建标签
            </button>
            <div className="shortcut-help">
              <span>数字键或已设快捷键标注</span>
              <span>Shift + 快捷键移除</span>
            </div>
            <details className="tag-template">
              <summary>标签样例 JSON</summary>
              <p>需要让 LLM 设计标签时，复制这份样例；生成后直接导入。</p>
              <pre>{TAG_TEMPLATE}</pre>
              <button className="link-button" onClick={() => void copyTagTemplate()}>
                复制样例 JSON
              </button>
            </details>
            <div className="sidebar-bottom">
              <button
                className="primary-button full-button"
                onClick={() => setShowExportMenu((previous) => !previous)}
              >
                导出
              </button>
              <button className="link-button" onClick={downloadData}>
                下载 {delimiter === "\t" ? "TSV" : "CSV"}
              </button>
            </div>
            {tagPanelDock === "floating" && (
              <span className="panel-resize-corner" aria-hidden="true">⌟</span>
            )}
          </aside>
          )}
        </main>
      )}

      {notice && <div className="toast">{notice}</div>}
      {archiveDeleteTarget !== null && archives[archiveDeleteTarget] && (
        <div
          className="modal-backdrop"
          onClick={() => setArchiveDeleteTarget(null)}
        >
          <div
            className="modal archive-delete-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="archive-delete-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <h2 id="archive-delete-title">确定要删除？</h2>
                <span className="save-modal-file">
                  {archives[archiveDeleteTarget].fileName}
                </span>
              </div>
              <button
                onClick={() => setArchiveDeleteTarget(null)}
                aria-label="关闭确认框"
              >
                ×
              </button>
            </div>
            <p className="save-modal-copy">删除后无法恢复这个存档。</p>
            <div className="modal-actions">
              <span />
              <button
                className="secondary-button"
                onClick={() => setArchiveDeleteTarget(null)}
                autoFocus
              >
                取消
              </button>
              <button className="danger-button" onClick={confirmDeleteArchive}>
                删除存档
              </button>
            </div>
          </div>
        </div>
      )}
      {showSaveDialog && (
        <div
          className="modal-backdrop"
          onClick={() => setShowSaveDialog(false)}
        >
          <div
            className="modal save-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <h2>保存修改？</h2>
                <span className="save-modal-file">{fileName}</span>
              </div>
              <button
                onClick={() => setShowSaveDialog(false)}
                aria-label="取消"
              >
                ×
              </button>
            </div>
            <p className="save-modal-copy">当前文件有未保存的修改。</p>
            <div className="modal-actions">
              <button
                className="danger-button"
                onClick={() => void discardAndLeave()}
              >
                不保存
              </button>
              <span />
              <button
                className="secondary-button"
                onClick={() => setShowSaveDialog(false)}
              >
                取消
              </button>
              <button
                className="primary-button"
                onClick={() => void saveAndLeave()}
                disabled={isSaving}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
      {showTagDialog && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setCapturingShortcut(null);
            setShowTagDialog(false);
          }}
        >
          <div
            className="modal tag-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2>{tagDraft.originalName ? "编辑标签" : "新建标签"}</h2>
              <button
                onClick={() => {
                  setCapturingShortcut(null);
                  setShowTagDialog(false);
                }}
              >
                ×
              </button>
            </div>
            <label>
              名称
              <input
                autoFocus
                value={tagDraft.name}
                onChange={(event) =>
                  setTagDraft({ ...tagDraft, name: event.target.value })
                }
              />
            </label>
            <label>
              定义
              <textarea
                value={tagDraft.definition}
                onChange={(event) =>
                  setTagDraft({ ...tagDraft, definition: event.target.value })
                }
                rows={3}
              />
            </label>
            <div className="form-grid">
              <label>
                快捷键
                <button
                  type="button"
                  className={`shortcut-capture ${capturingShortcut === TAG_DRAFT_SHORTCUT ? "capturing" : ""}`}
                  onClick={() => setCapturingShortcut(TAG_DRAFT_SHORTCUT)}
                  title="点击后按下新的快捷键"
                >
                  {capturingShortcut === TAG_DRAFT_SHORTCUT
                    ? "按键…"
                    : displayShortcut(tagDraft.shortcut || "未设置")}
                </button>
              </label>
              <label>
                填充颜色
                <div className="color-picker">
                  {TAG_COLORS.map((color) => (
                    <button
                      key={color}
                      className={
                        tagDraft.color === color
                          ? "color-option selected"
                          : "color-option"
                      }
                      style={{ backgroundColor: color }}
                      onClick={() => setTagDraft({ ...tagDraft, color })}
                      aria-label={`颜色 ${color}`}
                    />
                  ))}
                  <input
                    className="custom-color-input"
                    type="color"
                    value={/^#[0-9a-fA-F]{6}$/.test(tagDraft.color) ? tagDraft.color : TAG_COLORS[0]}
                    onChange={(event) =>
                      setTagDraft({ ...tagDraft, color: event.target.value })
                    }
                    aria-label="选择自定义填充颜色"
                    title="自定义填充颜色"
                  />
                </div>
              </label>
            </div>
            <div className="modal-actions">
              {tagDraft.originalName && (
                <button
                  className="danger-button"
                  onClick={() => void handleDeleteTag(tagDraft.originalName!)}
                >
                  删除
                </button>
              )}
              <span />
              <button
                className="secondary-button"
                onClick={() => {
                  setCapturingShortcut(null);
                  setShowTagDialog(false);
                }}
              >
                取消
              </button>
              <button
                className="primary-button"
                onClick={() => void handleCreateTag()}
                disabled={!tagDraft.name.trim()}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
