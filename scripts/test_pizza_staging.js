'use strict';
require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');
const { buildPizzaPayload, parseDeliveryWindow } = require('../src/utils/orderMapper');

async function main() {
    const shopifyClient = axios.create({
        baseURL: `https://${config.shopify.storeUrl}/admin/api/2024-04`,
        headers: { 'X-Shopify-Access-Token': config.shopify.accessToken }
    });

    // Fetch order #117900
    const r = await shopifyClient.get('/orders.json?name=117900&status=any');
    const order = r.data.orders[0];

    if (!order) {
        console.log('Order 117900 not found');
        return;
    }

    // Build the fixed payload
    const deliveryWindow = parseDeliveryWindow(order.note_attributes);
    const payload = buildPizzaPayload(order, deliveryWindow);

    console.log(`Payload has ${payload.goods.length} goods`);
    console.log('Goods IDs:', payload.tasks[0].goods);

    // Send to SooCool STAGING
    const stagingUrl = 'https://api.staging.soocool.nl';
    console.log(`\nSending to SooCool staging: ${stagingUrl}/order`);

    const soocoolClient = axios.create({
        baseURL: stagingUrl,
        headers: {
            'X-API-Key': config.soocool.apiKey,
            'Content-Type': 'application/json',
        },
        timeout: 15000,
    });

    try {
        const res = await soocoolClient.post('/order', payload);
        const soocoolOrderId = res.data?.orderId ?? res.data?.id;
        console.log(`SUCCESS! SooCool order created: ${soocoolOrderId}`);
        console.log('Response:', JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.error('ERROR creating order:', err.response?.status, err.response?.data || err.message);
    }
}

main().catch(console.error);
