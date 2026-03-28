require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');
const shopify = require('../src/shopify/client');
const soocool = require('../src/soocool/client');
const { parseDeliveryWindow, buildMealPayload, groupItemsIntoBoxes } = require('../src/utils/orderMapper');
const fs = require('fs');

const client = axios.create({
    baseURL: `https://${config.shopify.storeUrl}/admin/api/2024-04`,
    headers: { 'X-Shopify-Access-Token': config.shopify.accessToken },
});

(async () => {
    const orderName = process.argv[2];
    const r = await client.get(`/orders.json?name=${orderName}&status=any`);
    const order = r.data.orders[0];
    if (!order) { console.log('NOT FOUND'); process.exit(1); }

    console.log(`Order #${order.order_number}, ID: ${order.id}`);

    const productIds = [...new Set(order.line_items.map(i => i.product_id))];
    const tagsMap = await shopify.getProductTags(productIds);
    const boxGroups = groupItemsIntoBoxes(order.line_items, tagsMap);
    const dw = parseDeliveryWindow(order.note_attributes);
    const payload = buildMealPayload(order, dw, boxGroups);

    console.log('Sending payload to SooCool...');
    console.log('Goods count:', payload.goods.length);

    try {
        const result = await soocool.createOrder(payload);
        fs.writeFileSync('scripts/soocool_response.json', JSON.stringify(result, null, 2));
        console.log('SUCCESS - soocool response saved to scripts/soocool_response.json');
        console.log('orderId:', result.orderId || result);
    } catch (e) {
        const errData = e.response?.data || e.message;
        fs.writeFileSync('scripts/soocool_response.json', JSON.stringify(errData, null, 2));
        console.log('ERROR', e.response?.status, '- saved to scripts/soocool_response.json');
    }
})();
