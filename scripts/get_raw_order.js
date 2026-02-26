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

    fs.writeFileSync('scripts/raw_order_full.json', JSON.stringify(order, null, 2));
    console.log('Full raw order saved to scripts/raw_order_full.json');
}

main().catch(console.error);
