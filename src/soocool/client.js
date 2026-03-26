'use strict';
const axios = require('axios');
const config = require('../config');

const client = axios.create({
    baseURL: config.soocool.baseUrl,
    headers: {
        'X-API-Key': config.soocool.apiKey,
        'Content-Type': 'application/json',
    },
    timeout: 15000,
});

// Log errors centrally — capture full response body for debugging
client.interceptors.response.use(
    (res) => res,
    (err) => {
        const data = err.response?.data;
        console.error('[soocool] API error', {
            status: err.response?.status,
            url: err.config?.url,
            method: err.config?.method?.toUpperCase(),
            traceId: data?.traceId,
            message: data?.message || err.message,
        });
        // Log full response body so we can see validation errors etc.
        if (data && typeof data === 'object') {
            console.error('[soocool] Full error response:', JSON.stringify(data, null, 2));
        } else if (data) {
            console.error('[soocool] Error response body:', data);
        }
        return Promise.reject(err);
    }
);

/**
 * POST /order — create a new order in SooCool
 * @returns {Promise<number>} soocoolOrderId
 */
async function createOrder(payload) {
    const res = await client.post('/order', payload);
    const soocoolOrderId = res.data?.orderId ?? res.data?.id;
    if (!soocoolOrderId) throw new Error(`SooCool createOrder returned no orderId. Body: ${JSON.stringify(res.data)}`);
    return soocoolOrderId;
}

/**
 * GET /order/{orderId} — fetch order details
 */
async function getOrder(soocoolOrderId) {
    const res = await client.get(`/order/${soocoolOrderId}`);
    return res.data;
}

/**
 * GET /order/{orderId}/shipping-label — returns PDF as Buffer
 */
async function getShippingLabel(soocoolOrderId) {
    const res = await client.get(`/order/${soocoolOrderId}/shipping-label`, {
        responseType: 'arraybuffer',
        headers: { 'Accept': 'application/pdf' },
    });
    return Buffer.from(res.data);
}

/**
 * States where a SooCool order can still be cancelled.
 * Once 'in_transit' or 'delivered' it's too late.
 */
const CANCELLABLE_STATES = new Set(['accepted', 'planned', 'allocated']);

/**
 * DELETE /order/{orderId} — cancel an order in SooCool.
 * Returns true if cancelled, false if already too late.
 */
async function cancelOrder(soocoolOrderId) {
    // Check current state first
    const order = await getOrder(soocoolOrderId);
    const state = order?.tasks?.[0]?.taskState || order?.taskState;

    if (!CANCELLABLE_STATES.has(state)) {
        console.warn(`[soocool] Cannot cancel order ${soocoolOrderId} — state is "${state}"`);
        return { cancelled: false, reason: `Order already in state: ${state}` };
    }

    await client.delete(`/order/${soocoolOrderId}`);
    console.log(`[soocool] Order ${soocoolOrderId} cancelled successfully`);
    return { cancelled: true };
}

/**
 * PUT /order/{orderId} — update an existing order in SooCool.
 * The update payload has the same structure as create (orderReference, tasks, goods required).
 * @param {number} soocoolOrderId
 * @param {Object} payload - full order payload with updated fields
 * @returns {Promise<Object>} updated order data
 */
async function updateOrder(soocoolOrderId, payload) {
    const res = await client.put(`/order/${soocoolOrderId}`, payload);
    return res.data;
}

/**
 * GET /ping — health check
 */
async function ping() {
    const res = await client.get('/ping');
    return res.data;
}

module.exports = { createOrder, getOrder, updateOrder, cancelOrder, getShippingLabel, ping };
