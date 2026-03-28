require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');
const shopify = require('../src/shopify/client');
const { parseDeliveryWindow, buildMealPayload, groupItemsIntoBoxes } = require('../src/utils/orderMapper');
const fs = require('fs');

const client = axios.create({
    baseURL: `https://${config.shopify.storeUrl}/admin/api/2024-04`,
    headers: { 'X-Shopify-Access-Token': config.shopify.accessToken },
});

(async () => {
    const orderName = process.argv[2];
    const r = await client.get(`/orders.json?name=${orderName}&status=any`);
    const order = r.data.order || r.data.orders[0];
    if (!order) { console.log('NOT FOUND'); process.exit(1); }

    const productIds = [...new Set(order.line_items.map(i => i.product_id))];
    const tagsMap = await shopify.getProductTags(productIds);

    const boxGroups = groupItemsIntoBoxes(order.line_items, tagsMap);

    let dw;
    try { dw = parseDeliveryWindow(order.note_attributes); } catch (e) { dw = { startTime: 'N/A', endTime: 'N/A' }; }

    const payload = order.line_items.some(i => tagsMap.get(i.product_id)?.includes('bundle:'))
        ? buildMealPayload(order, dw, boxGroups)
        : null;

    const result = {
        orderId: order.id,
        orderNumber: order.order_number,
        lineItems: order.line_items.map(i => ({
            title: i.title,
            qty: i.quantity,
            grams: i.grams,
            productId: i.product_id,
            bundleTag: (tagsMap.get(i.product_id) || '').split(',').map(t => t.trim()).find(t => t.startsWith('bundle:')) || 'NONE',
        })),
        boxGroups: boxGroups.map(g => ({ name: g.bundleName, boxCount: g.boxCount, itemCount: g.items.length })),
        payloadGoods: payload ? payload.goods : 'N/A (not meal flow)',
        taskGoodIds: payload ? payload.tasks[0].goods : 'N/A',
    };

    fs.writeFileSync('scripts/result.json', JSON.stringify(result, null, 2));
    console.log('Written to scripts/result.json');
})();
