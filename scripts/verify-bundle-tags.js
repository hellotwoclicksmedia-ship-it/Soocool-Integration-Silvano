'use strict';
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const config = require('../src/config');

async function main() {
    const client = axios.create({
        baseURL: `https://${config.shopify.storeUrl}/admin/api/2024-04`,
        headers: { 'X-Shopify-Access-Token': config.shopify.accessToken },
    });

    const orderRes = await client.get('/orders.json?name=115900&status=any');
    const order = orderRes.data.orders[0];
    if (!order) { console.log('Order not found'); return; }

    const results = [];
    const productIds = [...new Set(order.line_items.map(i => i.product_id))];

    for (const pid of productIds) {
        const pRes = await client.get(`/products/${pid}.json?fields=id,title,tags,product_type`);
        const p = pRes.data.product;
        const bundleTag = (p.tags || '').split(',').map(t => t.trim()).find(t => t.startsWith('bundle:'));
        results.push({ title: p.title, productType: p.product_type, bundleTag: bundleTag || null });
    }

    fs.writeFileSync('scripts/bundle_tags_result.json', JSON.stringify(results, null, 2));
    console.log('Done! Results saved.');
}

main().catch(console.error);
