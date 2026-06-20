require('dotenv').config();

function boolEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return defaultValue;
  return !['false', '0', 'no'].includes(String(value).toLowerCase());
}

function splitLabels(value = '') {
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

module.exports = {
  port: Number(process.env.PORT || 3010),
  dryRun: boolEnv('TIKTOK_SHOP_DRY_RUN', true),
  csvDateColumnIndex: Number(process.env.CSV_DATE_COLUMN_INDEX || 23),
  csvPackageIdLabels: splitLabels(process.env.CSV_PACKAGE_ID_LABELS || 'Package ID,PackageID,パッケージID'),
  tiktok: {
    appKey: process.env.TTS_APP_KEY || '',
    appSecret: process.env.TTS_APP_SECRET || '',
    authCode: process.env.TTS_AUTH_CODE || '',
    accessToken: process.env.TTS_ACCESS_TOKEN || '',
    shopCipher: process.env.TTS_SHOP_CIPHER || '',
    warehouseId: process.env.TTS_WAREHOUSE_ID || '',
    deliveryOptionId: process.env.TTS_DELIVERY_OPTION_ID || '',
    shippingProviderId: process.env.TTS_SHIPPING_PROVIDER_ID || '',
    baseUrl: process.env.TTS_API_BASE_URL || 'https://open-api.tiktokglobalshop.com',
    shipEndpointPath: process.env.TTS_SHIP_ENDPOINT_PATH || '',
    statusEndpointPath: process.env.TTS_STATUS_ENDPOINT_PATH || ''
  }
};
