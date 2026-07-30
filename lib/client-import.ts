import * as XLSX from 'xlsx';
import Papa from 'papaparse';

/**
 * Parsing for the client-roster import — a grouped spreadsheet, unlike the flat
 * Monday.com contact export handled by monday-import.ts.
 *
 * The roster has ONE client per group: the client's row carries name / state /
 * gross / signed date, and the rows beneath it (name column blank) each carry
 * one removal-target URL for that same client. We fill the client identity down
 * the group and collect every URL under it as Link Data.
 *
 *   Date | Client         | State | Gross | Status    | Website
 *   7/16 | Jeffery Remmark | VA    | 789.99| Requested | https://…/jeffery…      ← client + link 1
 *        |                 |       |       | Requested | https://…/arrests/…     ← link 2
 *        |                 |       |       | Removed   | https://…/busted/…      ← link 3
 */

export type LinkStatus = 'live' | 'requested' | 'removed';

export interface ParsedClientLink {
  url: string;
  status: LinkStatus;
}

export interface ParsedClient {
  name: string;
  state: string | null;
  grossRevenue: number | null;
  signedDate: string | null; // YYYY-MM-DD
  source: string | null;
  phone: string | null;
  email: string | null;
  links: ParsedClientLink[];
  /** URLs beyond the 14-slot cap that were dropped for this client. */
  droppedLinks: number;
}

export interface ParsedClientImport {
  clients: ParsedClient[];
  /** Links kept across all clients (<= 14 each). */
  totalLinks: number;
  /** Links dropped because a client exceeded the 14-slot cap. */
  droppedLinks: number;
  /** Names of clients that hit the cap, so the UI can list who to fix by hand. */
  overCapClients: string[];
  /** Website rows appearing before any named client (orphans, skipped). */
  skippedLeadingRows: number;
  /**
   * Client names that don't look like a person (an email landed in the column, a
   * lone letter). Still imported — dropping a group would misattach its links —
   * but surfaced so the operator can relabel them after.
   */
  suspiciousNames: string[];
}

/** A client "name" that is really data-entry noise (an email, a single letter). */
function looksSuspicious(name: string): boolean {
  return name.includes('@') || name.replace(/[^a-zA-Z]/g, '').length <= 1;
}

export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_GRID_ROWS = 5_000;
const MAX_COLUMNS = 200;
const MAX_CELL_CHARS = 10_000;
/** contact_links is capped at positions 1..14 per contact in the schema. */
export const LINK_CAP = 14;

/** Removal-status label from the roster to the CRM's three link states. */
export function mapLinkStatus(raw: string | null | undefined): LinkStatus {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'removed' || s === 'site is down') return 'removed';
  if (s === 'requested' || s === 'dmca') return 'requested';
  if (s === 'live') return 'live';
  // refund / other / blank / anything unrecognised: presume the record is still up.
  return 'live';
}

/** A dollar figure, tolerant of "$", commas and stray whitespace. */
export function parseGross(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0 || n > 99_999_999) return null;
  return Math.round(n * 100) / 100;
}

/**
 * A signed date to YYYY-MM-DD. ISO input is taken literally (no timezone shift);
 * slash dates go through Date and use local parts. Junk returns null — the field
 * is display-only, so a bad cell should not fail the import.
 */
