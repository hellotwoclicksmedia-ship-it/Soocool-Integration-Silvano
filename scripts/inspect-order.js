'use strict';
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const config = require('../src/config');

const orderName = process.argv[2] || '115900';

async function main() {
    const client = axios.create({
        baseURL: `https://${config.shopify.storeUrl}/admin/api/2024-04`,
        headers: { 'X-Shopify-Access-Token': config.shopify.accessToken },
    });

    const res = await client.get(`/orders.json?name=${orderName}&status=any`);
    const order = res.data.orders[0];
    if (!order) { console.log('Order not found'); return; }

    // Save raw line_items to a JSON file
    const output = {
        orderId: order.id,
        orderNumber: order.order_number,
        itemCount: order.line_items.length,
        lineItems: order.line_items.map(item => ({
            title: item.title,
            quantity: item.quantity,
            productType: item.product_type,
            sku: item.sku,
            variantTitle: item.variant_title,
            properties: item.properties,
        })),
    };

    fs.writeFileSync('scripts/order_data.json', JSON.stringify(output, null, 2), 'utf8');
    console.log('Saved to scripts/order_data.json');
    console.log('Items:', output.itemCount);
}

main().catch(e => console.error('Error:', e.response?.data || e.message));
