'use strict';
require('dotenv').config();
const config = require('../src/config');
const store = require('../src/db/store');
const soocool = require('../src/soocool/client');

// Order numbers to cancel in SooCool
const orderNumbers = process.argv.slice(2);
if (orderNumbers.length === 0) {
    console.log('Usage: node scripts/cancel-orders.js 118400 118100');
    process.exit(1);
}

async function main() {
    for (const num of orderNumbers) {
        const tag = `[cancel-script][#${num}]`;
        console.log(`${tag} Looking up order...`);

        const mapping = store.getMappingByOrderNumber(num);
        if (!mapping) {
            console.warn(`${tag} No SooCool mapping found in DB — skipping`);
            continue;
        }

        const soocoolOrderId = mapping.soocool_order_id;
        console.log(`${tag} Found SooCool order ID: ${soocoolOrderId}`);

        try {
            const result = await soocool.cancelOrder(soocoolOrderId);
            if (result.cancelled) {
                console.log(`${tag} ✅ Cancelled successfully in SooCool`);
            } else {
                console.warn(`${tag} ⚠️ Not cancelled: ${result.reason}`);
            }
        } catch (err) {
            console.error(`${tag} ❌ Error: ${err.message}`);
        }
    }
}

main().catch(e => console.error('Fatal:', e.message));
