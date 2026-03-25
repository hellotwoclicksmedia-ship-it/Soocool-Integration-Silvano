'use strict';
const soocool = require('../soocool/client');
const store = require('../db/store');
const { parseDeliveryWindow, buildPizzaPayload } = require('../utils/orderMapper');

/**
 * Handles a Pizza flow order:
 *  1. Parse delivery window from note_attributes
 *  2. Build + POST SooCool delivery-only payload
 *  3. Save order mapping to DB
 */
async function runPizzaFlow(order) {
    const tag = `[pizzaFlow][order:${order.order_number}]`;
    console.log(`${tag} Starting`);

    const deliveryWindow = parseDeliveryWindow(order.note_attributes, order.shipping_lines);
    console.log(`${tag} Delivery window:`, deliveryWindow);

    const payload = buildPizzaPayload(order, deliveryWindow);
    console.log(`${tag} Sending to SooCool...`);

    const soocoolOrderId = await soocool.createOrder(payload);
    console.log(`${tag} SooCool order created: ${soocoolOrderId}`);

    // Modified: Save the full startTime so we can detect time-only changes during updates
    store.saveMapping({
        shopifyOrderId: order.id,
        shopifyOrderNumber: order.order_number,
        soocoolOrderId,
        flow: 'pizza',
        deliveryDate: deliveryWindow.startTime,
    });

    console.log(`${tag} Done. soocoolOrderId=${soocoolOrderId}`);
    return { soocoolOrderId };
}

module.exports = { runPizzaFlow };
