'use strict';
const soocool = require('../soocool/client');
const shopify = require('../shopify/client');
const store = require('../db/store');
const { parseDeliveryWindow, buildMealPayload, groupItemsIntoBoxesFromGraphQL } = require('../utils/orderMapper');
const { generateOrderPdf } = require('../utils/pdfGenerator');

/**
 * Handles a Meal flow order:
 *
 * Flow:
 *  1. Parse delivery window from note_attributes (customer delivery date/time)
 *  2. Fetch bundle grouping via GraphQL lineItemGroup (no manual tags needed)
 *  3. Group items into boxes (1 box = 1 SooCool "good" = 1 shipping label)
 *  4. Send delivery-only order to SooCool with multiple goods
 *     → SooCool picks up from their own NL warehouse internally
 *  5. Save order mapping to DB
 *  6. Fetch SooCool shipping label PDF (may have multiple pages)
 *  7. Generate combined PDF (labels + product list) → ready to be sent to Italy
 *     so Italy can attach it and ship the box to SooCool's NL warehouse
 */
async function runMealFlow(order) {
    const tag = `[mealFlow][order:${order.order_number}]`;
    console.log(`${tag} Starting`);

    const deliveryWindow = parseDeliveryWindow(order.note_attributes, order.shipping_lines);
    console.log(`${tag} Delivery window:`, deliveryWindow);

    // Fetch bundle groups via GraphQL (replaces per-product tag fetching)
    const bundleGroups = await shopify.getOrderBundleGroups(order.id);
    const boxGroups = groupItemsIntoBoxesFromGraphQL(order.line_items, bundleGroups);

    const totalBoxes = boxGroups.reduce((sum, g) => sum + g.boxCount, 0);
    console.log(`${tag} Detected ${boxGroups.length} bundle group(s), ${totalBoxes} total box(es):`);
    for (const g of boxGroups) {
        console.log(`${tag}   - ${g.bundleName}: ${g.items.length} products, ${g.boxCount} box(es)`);
    }

    const payload = buildMealPayload(order, deliveryWindow, boxGroups);
    console.log(`${tag} Sending to SooCool (${payload.goods.length} goods)...`);

    const soocoolOrderId = await soocool.createOrder(payload);
    console.log(`${tag} SooCool order created: ${soocoolOrderId}`);

    // Modified: Save the full startTime so we can detect time-only changes during updates
    store.saveMapping({
        shopifyOrderId: order.id,
        shopifyOrderNumber: order.order_number,
        soocoolOrderId,
        flow: 'meal',
        deliveryDate: deliveryWindow.startTime,
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
    const pdfPath = await generateOrderPdf({ order, deliveryWindow, labelBuffer, boxGroups });
    console.log(`${tag} PDF saved to: ${pdfPath}`);

    store.updatePdfPath(order.id, pdfPath);

    // Store PDF data in DB so it survives server restarts
    const fs = require('fs');
    try {
        const pdfBuffer = fs.readFileSync(pdfPath);
        store.savePdfData(order.id, pdfBuffer, labelBuffer);
        console.log(`${tag} PDF data saved to DB (${pdfBuffer.length} bytes combined, ${labelBuffer?.length || 0} bytes label)`);
    } catch (err) {
        console.warn(`${tag} Could not save PDF data to DB: ${err.message}`);
    }

    console.log(`${tag} Done. soocoolOrderId=${soocoolOrderId}, pdf=${pdfPath}, boxes=${totalBoxes}`);
    return { soocoolOrderId, pdfPath, totalBoxes };
}

module.exports = { runMealFlow };

