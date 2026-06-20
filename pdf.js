const { PDFParse } = require('pdf-parse');
const { normalizePhone, normalizeText } = require('./csv');

function buildTextFromPositionedItems(items) {
  const sorted = items
    .filter(item => String(item.text || '').trim())
    .sort((a, b) => {
      if (Math.abs(a.y - b.y) > 3) return a.y - b.y;
      return a.x - b.x;
    });

  const lines = [];
  for (const item of sorted) {
    const lastLine = lines[lines.length - 1];
    if (!lastLine || Math.abs(lastLine.y - item.y) > 3) {
      lines.push({ y: item.y, parts: [item] });
    } else {
      lastLine.parts.push(item);
    }
  }

  return lines
    .map(line => line.parts.sort((a, b) => a.x - b.x).map(item => item.text).join(' '))
    .join('\n');
}

function getPdfSectionDefs(pdfLayout) {
  if (pdfLayout === 'six') {
    return [
      { key: 'top_left', label: '上段左', xMin: 0, xMax: 0.5, yMin: 0, yMax: 1 / 3 },
      { key: 'top_right', label: '上段右', xMin: 0.5, xMax: 1, yMin: 0, yMax: 1 / 3 },
      { key: 'middle_left', label: '中段左', xMin: 0, xMax: 0.5, yMin: 1 / 3, yMax: 2 / 3 },
      { key: 'middle_right', label: '中段右', xMin: 0.5, xMax: 1, yMin: 1 / 3, yMax: 2 / 3 },
      { key: 'bottom_left', label: '下段左', xMin: 0, xMax: 0.5, yMin: 2 / 3, yMax: 1 },
      { key: 'bottom_right', label: '下段右', xMin: 0.5, xMax: 1, yMin: 2 / 3, yMax: 1 }
    ];
  }

  return [
    { key: 'upper', label: '上段', xMin: 0, xMax: 1, yMin: 0, yMax: 0.5 },
    { key: 'lower', label: '下段', xMin: 0, xMax: 1, yMin: 0.5, yMax: 1 }
  ];
}

async function extractPdfSections(file, pdfTypeLabel = '', pdfLayout = 'two') {
  const parser = new PDFParse({ data: file.buffer });
  try {
    const doc = await parser.load();
    const sections = [];
    const sectionDefs = getPdfSectionDefs(pdfLayout);

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const sectionItems = new Map(sectionDefs.map(def => [def.key, []]));

      for (const item of textContent.items || []) {
        if (!('str' in item)) continue;
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        const xRatio = x / viewport.width;
        const yRatio = y / viewport.height;
        const section = sectionDefs.find(def => (
          xRatio >= def.xMin &&
          xRatio < def.xMax &&
          yRatio >= def.yMin &&
          yRatio < def.yMax
        )) || sectionDefs[sectionDefs.length - 1];
        sectionItems.get(section.key).push({ text: item.str, x, y });
      }

      sectionDefs.forEach(def => {
        sections.push({
          fileName: file.originalname,
          pdfTypeLabel,
          pageNumber,
          section: def.key,
          sectionLabel: def.label,
          text: buildTextFromPositionedItems(sectionItems.get(def.key))
        });
      });

      page.cleanup();
    }

    return sections;
  } finally {
    await parser.destroy().catch(() => {});
  }
}

function extractShipmentsFromPdfSection(section) {
  const normalizedText = String(section.text || '').normalize('NFKC');
  const candidates = [];
  const seen = new Set();
  const trackingPattern = /(?:\d{4}[-\s]?\d{4}[-\s]?\d{4}|\d{3}[-\s]?\d{4}[-\s]?\d{5})/g;
  const phoneCandidates = Array.from(normalizedText.matchAll(/0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/g))
    .map(matchValue => normalizePhone(matchValue[0]))
    .filter(value => value.length >= 10 && value.length <= 11);
  const digitCandidates = Array.from(normalizedText.matchAll(/\d[\d\s-]{5,}\d/g))
    .map(matchValue => normalizePhone(matchValue[0]))
    .filter(value => value.length >= 7 && value.length <= 13);
  const sectionPhones = Array.from(new Set([...phoneCandidates, ...digitCandidates]));

  for (const match of normalizedText.matchAll(trackingPattern)) {
    const trackingNumber = normalizePhone(match[0]);
    if (trackingNumber.length !== 12 || seen.has(trackingNumber)) continue;
    seen.add(trackingNumber);

    candidates.push({
      trackingNumber,
      fileName: section.fileName,
      pdfTypeLabel: section.pdfTypeLabel,
      pageNumber: section.pageNumber,
      section: section.section,
      sectionLabel: section.sectionLabel,
      pdfPosition: `${section.pdfTypeLabel ? `${section.pdfTypeLabel} / ` : ''}${section.fileName} ${section.pageNumber}ページ ${section.sectionLabel}`,
      normalizedBlockText: normalizeText(normalizedText),
      phoneCandidates: sectionPhones.filter(value => value !== trackingNumber)
    });
  }

  return candidates;
}

function extractShipmentsFromPdfSections(sections) {
  return sections.flatMap(section => extractShipmentsFromPdfSection(section));
}

module.exports = {
  extractPdfSections,
  extractShipmentsFromPdfSections
};
