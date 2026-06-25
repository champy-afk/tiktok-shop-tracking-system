const crypto = require('crypto');

function buildSignedUrl(baseUrl, pathTemplate, params, appSecret) {
  const path = pathTemplate
    .replace('{order_id}', encodeURIComponent(params.order_id || ''))
    .replace('{package_id}', encodeURIComponent(params.package_id || ''));
  const url = new URL(path, baseUrl);
  const timestamp = Math.floor(Date.now() / 1000);
  const query = {
    app_key: params.app_key,
    timestamp: String(timestamp),
    shop_cipher: params.shop_cipher
  };

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  });
  Object.entries(params.extraQuery || {}).forEach(([key, value]) => {
    if (value === undefined || value === '') return;
    if (Array.isArray(value)) {
      url.searchParams.set(key, value.join(','));
    } else {
      url.searchParams.set(key, value);
    }
  });

  const sorted = Array.from(url.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
  const bodyText = params.bodyText || '';
  const signBase = `${path}${sorted.map(([key, value]) => `${key}${value}`).join('')}${bodyText}`;
  const sign = crypto
    .createHmac('sha256', appSecret)
    .update(`${appSecret}${signBase}${appSecret}`)
    .digest('hex');
  url.searchParams.set('sign', sign);

  return url;
}

function buildShipmentPayload(order, shippingProviderId) {
  return {
    self_shipment: {
      tracking_number: order.trackingNumber,
      shipping_provider_id: shippingProviderId
    }
  };
}

function isTokenError(data, response) {
  const text = `${data?.message || ''} ${data?.msg || ''}`.toLowerCase();
  return response.status === 401 ||
    response.status === 403 ||
    /token|access_token|expired|invalid credential|authorization/.test(text);
}

function findTrackingStatus(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (['shipped', 'in_transit', 'delivered', 'awaiting_collection', 'ready_to_ship'].includes(normalized)) return normalized;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTrackingStatus(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['status', 'package_status', 'shipping_status', 'fulfillment_status', 'logistics_status']) {
      const found = findTrackingStatus(value[key]);
      if (found) return found;
    }
    for (const item of Object.values(value)) {
      const found = findTrackingStatus(item);
      if (found) return found;
    }
  }
  return null;
}

class TikTokShopClient {
  constructor(config) {
    this.config = config;
  }

