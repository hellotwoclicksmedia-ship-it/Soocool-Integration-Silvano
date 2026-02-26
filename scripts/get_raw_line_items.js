'use strict';
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const config = require('../src/config');

async function main() {
    const c = axios.create({
        baseURL: `https://${config.shopify.storeUrl}/admin/api/2024-04`,
        headers: { 'X-Shopify-Access-Token': config.shopify.accessToken }
    });

    // Using the order name (number) to find the order
    const r = await c.get('/orders.json?name=115900&status=any');
    const order = r.data.orders[0];

    if (!order) {
        console.log('Order 115900 not found');
        return;
    }

    console.log('Order Number:', order.order_number);
    console.log('Order Name:', order.name);

    // Save the completely raw line items to a file
    fs.writeFileSync('scripts/raw_line_items.json', JSON.stringify(order.line_items, null, 2));
    console.log('Detailed line items saved to scripts/raw_line_items.json');
}

main().catch(console.error);
