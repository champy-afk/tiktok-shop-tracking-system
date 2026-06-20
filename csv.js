function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      row.push(cell);
      if (row.some(value => String(value).trim() !== '')) rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += char;
  }

  row.push(cell);
  if (row.some(value => String(value).trim() !== '')) rows.push(row);
  return rows;
}

function decodeCsvBuffer(buffer) {
  const utf8Text = new TextDecoder('utf-8').decode(buffer);
  const replacementCount = (utf8Text.match(/\uFFFD/g) || []).length;
  if (replacementCount === 0) return utf8Text.replace(/^\uFEFF/, '');
  return new TextDecoder('shift_jis').decode(buffer).replace(/^\uFEFF/, '');
}

function normalizeHeader(value = '') {
  return String(value).replace(/^\uFEFF/, '').replace(/\s+/g, '').toLowerCase();
}

function normalizePhone(value = '') {
  return String(value).replace(/[^\d]/g, '');
}

function normalizeText(value = '') {
  return String(value)
    .normalize('NFKC')
    .replace(/[〒\-\s　,，、。・.*＊]/g, '')
    .toLowerCase();
}

function findCsvColumn(header, labels) {
  const normalized = header.map(normalizeHeader);
  for (const label of labels) {
    const target = normalizeHeader(label);
    const exact = normalized.indexOf(target);
    if (exact >= 0) return exact;
    const partial = normalized.findIndex(value => value.includes(target));
    if (partial >= 0) return partial;
  }
  return -1;
}

function parseCsvDateTime(value = '') {
  const text = String(value).trim().normalize('NFKC');
  if (!text) return null;

  const normalized = text
    .replace(/[年月]/g, '/')
    .replace(/[日]/g, ' ')
    .replace(/[時]/g, ':')
    .replace(/[分]/g, '')
    .replace(/\./g, '/')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  const ymd = normalized.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?\s*(AM|PM)?/);
  const mdy = normalized.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?\s*(AM|PM)?/);
  const md = normalized.match(/(\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?\s*(AM|PM)?/);
  const match = ymd || mdy || md;
  if (!match) return null;

  const year = ymd ? match[1] : mdy ? match[3] : new Date().getFullYear();
  const month = ymd ? match[2] : match[1];
  const day = ymd ? match[3] : match[2];
  let hour = ymd ? (match[4] || '0') : mdy ? (match[4] || '0') : (match[3] || '0');
  const minute = ymd ? (match[5] || '0') : mdy ? (match[5] || '0') : (match[4] || '0');
  const second = ymd ? (match[6] || '0') : mdy ? (match[6] || '0') : (match[5] || '0');
  const meridiem = ymd ? match[7] : mdy ? match[7] : match[6];
  if (meridiem === 'PM' && Number(hour) < 12) hour = String(Number(hour) + 12);
  if (meridiem === 'AM' && Number(hour) === 12) hour = '0';

  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isNaN(date.getTime()) ? null : date;
}

function isWithinDateRange(date, startAt, endAt) {
  if (!date) return false;
  if (startAt && date < startAt) return false;
  if (endAt && date > endAt) return false;
  return true;
}

function hasMaskedValue(values = []) {
  return values.some(value => /[*＊]/.test(String(value ?? '')));
}

