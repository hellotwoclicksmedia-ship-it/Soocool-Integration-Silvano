'use strict';
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const store = require('../db/store');
const soocool = require('../soocool/client');
const shopify = require('../shopify/client');
const { parseDeliveryWindow, buildPizzaPayload, buildMealPayload, groupItemsIntoBoxes } = require('../utils/orderMapper');
const { generateOrderPdf } = require('../utils/pdfGenerator');
const { detectFlow } = require('../utils/flowDetector');
const { runPizzaFlow } = require('../flows/pizzaFlow');
const { runMealFlow } = require('../flows/mealFlow');

const router = express.Router();

/**
 * POST /webhooks/shopify/orders/update
 * Triggered by Shopify "orders/updated" webhook.
 *
 * Detects delivery date changes in note_attributes and pushes
 * the updated delivery window to SooCool via PUT /order/{orderId}.
 */
router.post('/orders/update', (req, res) => {
    // Verify HMAC
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const digest = crypto
        .createHmac('sha256', config.shopify.webhookSecret)
        .update(req.body)
        .digest('base64');

    if (digest !== hmac) {
        console.warn('[shopifyUpdateWebhook] Invalid HMAC — request rejected');
        return res.status(401).send('Unauthorized');
    }

    // Parse body (raw buffer → JSON)
    let order;
    try {
        order = JSON.parse(req.body.toString('utf8'));
    } catch (err) {
        console.error('[shopifyUpdateWebhook] Failed to parse body:', err.message);
        return res.status(400).send('Bad Request');
    }

    // Respond immediately — process async
    res.status(200).send('OK');

    (async () => {
        const topic = req.headers['x-shopify-topic'];
        if (topic && topic !== 'orders/updated') {
            console.log(`[shopifyUpdateWebhook] Ignoring event with topic: ${topic}`);
            return;
        }

        const tag = `[shopifyUpdateWebhook][order:${order.order_number}]`;

        // Look up existing mapping in DB
        const mapping = store.getMappingByShopifyId(order.id);
        if (!mapping) {
            // No mapping = order hasn't been created in SooCool yet.
            // Don't attempt to create here — the orders/create webhook handles that.
            // Creating here causes duplicates due to race conditions.
            console.log(`${tag} No existing SooCool mapping — skipping (create webhook will handle it)`);
            return;
        }

        // Parse new delivery window from note_attributes
        let newDeliveryWindow;
        try {
            newDeliveryWindow = parseDeliveryWindow(order.note_attributes, order.shipping_lines);
        } catch (err) {
            console.warn(`${tag} Could not parse delivery window from updated order: ${err.message}`);
            return;
        }

        // Extract full datetime string for comparison to detect time-only changes! 
        const newDate = newDeliveryWindow.startTime;
        const oldDate = mapping.delivery_date;

        if (oldDate && oldDate === newDate) {
            console.log(`${tag} Delivery date/time unchanged (${oldDate}) — no update needed`);
            return;
        }

        console.log(`${tag} Delivery time or date changed: ${oldDate || '(none)'} → ${newDate}`);

        // Rebuild the full payload based on flow type
        let payload;
        const flow = mapping.flow;

        if (flow === 'meal') {
            // Fetch product tags to rebuild box groups
            const productIds = order.line_items.map(i => i.product_id);
            const tagsMap = await shopify.getProductTags(productIds);
            const boxGroups = groupItemsIntoBoxes(order.line_items, tagsMap);
            payload = buildMealPayload(order, newDeliveryWindow, boxGroups);
        } else {
            payload = buildPizzaPayload(order, newDeliveryWindow);
        }

        console.log(`${tag} Sending update to SooCool (order ${mapping.soocool_order_id})...`);

        await soocool.updateOrder(mapping.soocool_order_id, payload);
        console.log(`${tag} ✅ SooCool order ${mapping.soocool_order_id} updated successfully`);

        // Regenerate PDF with updated delivery date + fresh shipping label
        if (flow === 'meal') {
            let labelBuffer = null;
            try {
                labelBuffer = await soocool.getShippingLabel(mapping.soocool_order_id);
                console.log(`${tag} Fresh shipping label fetched (${labelBuffer.length} bytes)`);
            } catch (err) {
                console.warn(`${tag} Could not fetch updated shipping label: ${err.message}`);
            }

            const productIds = order.line_items.map(i => i.product_id);
            const tagsMap = await shopify.getProductTags(productIds);
            const boxGroups = groupItemsIntoBoxes(order.line_items, tagsMap);

            const pdfPath = await generateOrderPdf({ order, deliveryWindow: newDeliveryWindow, labelBuffer, boxGroups });
            console.log(`${tag} PDF regenerated: ${pdfPath}`);

            store.updatePdfPath(order.id, pdfPath);

            // Save PDF data to DB so it survives server restarts
            const fs = require('fs');
            try {
                const pdfBuffer = fs.readFileSync(pdfPath);
                store.savePdfData(order.id, pdfBuffer, labelBuffer);
                console.log(`${tag} PDF data saved to DB`);
            } catch (err) {
                console.warn(`${tag} Could not save PDF data to DB: ${err.message}`);
            }
        }

        // Persist the new delivery date
        store.updateDeliveryDate(order.id, newDate);
        console.log(`${tag} Stored new delivery date: ${newDate}`);
    })().catch((err) => {
        console.error(`[shopifyUpdateWebhook][order:${order.order_number}] Update error:`, err.message);
        if (err.response?.data) {
            console.error(`[shopifyUpdateWebhook] SooCool response:`, JSON.stringify(err.response.data));
        }
    });
});

module.exports = router;
