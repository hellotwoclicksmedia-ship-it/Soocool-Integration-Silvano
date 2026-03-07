'use strict';
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const store = require('../db/store');
const soocool = require('../soocool/client');

const router = express.Router();

/**
 * POST /webhooks/shopify/orders/cancel
 * Triggered by Shopify "orders/cancelled" webhook.
 *
 * Looks up the SooCool order in the DB and cancels it if still possible.
 * SooCool only allows cancellation while the order is in:
 *   accepted | planned | allocated
 * Once in_transit or delivered, it's too late.
 */
router.post('/orders/cancel', (req, res) => {
    // Verify HMAC
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const digest = crypto
        .createHmac('sha256', config.shopify.webhookSecret)
        .update(req.body)
        .digest('base64');

    if (digest !== hmac) {
        console.warn('[shopifyCancelWebhook] Invalid HMAC — request rejected');
        return res.status(401).send('Unauthorized');
    }

    // Parse body
    let order;
    try {
        order = JSON.parse(req.body.toString('utf8'));
    } catch (err) {
        console.error('[shopifyCancelWebhook] Failed to parse body:', err.message);
        return res.status(400).send('Bad Request');
    }

    // Respond immediately — process async
    res.status(200).send('OK');

    const tag = `[shopifyCancelWebhook][order:${order.order_number}]`;
    console.log(`${tag} Received cancellation for Shopify order #${order.order_number}`);

    // Look up SooCool order from DB
    const mapping = store.getMappingByShopifyId(order.id);
    if (!mapping) {
        console.warn(`${tag} No SooCool mapping found — order may not have been processed yet`);
        return;
    }

    const soocoolOrderId = mapping.soocool_order_id;
    console.log(`${tag} Found SooCool order ${soocoolOrderId} — attempting cancellation`);

    soocool.cancelOrder(soocoolOrderId)
        .then(({ cancelled, reason }) => {
            if (cancelled) {
                console.log(`${tag} ✅ SooCool order ${soocoolOrderId} cancelled successfully`);
            } else {
                console.warn(`${tag} ⚠️ Could not cancel SooCool order ${soocoolOrderId}: ${reason}`);
                console.warn(`${tag} Manual action may be required — contact SooCool support`);
            }
        })
        .catch((err) => {
            console.error(`${tag} ❌ Error cancelling SooCool order ${soocoolOrderId}:`, err.message);
        });
});

module.exports = router;
