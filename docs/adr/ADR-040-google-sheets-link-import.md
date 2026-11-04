# ADR-040: Google Sheets Import Reads a Link-Shared Workbook as XLSX, Without OAuth

**Status:** Accepted
**Date:** 2026-11-04
**Issue:** [#1111](https://github.com/merickvaughn/lifting-logbook/issues/1111)
**Related:** [ADR-003](ADR-003-per-user-data-store-config.md), [ADR-004](ADR-004-multi-data-store-adapters.md) and [ADR-014](ADR-014-credential-encryption-at-rest.md) (the planned, never-built Sheets repository adapter and its encrypted credentials), [Download My Data proposal](../proposals/2026-08-26-download-my-data-export.md) (declined Google OAuth), [Smart File Import proposal](../proposals/2026-06-09-smart-file-import.md)

---

## Context

Users migrating off the legacy Google Sheets logbook have to export each tab to CSV by hand and
upload the files one at a time to the Smart Import wizard. The parsers already accept that
workbook's columns verbatim (`packages/core/src/constants/schema.ts`), so what was missing is
reading the workbook directly from a link.

Three questions needed an answer:

1. **How the app is allowed to read the sheet:** Google OAuth with a Sheets read scope, or the
   sheet shared as "Anyone with the link can view".
2. **Which Google export to read:** per-tab CSV, the Visualization (`gviz`) query endpoint, or
   the whole workbook as XLSX.
3. **How a server-side fetch of a user-supplied link stays safe**, since it is a request the API
   makes on a user's behalf to a URL the user chose.

## Decision

1. **Link-shared access, no OAuth.** The user shares the sheet as "Anyone with the link"
   (Viewer). The API stores no Google credential and asks for no scope. The wizard says so next
   to the link field, including that anyone holding the link can view the sheet while it is
   shared.
2. **Read the whole workbook once, as XLSX** (`/spreadsheets/d/<id>/export?format=xlsx`), and
   flatten each worksheet into the same string table a CSV export would give. Each tab is
   classified by the existing `classifyImport`. The browser then sends each chosen tab's CSV
   through the existing preview, commit and undo endpoints, unchanged. Only the parts of the XLSX
   package that hold cell values are read: the workbook, its relationships, shared strings,
   styles (to tell dates from numbers) and the worksheets. They are read with `fflate` and
   `@xmldom/xmldom`, both already in the dependency tree, rather than a full spreadsheet library.
3. **The pasted string is never fetched.** `parseGoogleSheetUrl` accepts only a
   `docs.google.com/spreadsheets/d/<id>` link or a bare ID, and the API builds the export URL
   from that ID. Redirects are followed by hand, at most three, and each hop must be HTTPS on
   `docs.google.com` or a `*.googleusercontent.com` host. A redirect to `accounts.google.com`, a
   401/403, or an HTML page means the sheet is not shared, and the API returns 422 with the
   sharing instructions. The download is capped at 10 MB and 15 s. Before anything is
   decompressed, each XML part is checked against an 8 MB inflated-size cap, the parts together
   against 40 MB, and the part count against 300. A tab is read only up to `MAX_IMPORT_ROWS` rows
   and 100 columns, and hidden tabs are skipped. Worksheets and shared strings are scanned row by
   row without building a DOM. Measured on an 8 MB, 60,000-row worksheet at the part cap: 12 MB of
   heap and 117 ms, stopping at the row cap. A full DOM of the same part took about 394 MB, against
   the API's 512 MiB Cloud Run limit.
4. **No database transaction around the fetch.** The handler does no database work, so it is
   marked `@SkipRlsTransaction()`. Otherwise the per-request RLS transaction would hold a pooled
   connection for the whole download and parse, and a slow download could outlast the
   transaction's 15 s timeout.

## Alternatives Considered

- **Google OAuth with a read-only Sheets scope.** Works on private sheets. Rejected for now for
  the same reasons the Download My Data proposal gave: a consent screen and Google verification,
  encrypted token storage, refresh and revocation, all for a one-time migration. ADR-004's Sheets
  adapter, with ADR-014's per-user encrypted credentials, remains the design if a live Sheets
  integration is ever built.
- **Per-tab CSV export (`export?format=csv&gid=<gid>`).** Needs each tab's `gid`, and without
  the Sheets API there is no supported way to list a workbook's tabs. The user would have to
  paste one link per tab.
- **The Visualization query endpoint (`gviz/tq?tqx=out:csv&sheet=<name>`).** Fetches a tab by
  name, but the Query Language gives each column one data type. The logbook's Notes column mixes
  text with numbers (for example `178.6`), so values that don't match the column's type would
  come back empty.
- **`exceljs` to read the XLSX.** Tried first. It added about 150 packages, several with open
  moderate advisories in its write-side dependencies, to read a handful of XML files.

## Consequences

- One link imports every tab the classifier recognizes, and each tab gets the same preview,
  column matching, review and undo as a CSV upload. Nothing new is written to the database, and
  there is no schema change.
- A private sheet cannot be imported until the user shares it. The user can turn sharing off
  again afterwards.
- Every failure mode of the CSV endpoints applies to Sheets imports too, because Sheets imports
  go through them.
- Cell display formats are not reproduced. Dates are written as `M/D/YYYY` and numbers in plain
  decimal, the forms the parsers read.

## References

1. Google Drive Help, [Share files from Google Drive](https://support.google.com/drive/answer/2494822) — general access "Anyone with the link".
2. Google Visualization API, [Query Language Reference — Data types](https://developers.google.com/chart/interactive/docs/querylanguage#data-types) — each column of a query result has one data type.
3. ECMA-376, [Office Open XML File Formats](https://ecma-international.org/publications-and-standards/standards/ecma-376/) — the SpreadsheetML package parts, shared strings, cell types and built-in number formats (Part 1, §18).
4. WHATWG Fetch Standard, [request redirect mode](https://fetch.spec.whatwg.org/#concept-request-redirect-mode) — `manual` returns each redirect so the caller can check it.
5. OWASP, [Server-Side Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) — build the request from validated input and allowlist destination hosts.
6. [fflate](https://github.com/101arrowz/fflate) — `unzipSync` with a per-file `filter`, used to read only the needed parts and check each part's inflated size first.
7. [@xmldom/xmldom](https://github.com/xmldom/xmldom) — W3C DOM `DOMParser` for Node.
