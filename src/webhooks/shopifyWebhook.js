'use strict';
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { detectFlow } = require('../utils/flowDetector');
const { runPizzaFlow } = require('../flows/pizzaFlow');
const { runMealFlow } = require('../flows/mealFlow');

const router = express.Router();

const ALLOWED_COUNTRIES = new Set(['NL', 'BE']);

/**
 * POST /webhooks/shopify/orders
 * Receives Shopify orders/create webhook.
 */
router.post('/orders', (req, res) => {
    // Verify HMAC
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const digest = crypto
        .createHmac('sha256', config.shopify.webhookSecret)
        .update(req.body)
        .digest('base64');

    if (digest !== hmac) {
        console.warn('[shopifyWebhook] Invalid HMAC — request rejected');
        return res.status(401).send('Unauthorized');
    }

    // Parse body (raw buffer → JSON)
    let order;
    try {
        order = JSON.parse(req.body.toString('utf8'));
    } catch (err) {
        console.error('[shopifyWebhook] Failed to parse body:', err.message);
        return res.status(400).send('Bad Request');
    }

    // Respond immediately — process async
    res.status(200).send('OK');

    const tag = `[shopifyWebhook][order:${order.order_number}]`;

    // Validate country
    const country = order.shipping_address?.country_code;
    if (!ALLOWED_COUNTRIES.has(country)) {
        console.warn(`${tag} Shipping country "${country}" not supported (NL/BE only) — skipping`);
        return;
    }

    // Detect flow
    const flow = detectFlow(order.line_items);
    if (flow === 'unknown') {
        console.warn(`${tag} Could not detect flow — skipping`);
        return;
    }

    console.log(`${tag} Flow detected: ${flow}`);

    // Run flow asynchronously
    const runner = flow === 'pizza' ? runPizzaFlow : runMealFlow;
    runner(order).catch((err) => {
        console.error(`${tag} Flow error:`, err.message);
    });
});

module.exports = router;