  async refreshAccessToken() {
    if (!this.config.appKey || !this.config.appSecret || !this.config.refreshToken) {
      throw new Error('アクセストークン更新に必要な設定が不足しています: TTS_REFRESH_TOKEN');
    }

    const url = new URL('https://auth.tiktok-shops.com/api/v2/token/refresh');
    url.searchParams.set('app_key', this.config.appKey);
    url.searchParams.set('app_secret', this.config.appSecret);
    url.searchParams.set('refresh_token', this.config.refreshToken);
    url.searchParams.set('grant_type', 'refresh_token');

    const response = await fetch(url);
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`アクセストークン更新レスポンスをJSONとして読めません (${response.status}): ${text}`);
    }
    if (!response.ok || (data.code && data.code !== 0)) {
      throw new Error(`アクセストークン更新エラー (${response.status}/${data.code ?? ''}): ${data.message || data.msg || text}`);
    }

    const tokenData = data.data || data;
    if (!tokenData.access_token) throw new Error('アクセストークン更新レスポンスにaccess_tokenがありません');

    this.config.accessToken = tokenData.access_token;
    if (tokenData.refresh_token) this.config.refreshToken = tokenData.refresh_token;
    return tokenData;
  }

  validateConfig() {
    const missing = [];
    if (!this.config.appKey) missing.push('TTS_APP_KEY');
    if (!this.config.appSecret) missing.push('TTS_APP_SECRET');
    if (!this.config.accessToken) missing.push('TTS_ACCESS_TOKEN');
    if (!this.config.shopCipher) missing.push('TTS_SHOP_CIPHER');
    if (!this.config.shipEndpointPath) missing.push('TTS_SHIP_ENDPOINT_PATH');
    if (!this.config.shippingProviderId) missing.push('TTS_SHIPPING_PROVIDER_ID');
    if (missing.length) throw new Error(`TikTok Shop API設定が未完了です: ${missing.join(', ')}`);
  }

  signedGetUrl(pathTemplate, pathParams = {}, extraQuery = {}) {
    return buildSignedUrl(this.config.baseUrl, pathTemplate, {
      app_key: this.config.appKey,
      shop_cipher: this.config.shopCipher,
      order_id: pathParams.orderId,
      package_id: pathParams.packageId,
      warehouse_id: pathParams.warehouseId,
      delivery_option_id: pathParams.deliveryOptionId,
      extraQuery
    }, this.config.appSecret);
  }

  async getJson(pathTemplate, pathParams = {}, extraQuery = {}, options = {}) {
    const url = this.signedGetUrl(pathTemplate, pathParams, extraQuery);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-tts-access-token': this.config.accessToken
      }
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`TikTok Shop APIレスポンスをJSONとして読めません (${response.status}): ${text}`);
    }
    if (!response.ok || (data.code && data.code !== 0)) {
      if (!options.retried && isTokenError(data, response)) {
        await this.refreshAccessToken();
        return this.getJson(pathTemplate, pathParams, extraQuery, { retried: true });
      }
      throw new Error(`TikTok Shop APIエラー (${response.status}/${data.code ?? ''}): ${data.message || data.msg || text}`);
    }
    return data;
  }

  async getWarehouses() {
    this.validateBaseConfig();
    const data = await this.getJson('/logistics/202309/warehouses');
    return data.data?.warehouses || data.data?.warehouse_list || data.warehouses || [];
  }

  async getWarehouseDeliveryOptions(warehouseId) {
    this.validateBaseConfig();
    const data = await this.getJson('/logistics/202309/warehouses/{warehouse_id}/delivery_options', { warehouseId });
    return data.data?.delivery_options || data.data?.delivery_option_list || data.delivery_options || [];
  }

  async getShippingProviders(deliveryOptionId) {
    this.validateBaseConfig();
    const data = await this.getJson('/logistics/202309/delivery_options/{delivery_option_id}/shipping_providers', { deliveryOptionId });
    return data.data?.shipping_providers || data.data?.shipping_provider_list || data.shipping_providers || [];
  }

  async getOrderDetails(orderIds = []) {
    this.validateBaseConfig();
    const cleanIds = orderIds.map(id => String(id || '').trim()).filter(Boolean);
    if (!cleanIds.length) return [];
    const data = await this.getJson('/order/202309/orders', {}, { ids: cleanIds });
    return data.data?.orders || data.orders || [];
  }

  validateBaseConfig() {
    const missing = [];
    if (!this.config.appKey) missing.push('TTS_APP_KEY');
    if (!this.config.appSecret) missing.push('TTS_APP_SECRET');
    if (!this.config.accessToken) missing.push('TTS_ACCESS_TOKEN');
    if (!this.config.shopCipher) missing.push('TTS_SHOP_CIPHER');
    if (missing.length) throw new Error(`TikTok Shop API設定が未完了です: ${missing.join(', ')}`);
  }

  async submitTracking(order, options = {}) {
    const payload = buildShipmentPayload(order, this.config.shippingProviderId);
    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        request: {
          endpointPath: this.config.shipEndpointPath,
          payload
        },
        message: 'ドライラン: TikTok Shopには送信していません'
      };
    }

    this.validateConfig();
    if (this.config.shipEndpointPath.includes('{package_id}') && !order.packageId) {
      throw new Error(`package_id が必要です。注文ID: ${order.orderId}`);
    }

    const bodyText = JSON.stringify(payload);
    const url = buildSignedUrl(this.config.baseUrl, this.config.shipEndpointPath, {
      app_key: this.config.appKey,
      shop_cipher: this.config.shopCipher,
      order_id: order.orderId,
      package_id: order.packageId,
      bodyText
    }, this.config.appSecret);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tts-access-token': this.config.accessToken
      },
      body: bodyText
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = null;
    }
    if (!response.ok || (data && data.code && data.code !== 0)) {
      if (!options.retried && isTokenError(data, response)) {
        await this.refreshAccessToken();
        return this.submitTracking(order, { ...options, retried: true });
      }
      throw new Error(`TikTok Shop APIエラー (${response.status}/${data?.code ?? ''}): ${data?.message || data?.msg || text}`);
    }

    return {
      ok: true,
      dryRun: false,
      message: text || '反映しました'
    };
  }

  async verifyTracking(order, options = {}) {
    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        message: 'ドライランのため送信済み確認は未実行'
      };
    }

    this.validateConfig();
    if (!this.config.statusEndpointPath) {
      return {
        ok: false,
        dryRun: false,
        message: '確認API未設定'
      };
    }
    if (this.config.statusEndpointPath.includes('{package_id}') && !order.packageId) {
      throw new Error(`確認APIに package_id が必要です。注文ID: ${order.orderId}`);
    }

    const url = buildSignedUrl(this.config.baseUrl, this.config.statusEndpointPath, {
      app_key: this.config.appKey,
      shop_cipher: this.config.shopCipher,
      order_id: order.orderId,
      package_id: order.packageId
    }, this.config.appSecret);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-tts-access-token': this.config.accessToken
      }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`TikTok Shop確認APIエラー (${response.status}): ${text}`);

    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        ok: false,
        dryRun: false,
        message: '確認APIレスポンスをJSONとして読めません'
      };
    }

    const trackingText = JSON.stringify(data);
    const hasTrackingNumber = trackingText.includes(order.trackingNumber);
    const status = findTrackingStatus(data);
    const shipped = hasTrackingNumber && ['shipped', 'in_transit', 'delivered', 'awaiting_collection'].includes(status);

    return {
      ok: shipped,
      dryRun: false,
      status,
      message: shipped
        ? `送信済み確認OK (${status})`
        : `確認未確定${status ? ` (${status})` : ''}${hasTrackingNumber ? ' / 追跡番号あり' : ' / 追跡番号未検出'}`
    };
  }
}

module.exports = {
  TikTokShopClient
};
