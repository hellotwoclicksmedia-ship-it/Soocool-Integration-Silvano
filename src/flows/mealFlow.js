'use strict';
const soocool = require('../soocool/client');
const store = require('../db/store');
const { parseDeliveryWindow, buildMealPayload } = require('../utils/orderMapper');
const { generateOrderPdf } = require('../utils/pdfGenerator');

/**
 * Handles a Meal flow order:
 *
 * Flow:
 *  1. Parse delivery window from note_attributes (customer delivery date/time)
 *  2. Send delivery-only order to SooCool (customer NL/BE address)
 *     → SooCool picks up from their own NL warehouse internally
 *  3. Save order mapping to DB
 *  4. Fetch SooCool shipping label PDF
 *  5. Generate combined PDF (label + product list) → ready to be sent to Italy
 *     so Italy can attach it and ship the box to SooCool's NL warehouse
 */
async function runMealFlow(order) {
    const tag = `[mealFlow][order:${order.order_number}]`;
    console.log(`${tag} Starting`);

    const deliveryWindow = parseDeliveryWindow(order.note_attributes);
    console.log(`${tag} Delivery window:`, deliveryWindow);

    const payload = buildMealPayload(order, deliveryWindow);
    console.log(`${tag} Sending to SooCool...`);

    const soocoolOrderId = await soocool.createOrder(payload);
    console.log(`${tag} SooCool order created: ${soocoolOrderId}`);

    store.saveMapping({
        shopifyOrderId: order.id,
        shopifyOrderNumber: order.order_number,
        soocoolOrderId,
        flow: 'meal',
    });

    // Fetch shipping label — to be sent to Italy warehouse
    let labelBuffer = null;
    try {
        labelBuffer = await soocool.getShippingLabel(soocoolOrderId);
        console.log(`${tag} Shipping label fetched (${labelBuffer.length} bytes)`);
    } catch (err) {
        console.warn(`${tag} Could not fetch shipping label: ${err.message}`);
    }

    // Generate PDF with label + product list
    // This PDF is what gets sent to Italy to ship the box to SooCool's NL warehouse
    const pdfPath = await generateOrderPdf({ order, deliveryWindow, labelBuffer });
    console.log(`${tag} PDF saved to: ${pdfPath}`);

    store.updatePdfPath(order.id, pdfPath);

    console.log(`${tag} Done. soocoolOrderId=${soocoolOrderId}, pdf=${pdfPath}`);
    return { soocoolOrderId, pdfPath };
}

module.exports = { runMealFlow };