export function parseSignedDate(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/\/+$/, '').trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const year = d.getFullYear();
  if (year < 1990 || year > 2100) return null;
  return `${year}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function columnIndex(headers: string[], test: (h: string) => boolean): number {
  return headers.findIndex((h) => test(h.toLowerCase()));
}

/** Pure grouping of a raw cell grid into clients. Exported for direct testing. */
export function gridToClients(grid: string[][]): ParsedClientImport {
  const headerIndex = grid.findIndex((row) =>
    row.some((c) => {
      const v = String(c ?? '').trim().toLowerCase();
      return v === 'client' || v === 'name';
    })
  );
  if (headerIndex === -1) {
    throw new Error('Could not find a header row with a "Client" or "Name" column.');
  }
  const headers = grid[headerIndex].map((h) => String(h ?? '').trim());
  const headerKey = headers.join(' ').toLowerCase();

  const idx = {
    name: columnIndex(headers, (h) => h === 'client' || h === 'name'),
    state: columnIndex(headers, (h) => h === 'state'),
    gross: columnIndex(headers, (h) => h.startsWith('gross')),
    date: columnIndex(headers, (h) => h === 'date' || h === 'signed' || h === 'signed date'),
    status: columnIndex(headers, (h) => h === 'status'),
    website: columnIndex(headers, (h) => h === 'website' || h === 'url' || h === 'link'),
    source: columnIndex(headers, (h) => h === 'source'),
    phone: columnIndex(headers, (h) => h.startsWith('phone')),
    email: columnIndex(headers, (h) => h === 'email' || h === 'email address'),
  };

  const cell = (row: string[], i: number) => (i >= 0 ? String(row[i] ?? '').trim() : '');

  const clients: ParsedClient[] = [];
  let current: ParsedClient | null = null;
  let seenUrls = new Set<string>();
  let totalLinks = 0;
  let droppedLinks = 0;
  let skippedLeadingRows = 0;
  const overCapClients: string[] = [];
  const suspiciousNames: string[] = [];

  for (let r = headerIndex + 1; r < grid.length; r++) {
    const row = grid[r].map((c) => String(c ?? '').trim());
    if (row.every((c) => !c)) continue; // blank spacer
    if (row.join(' ').toLowerCase() === headerKey) continue; // repeated header (next block)

    const name = cell(row, idx.name);
    if (name) {
      current = {
        name,
        state: cell(row, idx.state) || null,
        grossRevenue: parseGross(cell(row, idx.gross)),
        signedDate: parseSignedDate(cell(row, idx.date)),
        source: cell(row, idx.source) || null,
        phone: cell(row, idx.phone) || null,
        email: cell(row, idx.email) || null,
        links: [],
        droppedLinks: 0,
      };
      clients.push(current);
      seenUrls = new Set();
      if (looksSuspicious(name)) suspiciousNames.push(name);
    }

    const url = cell(row, idx.website);
    if (url && /^https?:\/\//i.test(url)) {
      if (!current) {
        skippedLeadingRows++;
        continue;
      }
      const key = url.toLowerCase();
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      if (current.links.length < LINK_CAP) {
        current.links.push({ url, status: mapLinkStatus(cell(row, idx.status)) });
        totalLinks++;
      } else {
        current.droppedLinks++;
        droppedLinks++;
        if (!overCapClients.includes(current.name)) overCapClients.push(current.name);
      }
    }
  }

  return { clients, totalLinks, droppedLinks, overCapClients, skippedLeadingRows, suspiciousNames };
}

function sheetToGrid(buffer: ArrayBuffer): string[][] {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '', raw: false });
}

/** Reads a .xlsx/.csv client roster and groups it into clients + Link Data. */
export async function parseClientImportFile(file: File): Promise<ParsedClientImport> {
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error('Import files must be 20 MB or smaller');
  }
  const isCsv = /\.csv$/i.test(file.name);
  const grid: string[][] = isCsv
    ? (Papa.parse<string[]>(await file.text(), { skipEmptyLines: false }).data as string[][])
    : sheetToGrid(await file.arrayBuffer());

  if (grid.length > MAX_GRID_ROWS) {
    throw new Error(`Import files are limited to ${MAX_GRID_ROWS} rows`);
  }
  if (grid.some((row) => row.length > MAX_COLUMNS)) {
    throw new Error(`Import files are limited to ${MAX_COLUMNS} columns`);
  }
  if (grid.some((row) => row.some((cell) => String(cell ?? '').length > MAX_CELL_CHARS))) {
    throw new Error('An import cell exceeds the 10,000 character safety limit');
  }
  return gridToClients(grid);
}
