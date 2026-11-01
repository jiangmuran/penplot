# -*- coding: utf-8 -*-
"""CSV (stdlib) / XLSX (openpyxl, optional `office`) tables for batch data."""
import csv
import io

ENCODINGS = ('utf-8-sig', 'gb18030', 'utf-16')


def decode_text(data):
    """utf-8 / gb18030 auto-detect. Returns (text, encoding)."""
    if data.startswith(b'\xff\xfe') or data.startswith(b'\xfe\xff'):
        return data.decode('utf-16'), 'utf-16'
    for enc in ('utf-8-sig', 'gb18030'):
        try:
            return data.decode(enc), ('utf-8' if enc == 'utf-8-sig' else enc)
        except UnicodeDecodeError:
            continue
    return data.decode('utf-8', 'replace'), 'utf-8'


def read_table(path, name=''):
    """-> [{name, columns, rows}] (rows = list of lists, header excluded)."""
    low = (name or path).lower()
    if low.endswith(('.xlsx', '.xlsm')):
        try:
            import openpyxl
        except ImportError:
            raise ImportError('openpyxl not installed')
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        sheets = []
        for ws in wb.worksheets:
            rows = [[_cell(v) for v in r] for r in ws.iter_rows(values_only=True)]
            rows = [r for r in rows if any(v not in (None, '') for v in r)]
            if not rows:
                sheets.append({'name': ws.title, 'columns': [], 'rows': []})
                continue
            cols = [str(c) if c not in (None, '') else 'col%d' % (i + 1) for i, c in enumerate(rows[0])]
            sheets.append({'name': ws.title, 'columns': cols, 'rows': rows[1:]})
        wb.close()
        return sheets
    with open(path, 'rb') as f:
        text, _enc = decode_text(f.read())
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=',;\t')
    except csv.Error:
        dialect = csv.excel
    rows = [r for r in csv.reader(io.StringIO(text), dialect) if any(c.strip() for c in r)]
    if not rows:
        return [{'name': 'csv', 'columns': [], 'rows': []}]
    cols = [c.strip() or 'col%d' % (i + 1) for i, c in enumerate(rows[0])]
    return [{'name': 'csv', 'columns': cols, 'rows': rows[1:]}]


def _cell(v):
    if v is None:
        return ''
    if hasattr(v, 'isoformat'):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def row_variables(sheet, row_index, mapping):
    """{var: str(value)} for one data row using mapping {var: column}."""
    cols = sheet['columns']
    row = sheet['rows'][row_index]
    out = {'_row': str(row_index + 1)}
    for var, col in (mapping or {}).items():
        if col in cols:
            i = cols.index(col)
            out[var] = '' if i >= len(row) or row[i] is None else str(row[i])
    return out
