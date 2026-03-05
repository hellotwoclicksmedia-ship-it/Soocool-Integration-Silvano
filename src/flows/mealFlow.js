'use strict';
const soocool = require('../soocool/client');
const shopify = require('../shopify/client');
const store = require('../db/store');
const { parseDeliveryWindow, buildMealPayload, groupItemsIntoBoxes } = require('../utils/orderMapper');
const { generateOrderPdf } = require('../utils/pdfGenerator');

/**
 * Handles a Meal flow order:
 *
 * Flow:
 *  1. Parse delivery window from note_attributes (customer delivery date/time)
 *  2. Fetch product tags from Shopify to determine bundle groupings
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

    const deliveryWindow = parseDeliveryWindow(order.note_attributes);
    console.log(`${tag} Delivery window:`, deliveryWindow);

    // Fetch product tags and group items into boxes
    const productIds = order.line_items.map(i => i.product_id);
    const tagsMap = await shopify.getProductTags(productIds);
    const boxGroups = groupItemsIntoBoxes(order.line_items, tagsMap);

    const totalBoxes = boxGroups.reduce((sum, g) => sum + g.boxCount, 0);
    console.log(`${tag} Detected ${boxGroups.length} bundle group(s), ${totalBoxes} total box(es):`);
    for (const g of boxGroups) {
        console.log(`${tag}   - ${g.bundleName}: ${g.items.length} products, ${g.boxCount} box(es)`);
    }

    const payload = buildMealPayload(order, deliveryWindow, boxGroups);
    console.log(`${tag} Sending to SooCool (${payload.goods.length} goods)...`);

    const soocoolOrderId = await soocool.createOrder(payload);
    console.log(`${tag} SooCool order created: ${soocoolOrderId}`);

    store.saveMapping({
        shopifyOrderId: order.id,
        shopifyOrderNumber: order.order_number,
        soocoolOrderId,
        flow: 'meal',
        deliveryDate: deliveryWindow.startTime.split('T')[0],
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

    console.log(`${tag} Done. soocoolOrderId=${soocoolOrderId}, pdf=${pdfPath}, boxes=${totalBoxes}`);
    return { soocoolOrderId, pdfPath, totalBoxes };
}

module.exports = { runMealFlow };