function extractTargetOrders(csvBuffer, options = {}) {
  const dateColumnIndex = Number.isInteger(options.dateColumnIndex) ? options.dateColumnIndex : 23;
  const startAt = parseCsvDateTime(options.startAt);
  const endAt = parseCsvDateTime(options.endAt);
  if (startAt && endAt && startAt > endAt) throw new Error('開始日時は終了日時より前にしてください。');

  const rows = parseCsvRows(decodeCsvBuffer(csvBuffer));
  if (rows.length < 2) throw new Error('CSVに注文データ行がありません。');

  const header = rows[0];
  const columns = {
    orderId: findCsvColumn(header, ['注文ID', '注文Id', '注文番号', 'Order ID', 'OrderID']),
    packageId: findCsvColumn(header, options.packageIdLabels || []),
    recipient: findCsvColumn(header, ['受取人', '受取人名', '配送先氏名', '宛名', 'Recipient', 'Name']),
    phone: findCsvColumn(header, ['電話番号', '携帯電話', '配送先電話番号', 'Phone', 'Tel']),
    address: findCsvColumn(header, ['住所', '配送先住所', 'お届け先住所', 'Address']),
    pref: findCsvColumn(header, ['都道府県']),
    city: findCsvColumn(header, ['市区町村']),
    town: findCsvColumn(header, ['町名']),
    addr1: findCsvColumn(header, ['詳細住所1', '詳細住所１', '住所1']),
    addr2: findCsvColumn(header, ['詳細住所2', '詳細住所２', '住所2'])
  };

  const missing = [];
  if (columns.orderId < 0) missing.push('注文ID');
  if (columns.recipient < 0) missing.push('受取人');
  if (columns.phone < 0) missing.push('電話番号');
  const canBuildAddress = columns.address >= 0 || [columns.pref, columns.city, columns.town, columns.addr1, columns.addr2].some(index => index >= 0);
  if (!canBuildAddress) missing.push('住所');
  if (missing.length) throw new Error(`CSVに必要な列が見つかりません: ${missing.join('、')}`);
  if (header.length <= dateColumnIndex) throw new Error(`日時のX列が見つかりません。CSVは${header.length}列です。`);

  const targetOrders = [];
  const skippedOrders = [];
  const skippedReasonCounts = {};
  const skip = rowInfo => {
    skippedOrders.push(rowInfo);
    skippedReasonCounts[rowInfo.reason] = (skippedReasonCounts[rowInfo.reason] || 0) + 1;
  };

  rows.slice(1).forEach((row, index) => {
    const specifiedValue = String(row[dateColumnIndex] ?? '').trim();
    const specifiedDate = parseCsvDateTime(specifiedValue);
    const orderId = String(row[columns.orderId] ?? '').trim();
    const packageId = columns.packageId >= 0 ? String(row[columns.packageId] ?? '').trim() : '';
    const recipient = String(row[columns.recipient] ?? '').trim();
    const phone = normalizePhone(row[columns.phone]);
    const address = columns.address >= 0
      ? String(row[columns.address] ?? '').trim()
      : [columns.pref, columns.city, columns.town, columns.addr1, columns.addr2]
        .filter(column => column >= 0)
        .map(column => String(row[column] ?? '').trim())
        .filter(Boolean)
        .join('');

    if (!specifiedValue) return skip({ rowNumber: index + 2, orderId, specifiedValue, reason: 'X列が空のため対象外' });
    if (!specifiedDate) return skip({ rowNumber: index + 2, orderId, specifiedValue, reason: 'X列の日時を読み取れないため対象外' });
    if (!isWithinDateRange(specifiedDate, startAt, endAt)) return skip({ rowNumber: index + 2, orderId, specifiedValue, reason: 'X列の日時が指定範囲外のため対象外' });
    if (hasMaskedValue([row[columns.recipient], row[columns.phone], address])) return skip({ rowNumber: index + 2, orderId, specifiedValue, reason: '伏せ字データのため配送対象外' });

    targetOrders.push({
      rowNumber: index + 2,
      orderId,
      packageId,
      recipient,
      phone,
      address,
      specifiedValue,
      trackingNumber: '',
      status: 'pending',
      message: '',
      score: 0
    });
  });

  return {
    header,
    totalRows: rows.length - 1,
    targetOrders,
    skippedOrders,
    skippedReasonCounts,
    xColumnSamples: rows.slice(1, 8).map((row, index) => ({
      rowNumber: index + 2,
      value: String(row[dateColumnIndex] ?? '').trim()
    }))
  };
}

module.exports = {
  extractTargetOrders,
  normalizePhone,
  normalizeText
};
