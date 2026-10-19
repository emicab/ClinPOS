// lib/csv.ts
import { saveFile, type SaveFileResult } from "./saveFile";

export async function exportToCSV(filename: string, data: any[], headers: { key: string, label: string }[]): Promise<SaveFileResult> {
  const csvRows = [];

  // Header row
  csvRows.push(headers.map(h => `"${h.label.replace(/"/g, '""')}"`).join(','));

  // Data rows
  for (const row of data) {
    const values = headers.map(h => {
      const val = row[h.key];
      const valStr = val === null || val === undefined ? '' : String(val);
      return `"${valStr.replace(/"/g, '""')}"`;
    });
    csvRows.push(values.join(','));
  }

  const csvContent = '\ufeff' + csvRows.join('\n'); // Adding BOM for Excel UTF-8 support
  const bytes = new TextEncoder().encode(csvContent);
  return saveFile(bytes, `${filename}.csv`, 'text/csv;charset=utf-8;');
}

export function parseCSV(text: string): string[][] {
  const lines: string[][] = [];
  let row: string[] = [''];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        row[row.length - 1] += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push('');
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      lines.push(row);
      row = [''];
    } else {
      row[row.length - 1] += char;
    }
  }
  if (row.length > 1 || row[0] !== '') {
    lines.push(row);
  }
  return lines;
}
