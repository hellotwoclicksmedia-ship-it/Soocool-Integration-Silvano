/**
 * scripts/test-order.js
 *
 * Manually runs an existing Shopify order through the Pizza or Meal flow.
 * Does NOT require ngrok or a live webhook — fetches the order directly from Shopify API.
 *
 * Usage:
 *   node scripts/test-order.js <shopify-order-id> [--flow=pizza|meal]
 *
 * Examples:
 *   node scripts/test-order.js 6123456789012
 *   node scripts/test-order.js 6123456789012 --flow=meal
 *
 * Use --flow to override auto-detection (useful if product_type isn't set in Shopify yet)
 *
 * The order ID is the numeric Shopify order ID (not the order number like #1234).
 * You can find it in the Shopify Admin URL when viewing an order:
 *   https://yourstore.myshopify.com/admin/orders/6123456789012
 *                                                ^^^^^^^^^^^^^^^
 */

'use strict';
require('dotenv').config();

// SooCool staging rejects localhost webhook URLs — override BEFORE config loads
if (process.env.WEBHOOK_BASE_URL && process.env.WEBHOOK_BASE_URL.includes('localhost')) {
    process.env.WEBHOOK_BASE_URL = 'https://example.com';
    console.log('⚠️  Local test: WEBHOOK_BASE_URL overridden to https://example.com (SooCool rejects localhost)');
    console.log('   Webhooks won\'t fire — check SooCool staging portal directly.\n');
}

const axios = require('axios');
const config = require('../src/config');
const { detectFlow } = require('../src/utils/flowDetector');
const { runPizzaFlow } = require('../src/flows/pizzaFlow');
const { runMealFlow } = require('../src/flows/mealFlow');

const args = process.argv.slice(2);
const orderId = args.find(a => !a.startsWith('--'));
const flowArg = (args.find(a => a.startsWith('--flow=')) || '').replace('--flow=', '').toLowerCase() || null;
const mockWindow = args.includes('--mock-window');

if (!orderId) {
    console.error('Usage: node scripts/test-order.js <shopify-order-id> [--flow=pizza|meal]');
    console.error('Example: node scripts/test-order.js 12080406266200 --flow=meal');
    process.exit(1);
}

async function main() {
    console.log(`\n🔍 Fetching Shopify order ${orderId}...`);
    const shopifyClient = axios.create({
        baseURL: `https://${config.shopify.storeUrl}/admin/api/2024-04`,
        headers: {
            'X-Shopify-Access-Token': config.shopify.accessToken,
        },
    });

    let order;
    try {
        const res = await shopifyClient.get(`/orders/${orderId}.json`);
        order = res.data.order;
    } catch (err) {
        console.error('❌ Failed to fetch order:', err.response?.data || err.message);
        process.exit(1);
    }

    console.log(`✅ Order found: #${order.order_number} — "${order.email}"`);
    console.log(`   Shipping to: ${order.shipping_address?.city}, ${order.shipping_address?.country_code}`);
    console.log(`   Line items:`);
    for (const item of order.line_items) {
        console.log(`     - ${item.title} (product_type: "${item.product_type}") x${item.quantity}`);
    }

    console.log(`\n📦 note_attributes:`);
    for (const attr of (order.note_attributes || [])) {
        console.log(`   ${attr.name}: ${attr.value}`);
    }

    // Check country
    const country = order.shipping_address?.country_code;
    if (!['NL', 'BE'].includes(country)) {
        console.warn(`\n⚠️  Country "${country}" is not NL or BE — this order would be skipped in production.`);
        console.warn('   Continuing anyway for testing purposes...');
    }

    // Detect flow (or use --flow override)
    let flow = flowArg;
    if (flow && !['pizza', 'meal'].includes(flow)) {
        console.error('❌ Invalid --flow value. Use --flow=pizza or --flow=meal');
        process.exit(1);
    }
    if (!flow) {
        flow = detectFlow(order.line_items);
    }
    if (flow === 'unknown') {
        console.error('❌ Flow could not be detected. product_type is empty on all line items.');
        console.error('   Fix: set product_type to "Pizza" or "Meal" in Shopify product catalog, OR');
        console.error('   Run: node scripts/test-order.js ' + orderId + ' --flow=meal');
        process.exit(1);
    }
    console.log(`\n🔎 Flow: ${flow.toUpperCase()}${flowArg ? ' (overridden via --flow)' : ' (auto-detected)'}`);

    console.log(`\n🚀 Running ${flow} flow...`);
    console.log('   (This will create a REAL order in SooCool staging — check your SOOCOOL_BASE_URL in .env)\n');

    // Inject mock delivery window if --mock-window flag is set
    if (mockWindow) {
        const mockDate = new Date();
        mockDate.setDate(mockDate.getDate() + 30);
        const d = mockDate.toISOString().slice(0, 10);
        // Replace any existing Delivery-Date / Delivery-Time so the mock overrides stale dates
        const filtered = (order.note_attributes || []).filter(
            a => a.name !== 'Delivery-Date' && a.name !== 'Delivery-Time'
        );
        order.note_attributes = [
            ...filtered,
            { name: 'Delivery-Date', value: d.replace(/-/g, '/') },
            { name: 'Delivery-Time', value: '8:00 AM - 6:00 PM' },
        ];
        console.log(`Warning: --mock-window injected delivery window ${d} 08:00-18:00 for testing\n`);
    }

    try {
        let result;
        if (flow === 'pizza') {
            result = await runPizzaFlow(order);
        } else {
            result = await runMealFlow(order);
        }
        console.log('\n✅ Flow completed!', result);
    } catch (err) {
        console.error('\n❌ Flow failed:', err.message);
        if (err.response?.data) {
            console.error('   SooCool error:', JSON.stringify(err.response.data, null, 2));
        }
        process.exit(1);
    }
}

main();
