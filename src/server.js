const express = require('express');
const path = require('path');
const multer = require('multer');
const config = require('./config');
const { extractTargetOrders } = require('./lib/csv');
const { extractPdfSections, extractShipmentsFromPdfSections } = require('./lib/pdf');
const { matchOrdersToShipments } = require('./lib/matcher');
const { TikTokShopClient } = require('./lib/tiktok-shop-client');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024,
    files: 24
  }
});
const tiktok = new TikTokShopClient(config.tiktok);

function findPackageId(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPackageId(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.packages) && value.packages.length) {
      const firstPackage = value.packages[0];
      return String(firstPackage.package_id || firstPackage.packageId || firstPackage.id || '');
    }
    if (Array.isArray(value.package_list) && value.package_list.length) {
      const firstPackage = value.package_list[0];
      return String(firstPackage.package_id || firstPackage.packageId || firstPackage.id || '');
    }
    if (value.package_id || value.packageId) return String(value.package_id || value.packageId);
    for (const item of Object.values(value)) {
      const found = findPackageId(item);
      if (found) return found;
    }
  }
  return '';
}

async function enrichPackageIds(orders) {
  const missing = orders.filter(order => order.status === 'matched' && order.orderId && !order.packageId);
  if (!missing.length) return orders;

  const byOrderId = new Map();
  const orderIds = Array.from(new Set(missing.map(order => order.orderId)));
  const chunkSize = 50;

  for (let i = 0; i < orderIds.length; i += chunkSize) {
    const chunk = orderIds.slice(i, i + chunkSize);
    const details = await tiktok.getOrderDetails(chunk);
    details.forEach(detail => {
      const orderId = String(detail.id || detail.order_id || detail.orderId || '');
      const packageId = findPackageId(detail);
      if (orderId && packageId) byOrderId.set(orderId, packageId);
    });
  }

  return orders.map(order => {
    if (order.packageId || !byOrderId.has(order.orderId)) return order;
    return {
      ...order,
      packageId: byOrderId.get(order.orderId),
      message: `${order.message} / package_id自動取得`
    };
  });
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res, next) => {
  const fallbackFiles = [
    path.join(__dirname, '..', 'public', 'index.html'),
    path.join(__dirname, '..', 'index.html')
  ];
  const sendFallback = index => {
    if (index >= fallbackFiles.length) return next();
    return res.sendFile(fallbackFiles[index], err => {
      if (!err) return undefined;
      return sendFallback(index + 1);
    });
  };
  return sendFallback(0);
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/config-status', (req, res) => {
  res.json({
    dryRun: config.dryRun,
    hasAppKey: Boolean(config.tiktok.appKey),
    hasAuthCode: Boolean(config.tiktok.authCode),
    hasAccessToken: Boolean(config.tiktok.accessToken),
    hasRefreshToken: Boolean(config.tiktok.refreshToken),
    hasShopCipher: Boolean(config.tiktok.shopCipher),
    hasShippingProviderId: Boolean(config.tiktok.shippingProviderId),
    hasShipEndpointPath: Boolean(config.tiktok.shipEndpointPath),
    hasStatusEndpointPath: Boolean(config.tiktok.statusEndpointPath)
  });
});

app.post('/api/preview', upload.fields([
  { name: 'ordersCsv', maxCount: 1 },
  { name: 'shippingPdfs', maxCount: 10 },
  { name: 'nekoposPdfs', maxCount: 10 }
]), async (req, res) => {
  try {
    const csvFile = req.files?.ordersCsv?.[0];
    const shippingPdfFiles = req.files?.shippingPdfs || [];
    const nekoposPdfFiles = req.files?.nekoposPdfs || [];
    const pdfFiles = [
      ...shippingPdfFiles.map(file => ({ file, pdfTypeLabel: '宅急便コンパクト以上', pdfLayout: 'two' })),
      ...nekoposPdfFiles.map(file => ({ file, pdfTypeLabel: 'ネコポス', pdfLayout: 'six' }))
    ];

    if (!csvFile) return res.status(400).json({ error: 'TikTok Shop注文CSVを選択してください。' });
    if (!pdfFiles.length) return res.status(400).json({ error: '宅急便コンパクト以上PDFまたはネコポスPDFを選択してください。' });

    const extracted = extractTargetOrders(csvFile.buffer, {
      dateColumnIndex: config.csvDateColumnIndex,
      packageIdLabels: config.csvPackageIdLabels,
      startAt: req.body.startAt || '',
      endAt: req.body.endAt || ''
    });
    const pdfSectionsByFile = await Promise.all(pdfFiles.map(item => extractPdfSections(item.file, item.pdfTypeLabel, item.pdfLayout)));
    const pdfSections = pdfSectionsByFile.flat();
    const shipments = extractShipmentsFromPdfSections(pdfSections);
    let orders = matchOrdersToShipments(extracted.targetOrders, shipments);
    let packageLookupError = '';
    try {
      orders = await enrichPackageIds(orders);
    } catch (err) {
      packageLookupError = err.message;
    }

    res.json({
      ...extracted,
      orders,
      pdfFiles: pdfFiles.map(item => ({ fileName: item.file.originalname, pdfTypeLabel: item.pdfTypeLabel })),
      shipmentCount: shipments.length,
      summary: {
        totalRows: extracted.totalRows,
        target: extracted.targetOrders.length,
        matched: orders.filter(order => order.status === 'matched').length,
        errors: orders.filter(order => order.status === 'error').length,
        skipped: extracted.skippedOrders.length,
        packageIdReady: orders.filter(order => order.status === 'matched' && order.packageId).length
      },
      packageLookupError
    });
  } catch (err) {
    console.error('preview error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/submit', async (req, res) => {
  try {
    const orders = Array.isArray(req.body?.orders) ? req.body.orders : [];
    const enrichedOrders = await enrichPackageIds(orders);
    const matchedOrders = enrichedOrders.filter(order => order.status === 'matched' && order.orderId && order.trackingNumber);
    if (!matchedOrders.length) return res.status(400).json({ error: 'API反映できる一致済み注文がありません。' });

    const results = [];
    for (const order of matchedOrders) {
      try {
        const result = await tiktok.submitTracking(order, { dryRun: config.dryRun });
        const verification = await tiktok.verifyTracking(order, { dryRun: config.dryRun }).catch(err => ({
          ok: false,
          dryRun: config.dryRun,
          message: err.message
        }));
        results.push({
          ...order,
          status: result.dryRun ? 'dry_run' : 'submitted',
          verified: verification.ok,
          verificationMessage: verification.message,
          message: `${result.message}${verification.message ? ` / 確認: ${verification.message}` : ''}`
        });
      } catch (err) {
        results.push({
          ...order,
          status: 'error',
          message: err.message
        });
      }
    }

    res.json({
      dryRun: config.dryRun,
      results,
      summary: {
        submitted: results.filter(result => result.status === 'submitted').length,
        dryRun: results.filter(result => result.status === 'dry_run').length,
        errors: results.filter(result => result.status === 'error').length
      }
    });
  } catch (err) {
    console.error('submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`TikTok Shop追跡番号システム: http://localhost:${config.port}`);
  console.log(`dry run: ${config.dryRun ? 'on' : 'off'}`);
});
