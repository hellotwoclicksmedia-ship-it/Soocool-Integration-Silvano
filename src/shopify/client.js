'use strict';
const axios = require('axios');
const config = require('../config');

const client = axios.create({
    baseURL: `https://${config.shopify.storeUrl}/admin/api/2024-04`,
    headers: {
        'X-Shopify-Access-Token': config.shopify.accessToken,
        'Content-Type': 'application/json',
    },
    timeout: 15000,
});

client.interceptors.response.use(
    (res) => res,
    (err) => {
        console.error('[shopify] API error', {
            status: err.response?.status,
            url: err.config?.url,
            errors: err.response?.data?.errors || err.message,
        });
        return Promise.reject(err);
    }
);

/**
 * Mark a Shopify order as fulfilled with a tracking link.
 */
async function fulfillOrder(shopifyOrderId, trackingUrl, trackingNumber) {
    // Step 1: get fulfillment order id
    const foRes = await client.get(`/orders/${shopifyOrderId}/fulfillment_orders.json`);
    const fulfillmentOrders = foRes.data.fulfillment_orders || [];
    const open = fulfillmentOrders.find((fo) => fo.status === 'open');
    if (!open) {
        console.warn(`[shopify] No open fulfillment order for Shopify order ${shopifyOrderId}`);
        return;
    }

    // Step 2: create fulfillment
    await client.post('/fulfillments.json', {
        fulfillment: {
            line_items_by_fulfillment_order: [{ fulfillment_order_id: open.id }],
            tracking_info: {
                number: trackingNumber || '',
                url: trackingUrl || '',
            },
            notify_customer: true,
        },
    });

    console.log(`[shopify] Fulfillment created for order ${shopifyOrderId}`);
}

/**
 * Append a note to a Shopify order.
 */
async function addOrderNote(shopifyOrderId, note) {
    const res = await client.get(`/orders/${shopifyOrderId}.json?fields=note`);
    const existing = res.data.order.note || '';
    const newNote = existing ? `${existing}\n\n${note}` : note;
    await client.put(`/orders/${shopifyOrderId}.json`, {
        order: { id: shopifyOrderId, note: newNote },
    });
    console.log(`[shopify] Note added to order ${shopifyOrderId}`);
}

module.exports = { fulfillOrder, addOrderNote };
