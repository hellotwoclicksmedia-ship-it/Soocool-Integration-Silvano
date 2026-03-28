'use strict';
require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');
const { buildPizzaPayload, parseDeliveryWindow } = require('../src/utils/orderMapper');

async function main() {
    const c = axios.create({
        baseURL: `https://${config.shopify.storeUrl}/admin/api/2024-04`,
        headers: { 'X-Shopify-Access-Token': config.shopify.accessToken }
    });

    // Fetch order #117900
    const r = await c.get('/orders.json?name=117900&status=any');
    const order = r.data.orders[0];

    if (!order) {
        console.log('Order 117900 not found');
        return;
    }

    console.log('=== Order #117900 ===');
    console.log('Line items:');
    for (const item of order.line_items) {
        console.log(`  - ${item.name} | qty: ${item.quantity} | product_id: ${item.product_id}`);
    }

    console.log('\nNote attributes:');
    for (const attr of (order.note_attributes || [])) {
        console.log(`  ${attr.name}: ${attr.value}`);
    }

    // Show what the current buildPizzaPayload produces
    try {
        const deliveryWindow = parseDeliveryWindow(order.note_attributes);
        const payload = buildPizzaPayload(order, deliveryWindow);
        console.log('\n=== Current Pizza Payload ===');
        console.log('Number of goods:', payload.goods.length);
        console.log('Goods:', JSON.stringify(payload.goods, null, 2));
        console.log('\nTask goods refs:', payload.tasks[0].goods);
        console.log('\nFull payload:', JSON.stringify(payload, null, 2));
    } catch (err) {
        console.log('\nCould not build pizza payload:', err.message);
    }
}

main().catch(console.error);
