'use strict';
const express = require('express');
const store = require('../db/store');
const shopify = require('../shopify/client');
const { getMappingByOrderNumber } = store;

const router = express.Router();

/**
 * POST /webhooks/soocool/updates
 * Receives SooCool task_state updates.
 */
router.post('/updates', async (req, res) => {
    res.status(200).send('OK');

    const body = req.body;
    const tag = `[soocoolWebhook][soocoolOrder:${body?.orderId}]`;
    console.log(`${tag} Received update:`, JSON.stringify(body));

    const soocoolOrderId = body?.orderId;
    const taskState = body?.taskState;
    const orderReference = body?.orderReference; // e.g. "SHOPIFY-1234"

    if (!soocoolOrderId && !orderReference) {
        console.warn(`${tag} No orderId or orderReference in payload — ignoring`);
        return;
    }

    // Look up Shopify order from DB
    let mapping = null;
    if (soocoolOrderId) {
        mapping = store.getMappingBySoocoolId(soocoolOrderId);
    }
    if (!mapping && orderReference) {
        // Extract order number from "SHOPIFY-1234" and look up by order number
        const num = orderReference.replace('SHOPIFY-', '');
        mapping = store.getMappingByOrderNumber(num);
    }

    if (!mapping) {
        console.warn(`${tag} No DB mapping found for soocoolOrderId=${soocoolOrderId}`);
        return;
    }

    const shopifyOrderId = mapping.shopify_order_id;

    const trackingUrl = body?.trackAndTraceLink || '';
    if (trackingUrl) {
        store.updateTrackingUrl(shopifyOrderId, trackingUrl);
        console.log(`${tag} Saved tracking URL: ${trackingUrl}`);
    }

    if (taskState === 'delivered') {
        const trackingNumber = body?.trackingNumber || '';
        console.log(`${tag} Order delivered — creating Shopify fulfillment`);
        await shopify.fulfillOrder(shopifyOrderId, trackingUrl, trackingNumber).catch((err) => {
            console.error(`${tag} fulfillOrder error:`, err.message);
        });
    } else if (taskState === 'planned') {
        const window = body?.timeWindow;
        const note = `SooCool delivery planned: ${window?.startTime || '?'} – ${window?.endTime || '?'}`;
        console.log(`${tag} Order planned — adding Shopify note`);
        await shopify.addOrderNote(shopifyOrderId, note).catch((err) => {
            console.error(`${tag} addOrderNote error:`, err.message);
        });
    } else {
        console.log(`${tag} Unhandled taskState: "${taskState}" — no action taken`);
    }
});

module.exports = router;
