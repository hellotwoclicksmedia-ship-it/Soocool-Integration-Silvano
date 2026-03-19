'use strict';
/**
 * ONE-OFF FIX: Update SooCool order 233872 (Shopify #117900)
 * 
 * Problem:  Order was placed with 1 good, but customer ordered qty 2.
 * Fix:      PUT /order/233872 with 2 goods instead of 1.
 * 
 * This script uses the server's env vars (SOOCOOL_BASE_URL, SOOCOOL_API_KEY, etc.)
 * so it will hit whatever SooCool environment is configured.
 * 
 * Usage:
 *   DRY RUN (safe, no changes):   node scripts/fix_order_117900.js
 *   LIVE UPDATE:                   node scripts/fix_order_117900.js --execute
 */
require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');
const { buildPizzaPayload, parseDeliveryWindow } = require('../src/utils/orderMapper');

const SOOCOOL_ORDER_ID = 233872;
const SHOPIFY_ORDER_NAME = '117900';
const EXECUTE = process.argv.includes('--execute');

async function main() {
    console.log('=== Fix Order #117900 (SooCool #233872) ===');
    console.log(`Mode: ${EXECUTE ? '🔴 LIVE — will update SooCool' : '🟢 DRY RUN — no changes will be made'}`);
    console.log(`SooCool URL: ${config.soocool.baseUrl}`);
    console.log('');

    // Step 1: Fetch the order from Shopify
    console.log('[1/4] Fetching order from Shopify...');
    const shopifyClient = axios.create({
        baseURL: `https://${config.shopify.storeUrl}/admin/api/2024-04`,
        headers: { 'X-Shopify-Access-Token': config.shopify.accessToken },
        timeout: 15000,
    });

    const r = await shopifyClient.get(`/orders.json?name=${SHOPIFY_ORDER_NAME}&status=any`);
    const order = r.data.orders[0];

    if (!order) {
        console.error(`Order #${SHOPIFY_ORDER_NAME} not found in Shopify!`);
        process.exit(1);
    }

    console.log(`  Found: Shopify ID ${order.id}, order #${order.order_number}`);
    console.log(`  Line items:`);
    for (const item of order.line_items) {
        console.log(`    - ${item.name} | qty: ${item.quantity}`);
    }

    // Step 2: Build the fixed payload (now creates 1 good per qty)
    console.log('\n[2/4] Building fixed payload...');
    const deliveryWindow = parseDeliveryWindow(order.note_attributes);
    const payload = buildPizzaPayload(order, deliveryWindow);

    console.log(`  Goods count: ${payload.goods.length}`);
    console.log(`  Good IDs: [${payload.tasks[0].goods.join(', ')}]`);
    for (const g of payload.goods) {
        console.log(`    - goodId: ${g.goodId}, contents: "${g.contents}"`);
    }

    if (payload.goods.length <= 1) {
        console.error('  ⚠️  Payload still has only 1 good — fix may not be applied. Aborting.');
        process.exit(1);
    }

    // Step 3: Verify current SooCool order state
    console.log('\n[3/4] Checking current SooCool order state...');
    const soocoolClient = axios.create({
        baseURL: config.soocool.baseUrl,
        headers: {
            'X-API-Key': config.soocool.apiKey,
            'Content-Type': 'application/json',
        },
        timeout: 15000,
    });

    try {
        const currentOrder = await soocoolClient.get(`/order/${SOOCOOL_ORDER_ID}`);
        const currentGoods = currentOrder.data?.goods || [];
        const taskState = currentOrder.data?.tasks?.[0]?.taskState;
        console.log(`  Current state: ${taskState}`);
        console.log(`  Current goods count: ${currentGoods.length}`);
        for (const g of currentGoods) {
            console.log(`    - goodId: ${g.goodId}, contents: "${g.contents}", barcode: ${g.barcode}`);
        }

        if (currentGoods.length >= 2) {
            console.log('  ✅ Order already has 2+ goods — no fix needed!');
            process.exit(0);
        }
    } catch (err) {
        console.error(`  Could not fetch current order: ${err.response?.status} ${err.response?.data?.message || err.message}`);
        console.error('  Proceeding cautiously...');
    }

    // Step 4: Update the order
    if (!EXECUTE) {
        console.log('\n[4/4] DRY RUN — Skipping update.');
        console.log('\n📋 Payload that WOULD be sent:');
        console.log(JSON.stringify(payload, null, 2));
        console.log('\n✅ Dry run complete. To apply, run:');
        console.log('   node scripts/fix_order_117900.js --execute');
        return;
    }

    console.log(`\n[4/4] Updating SooCool order ${SOOCOOL_ORDER_ID}...`);
    try {
        const res = await soocoolClient.put(`/order/${SOOCOOL_ORDER_ID}`, payload);
        console.log('  ✅ SUCCESS! Order updated.');
        console.log(`  Updated goods count: ${res.data?.goods?.length || 'unknown'}`);
        if (res.data?.goods) {
            for (const g of res.data.goods) {
                console.log(`    - goodId: ${g.goodId}, contents: "${g.contents}", barcode: ${g.barcode}`);
            }
        }
    } catch (err) {
        console.error('  ❌ FAILED to update order!');
        console.error(`  Status: ${err.response?.status}`);
        console.error(`  Response:`, JSON.stringify(err.response?.data || err.message, null, 2));
        process.exit(1);
    }

    console.log('\n🎉 Done! Order #117900 now has 2 goods in SooCool.');
}

main().catch((err) => {
    console.error('Unexpected error:', err.message);
    process.exit(1);
});
